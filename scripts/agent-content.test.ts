import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildAgentContentCatalog } from "./sync-agent-content.ts";

const root = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("curated agent content", () => {
  it("pins the allowed Superpowers skills by phase", () => {
    const manifest = JSON.parse(read("config/agent-content.json"));
    expect(manifest.superpowers).toMatchObject({
      repository: "obra/superpowers",
      source: { type: "git", license: "MIT" },
      review_rubric: "skills/requesting-code-review/code-reviewer.md",
    });
    expect(manifest.superpowers.tag).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(manifest.superpowers.skills).toEqual({
      planning: ["writing-plans"],
      execution: ["subagent-driven-development", "test-driven-development", "verification-before-completion"],
      repair: ["systematic-debugging", "test-driven-development", "verification-before-completion"],
      inspiration_only: ["using-superpowers", "brainstorming"],
    });
  });

  it("ships every global prompt source with the required agent guidance", () => {
    const types = [
      "base", "planning", "plan-revision", "execution", "execution-repair", "validation", "pull-request", "pr-review", "pr-conflict-resolution", "follow-up-ticket",
    ];
    expect(readdirSync(resolve(root, "prompts/global")).sort()).toEqual([...types.map((type) => `${type}.md`), "code-reviewer.md"].sort());
    expect(read("prompts/global/planning.md")).toContain("writing-plans");
    expect(read("prompts/global/planning.md")).toContain("## Task");
    expect(read("prompts/global/execution.md")).toContain("subagent-driven-development");
    expect(read("prompts/global/execution.md")).toContain("Ponytail");
    expect(read("prompts/global/execution.md")).toContain("test-driven-development");
    expect(read("prompts/global/execution-repair.md")).toContain("systematic-debugging");
    const rubric = read("prompts/global/code-reviewer.md");
    expect(rubric).toContain("You are reviewing code changes for production readiness.");
    expect(createHash("sha256").update(rubric).digest("hex")).toBe("7f5328dca12cb200005ae9d4386f63a9b0acb735ece57f82db206b4a3189ccae");
  });

  it("catalog-hashes the pinned PR-review rubric as a versioned global prompt source", async () => {
    const manifest = JSON.parse(read("config/agent-content.json"));
    const catalog = await buildAgentContentCatalog({ root, manifest, skills: [] });
    const rubric = read("prompts/global/code-reviewer.md");

    expect(catalog.prompt_sources["code-reviewer"]).toBe(rubric);
    expect(catalog.prompt_hashes["code-reviewer"]).toBe(createHash("sha256").update(rubric).digest("hex"));
  });

  it("keeps PR review read-only and injection-resistant", () => {
    const prompt = read("prompts/global/pr-review.md");
    expect(prompt).toContain("{{superpowers.code-reviewer}}");
    expect(prompt).toContain("Read, Glob, and Grep");
    expect(prompt).toContain("JSON-escaped");
    expect(prompt).toContain("```json");
    expect(prompt).toContain('"verdict"');
  });
});
