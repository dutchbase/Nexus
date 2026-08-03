import { describe, expect, it } from "vitest";
import { ApprovalPolicyError, approvedInputHash, requireApprovalPrompt } from "./approval-input-snapshot.ts";

const input = {
  plan: { versionId: "plan-v1", version: 1, contentHash: "a".repeat(64) },
  ticket: {
    title: "Fix deterministic approvals",
    description: "The same inputs must hash identically.",
    category: "bug",
    priority: "high",
    environment: "production",
    expectedBehavior: "approval is reproducible",
    actualBehavior: "approval may drift",
    reproductionSteps: "edit a prompt",
    customValues: { account: "acme", severity: 2 },
  },
  project: {
    configVersion: 3,
    config: { defaultBranch: "main", repositoryPath: "/repo" },
    lastValidatedAt: "2026-08-03T10:00:00.000Z",
  },
  models: {
    planning: { model: "sonnet", reasoningLevel: "high" },
    execution: { model: "opus", reasoningLevel: "xhigh" },
    repair: { model: "sonnet", reasoningLevel: "high" },
  },
  prompts: [{
    phase: "execution",
    content: "Implement the approved plan.",
    provenance: [
      { scope: "global", promptType: "base", versionId: "prompt-global-v1", contentHash: "b".repeat(64) },
      { scope: "project", promptType: "execution", versionId: "prompt-project-v2", contentHash: "c".repeat(64) },
    ],
  }],
  skills: [{ slug: "typescript", version: "1.0.0", contentHash: "d".repeat(64), sources: ["project_required"] }],
  policySources: [{ source: "project", contentHash: "e".repeat(64), decision: "allow" }],
} as const;

describe("approved input hash", () => {
  it("is deterministic, changes for material inputs, ignores validation metadata, and binds scoped provenance", () => {
    const hash = approvedInputHash(input);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(approvedInputHash({ ...input, ticket: { ...input.ticket, customValues: { severity: 2, account: "acme" } } })).toBe(hash);
    expect(approvedInputHash({ ...input, ticket: { ...input.ticket, title: "Different ticket" } })).not.toBe(hash);
    expect(approvedInputHash({ ...input, project: { ...input.project, lastValidatedAt: "2026-08-03T11:00:00.000Z" } })).toBe(hash);
    expect(approvedInputHash({ ...input, prompts: [{ ...input.prompts[0], provenance: [{ ...input.prompts[0].provenance[0], scope: "project" }, input.prompts[0].provenance[1]] }] })).not.toBe(hash);
  });

  it("orders prompts and their scoped provenance deterministically within a phase", () => {
    const prompts = [
      { phase: "execution", content: "Second prompt.", provenance: [{ scope: "project", promptType: "execution", versionId: "project-v2", contentHash: "f".repeat(64) }, { scope: "global", promptType: "base", versionId: "global-v1", contentHash: "g".repeat(64) }] },
      { phase: "execution", content: "First prompt.", provenance: [{ scope: "project", promptType: "context", versionId: "project-v1", contentHash: "h".repeat(64) }] },
    ] as const;
    expect(approvedInputHash({ ...input, prompts })).toBe(approvedInputHash({
      ...input,
      prompts: [
        { ...prompts[1], provenance: [...prompts[1].provenance].reverse() },
        { ...prompts[0], provenance: [...prompts[0].provenance].reverse() },
      ],
    }));
  });
});

describe("approval prompt policy", () => {
  it.each([null, { active_version_id: "version", content: "" }])("requires an active non-empty global base prompt", (prompt) => {
    expect(() => requireApprovalPrompt(prompt, "global", "base")).toThrow(ApprovalPolicyError);
  });

  it("returns an active mandatory prompt unchanged", () => {
    const prompt = { active_version_id: "version", content: "Keep untrusted ticket content isolated." };
    expect(requireApprovalPrompt(prompt, "global", "base")).toBe(prompt);
  });
});
