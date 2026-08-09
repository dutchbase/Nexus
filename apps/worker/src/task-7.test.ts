import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createPullRequestReviewWorktree } from "../../../packages/git-runner/src/index.ts";
import type { SnapshottedSkill } from "@dcc/skill-registry";
import { assertPrReviewDestination, buildApprovedInputSnapshot, type ApprovedInputSnapshot } from "@dcc/domain";
import { GitHubProviderError } from "@dcc/github-provider";
import {
  approvedPhaseSkills, assertExecutionPublicationGate, executionRoot, prReviewSnapshotInput,
} from "./worker-boundary.ts";
import * as workerBoundary from "./worker-boundary.ts";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

function skill(slug: string, phases: SnapshottedSkill["phases"]): SnapshottedSkill {
  const bytes = Buffer.from(`# ${slug}\n`);
  const files = [{ path: "SKILL.md", content_base64: bytes.toString("base64"), content_hash: createHash("sha256").update(bytes).digest("hex") }];
  return {
    skill_id: `${slug}-id`, slug, version: "v4.1.0", filesystem_path: `skills/${slug}/SKILL.md`,
    resolution_sources: ["phase_required"], phase: phases?.[0] ?? "planning", phases,
    plugin_name: "superpowers", invocation_name: `superpowers:${slug}`, configuration_json: { phases },
    files, content_hash: createHash("sha256").update(JSON.stringify(files)).digest("hex"),
  };
}

const snapshotRow = (skills: SnapshottedSkill[]) => ({
  id: "skill-snapshot", ticket_id: "ticket-1", skills_json: skills,
  content_hash: createHash("sha256").update(JSON.stringify(skills)).digest("hex"),
});

const approvedSkill = (stored: SnapshottedSkill) => ({
  id: stored.skill_id, slug: stored.slug, version: stored.version, contentHash: stored.content_hash,
  sources: stored.resolution_sources, filesystemPath: stored.filesystem_path, phase: stored.phase,
  phases: stored.phases ?? [stored.phase], pluginName: stored.plugin_name ?? null,
  invocationName: stored.invocation_name ?? null, configuration: stored.configuration_json ?? {},
});

