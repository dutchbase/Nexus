import { createHash } from "node:crypto";
import { expect, test } from "vitest";

import { planningPromptInputs } from "./planning-inputs.ts";

const project = {
  id: "project", slug: "project", name: "Project", description: "Description", enabled: true,
  repository_path: "/repo", agent_start_path: "/repo", default_branch: "main",
  github_owner: "acme", github_repository: "project", config_version: 4,
  config_json: { ai: {} },
};

const ticket = {
  id: "ticket", project_id: project.id, title: "Unify planning inputs",
  description: "Preview and worker must agree.", category: "bug", priority: "high",
  environment: "production", expected_behavior: "Same prompt", actual_behavior: "Two prompts",
  reproduction_steps: "Compare them", custom_values_json: {},
  default_model: "sonnet", default_reasoning_level: "high",
};

const prompts: Record<string, any> = {
  base: { prompt_file_id: "pf-base", active_version_id: "pv-base", content: "Base for {{project.name}}.", version: 3 },
  planning: { prompt_file_id: "pf-plan", active_version_id: "pv-plan", content: "Plan {{ticket.title}}.", version: 7 },
};

function skill(id: string, slug: string, source: string, allowTicketOverride: boolean | null) {
  return {
    id, slug, name: slug, enabled: true, version: "1", filesystem_path: `skills/${slug}/SKILL.md`,
    content_hash: id.padEnd(64, "0"), configuration_json: {},
    source, allow_ticket_override: allowTicketOverride,
  };
}

// Candidate order mirrors the resolver SQL's `ORDER BY source_order, slug, id`.
const skillRows = [
  skill("skill-mandatory", "mandatory-skill", "global_mandatory", null),
  // Attached automatically by the project but overridable, then excluded on the ticket.
  skill("skill-optional", "optional-skill", "project_automatic", true),
  skill("skill-required", "required-skill", "project_required", false),
  { ...skill("skill-optional", "optional-skill", "ticket_excluded", true) },
  skill("skill-chosen", "chosen-skill", "ticket_selected", null),
];

const fixtureClient = {
  async query(sql: string, values: any[] = []) {
    if (sql.includes("FROM projects")) return { rows: [project] };
    if (sql.includes("FROM prompt_files")) return { rows: [prompts[values[0]]].filter(Boolean) };
    if (sql.includes("SELECT resolved.*")) return { rows: skillRows };
    throw new Error(`unexpected query: ${sql}`);
  },
};

function parityHash(input: Awaited<ReturnType<typeof planningPromptInputs>>) {
  return createHash("sha256").update(JSON.stringify({
    content: input.content,
    ai: input.ai,
    promptVersionIds: input.promptVersionIds,
    skills: input.skills.map((entry) => ({
      id: entry.id, slug: entry.slug, version: entry.version, resolution_sources: entry.resolution_sources,
    })),
  })).digest("hex");
}

test("the shared planning resolver is deterministic for the same inputs", async () => {
  const first = await planningPromptInputs(fixtureClient, ticket);
  const second = await planningPromptInputs(fixtureClient, ticket);

  expect(parityHash(first)).toBe(parityHash(second));
  expect(first.ai).toEqual({ model: "sonnet", reasoning_level: "high" });
  expect(first.promptVersionIds).toEqual({ "global.base": "pv-base", "global.planning": "pv-plan" });
});

test("skill precedence drops ticket-excluded skills and keeps required project skills", async () => {
  const resolved = await planningPromptInputs(fixtureClient, ticket);

  expect(resolved.skills.map((entry) => entry.slug)).toEqual([
    "mandatory-skill", "required-skill", "chosen-skill",
  ]);
  expect(resolved.skillUnion.map((entry) => entry.slug)).toEqual([
    "mandatory-skill", "required-skill", "chosen-skill",
  ]);
});

test("the planning prompt carries the full plan structure and rendered templates", async () => {
  const { content } = await planningPromptInputs(fixtureClient, ticket);

  expect(content).toContain("Base for Project.");
  expect(content).toContain("Plan Unify planning inputs.");
  expect(content).toContain("## 1. Summary");
  expect(content).toContain("## 17. Open Questions");
  expect(content).toContain("Each execution task must use a ### Task N: heading.");
});

test("a missing or disabled project is refused", async () => {
  const disabled = { query: async (sql: string) => (sql.includes("FROM projects") ? { rows: [{ ...project, enabled: false }] } : { rows: [] }) };
  await expect(planningPromptInputs(disabled, ticket)).rejects.toThrow(/missing or disabled/);
});