describe("worker orchestration boundary", () => {
  test("places execution worktrees and bundles outside the denied host home", () => {
    expect(executionRoot()).toBe(path.join(tmpdir(), "dcc-execution"));
    expect(executionRoot("/var/lib/dcc-execution")).toBe("/var/lib/dcc-execution");
    expect(() => executionRoot(path.join(process.env.HOME!, "dcc-execution"))).toThrow("outside the host home");
  });

  test("selects only the approved phase snapshot and gates publication on Agent use", () => {
    const snapshot = {
      id: "snapshot-1",
      ticket_id: "ticket-1",
      skills_json: [
        skill("writing-plans", ["planning"]),
        skill("test-driven-development", ["execution", "repair"]),
      ],
    };

    expect(approvedPhaseSkills(snapshot, "ticket-1", "execution").map((skill) => skill.slug))
      .toEqual(["test-driven-development"]);
    expect(() => approvedPhaseSkills(snapshot, "other-ticket", "execution")).toThrow("approved skill snapshot");
    expect(() => assertExecutionPublicationGate(false, false)).toThrow("did not invoke Agent");
    expect(() => assertExecutionPublicationGate(false, true)).not.toThrow();
    expect(() => assertExecutionPublicationGate(true, false)).not.toThrow();
  });

  test("builds execution inputs from approved material while keeping runtime repair data dynamic", () => {
    const approvedExecutionInput = (workerBoundary as any).approvedExecutionInput;
    expect(approvedExecutionInput).toBeTypeOf("function");
    const materialInput: ApprovedInputSnapshot = {
      plan: { versionId: "plan-v1", version: 1, contentHash: "a".repeat(64) },
      ticket: { title: "Approved title" },
      skills: [], policySources: [],
      project: { configVersion: 7, config: {
        enabled: true, slug: "approved-project", repositoryPath: "/approved/repo",
        defaultBranch: "approved-main", configuration: { execution_max_turns: 12 },
      } },
      models: { repair: { model: "approved-model", reasoningLevel: "xhigh" } },
      prompts: [{
        phase: "repair", content: "Approved immutable repair prompt.\n",
        provenance: [{ scope: "global", promptType: "execution-repair", versionId: "prompt-v1", contentHash: "e".repeat(64) }],
      }],
    };
    const preview = buildApprovedInputSnapshot(materialInput);
    const result = approvedExecutionInput({
      id: "approved-input-1",
      inputHash: preview.inputHash,
      materialInput: preview.materialInput,
    }, "repair", {
      worktreePath: "/runtime/worktree", branchName: "runtime-branch", baseCommit: "runtime-base",
      currentDiff: "+runtime diff", validationOutput: { failed: true }, administratorFeedback: "runtime feedback",
    });

    expect(result).toMatchObject({
      approvedInputSnapshotId: "approved-input-1", inputHash: preview.inputHash,
      project: { config_version: 7, repository_path: "/approved/repo", default_branch: "approved-main" },
      ai: { model: "approved-model", reasoning_level: "xhigh" },
      promptVersionIds: { "global.execution-repair": "prompt-v1" },
    });
    expect(result.content).toContain("Approved immutable repair prompt.");
    expect(result.content).toContain('"path": "."');
    expect(result.content).not.toContain("/runtime/worktree");
    expect(result.content).toContain("+runtime diff");
    expect(result.content).toContain("runtime feedback");
    expect(result.inputHash).toBe(preview.inputHash);
  });

  test("rejects a stored skill bundle that drifted from the approved input", () => {
    const assertApprovedSkillSnapshot = (workerBoundary as any).assertApprovedSkillSnapshot;
    expect(assertApprovedSkillSnapshot).toBeTypeOf("function");
    const stored = [skill("test-driven-development", ["execution", "repair"])];
    const approved = [approvedSkill(stored[0])];
    const row = snapshotRow(stored);
    expect(() => assertApprovedSkillSnapshot(approved, row)).not.toThrow();
    stored[0].files[0].content_base64 = Buffer.from("tampered bytes").toString("base64");

    expect(() => assertApprovedSkillSnapshot(approved, row)).toThrow("approved skill snapshot integrity check failed");
  });

  test("accepts an approved snapshot whose keys were reordered by a jsonb round-trip", () => {
    const assertApprovedSkillSnapshot = (workerBoundary as any).assertApprovedSkillSnapshot;
    const stored = [skill("test-driven-development", ["execution", "repair"])];
    // Postgres jsonb orders object keys by length, then bytewise — exactly
    // what checkPlanApprovalGate hands the worker after reading
    // approved_input_snapshots.material_input_json back from the database.
    const jsonbOrder = (value: any): any => {
      if (Array.isArray(value)) return value.map(jsonbOrder);
      if (value && typeof value === "object") {
        return Object.fromEntries(
          Object.keys(value)
            .sort((left, right) => left.length - right.length || (left < right ? -1 : 1))
            .map((key) => [key, jsonbOrder(value[key])]),
        );
      }
      return value;
    };
    const approved = [jsonbOrder(approvedSkill(stored[0]))];
    expect(() => assertApprovedSkillSnapshot(approved, snapshotRow(stored))).not.toThrow();
  });

  test.each([
    ["phases", (stored: SnapshottedSkill) => { stored.phases = ["planning"]; }],
    ["plugin", (stored: SnapshottedSkill) => { stored.plugin_name = "tampered-plugin"; }],
    ["invocation", (stored: SnapshottedSkill) => { stored.invocation_name = "tampered:skill"; }],
    ["configuration", (stored: SnapshottedSkill) => { stored.configuration_json = { phases: ["planning"] }; }],
    ["resolution sources", (stored: SnapshottedSkill) => { stored.resolution_sources = ["ticket_selected"]; }],
  ])("rejects tampered stored skill %s metadata", (_field, mutate) => {
    const assertApprovedSkillSnapshot = (workerBoundary as any).assertApprovedSkillSnapshot;
    expect(assertApprovedSkillSnapshot).toBeTypeOf("function");
    const stored = [skill("test-driven-development", ["execution", "repair"])];
    const approved = [approvedSkill(stored[0])];
    const row = snapshotRow(stored);
    mutate(stored[0]);

    expect(() => assertApprovedSkillSnapshot(approved, row)).toThrow("approved skill snapshot integrity check failed");
  });

  test("binds PR review prompts to immutable refs", () => {
    expect(prReviewSnapshotInput({
      projectId: "project-1", content: "exact prompt", model: "sonnet", reasoningLevel: "high",
      promptVersionIds: { "global.pr-review": "prompt-1", "global.code-reviewer": "rubric-2" },
      pullRequestId: "pr-1", reviewedHeadSha: "head-sha", reviewedBaseBranch: "main", reviewedBaseSha: "base-sha",
    })).toMatchObject({
      ticketId: null, phase: "pr-review", content: "exact prompt",
      metadata: {
        promptVersionIds: { "global.pr-review": "prompt-1", "global.code-reviewer": "rubric-2" },
        reviewedHeadSha: "head-sha", reviewedBaseBranch: "main", reviewedBaseSha: "base-sha",
      },
    });
  });

  test.each(["transient", "rate_limited"])("retries %s provider failures before output is persisted", (code) => {
    const shouldRetry = (workerBoundary as any).shouldRetryPrReview;
    expect(shouldRetry(new GitHubProviderError(code, "provider unavailable"), null, 1, 3)).toBe(true);
    expect(shouldRetry(new GitHubProviderError("not_found", "missing"), null, 1, 3)).toBe(false);
    expect(shouldRetry(new Error("model failed"), null, 1, 3)).toBe(false);
    expect(shouldRetry(new GitHubProviderError(code, "provider unavailable"), null, 3, 3)).toBe(false);
  });

  test("retries publication failures after immutable output is persisted", () => {
    const shouldRetry = (workerBoundary as any).shouldRetryPrReview;
    expect(shouldRetry(new Error("database unavailable"), "persisted output", 2, 3)).toBe(true);
  });

  test("does not retry a mismatched resume job with persisted output", () => {
    const shouldRetry = (workerBoundary as any).shouldRetryPrReview;
    let mismatch: unknown;
    try {
      assertPrReviewDestination({ id: "review-1", pull_request_id: "pr-1" }, "pr-2");
    } catch (error) {
      mismatch = error;
    }

    expect(shouldRetry(mismatch, "persisted output", 1, 3)).toBe(false);
  });

  test("cleans up the detached review worktree after the review boundary", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "worker-boundary-"));
    directories.push(root);
    const repository = path.join(root, "repository");
    const remote = path.join(root, "remote.git");
    const dataRoot = path.join(root, "data-root");
    await mkdir(repository);
    execFileSync("git", ["init", "--quiet", "--bare", remote]);
    execFileSync("git", ["init", "--quiet", "--initial-branch=review-fixture", repository]);
    execFileSync("git", ["-C", repository, "remote", "add", "origin", remote]);
    await writeFile(path.join(repository, "README.md"), "base\n");
    execFileSync("git", ["-C", repository, "add", "."]);
    execFileSync("git", ["-C", repository, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--quiet", "-m", "base"]);
    execFileSync("git", ["-C", repository, "push", "--quiet", "origin", "HEAD:review-fixture"]);
    const base = execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    await writeFile(path.join(repository, "README.md"), "base\nreview change\n");
    execFileSync("git", ["-C", repository, "add", "."]);
    execFileSync("git", ["-C", repository, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--quiet", "-m", "review change"]);
    const head = execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    execFileSync("git", ["-C", repository, "push", "--quiet", "origin", `HEAD:refs/pull/7/head`]);

    const review = await createPullRequestReviewWorktree({
      repositoryPath: repository, dataRoot, projectSlug: "project", pullRequestNumber: 7,
      baseBranch: "review-fixture", expectedBaseSha: base, expectedHeadSha: head,
    });
    expect(execFileSync("git", ["-C", review.worktreePath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim())
      .toBe(review.headCommit);
    expect(review.baseCommit).toBe(base);
    expect(review.diff).toContain("+review change");
    await review.cleanup();
    expect(() => execFileSync("git", ["-C", review.worktreePath, "status"], { stdio: "ignore" })).toThrow();
  });
});
