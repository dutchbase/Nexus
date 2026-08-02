import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createPullRequestReviewWorktree } from "../../../packages/git-runner/src/index.ts";
import type { SnapshottedSkill } from "@dcc/skill-registry";
import {
  approvedPhaseSkills, assertExecutionPublicationGate, executionRoot, prReviewSnapshotInput, reviewedMergeBinding,
} from "./worker-boundary.ts";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

function skill(slug: string, phases: SnapshottedSkill["phases"]): SnapshottedSkill {
  return {
    skill_id: `${slug}-id`, slug, version: "v4.1.0", filesystem_path: `skills/${slug}/SKILL.md`,
    resolution_sources: ["phase_required"], phase: phases?.[0] ?? "planning", phases,
    plugin_name: "superpowers", invocation_name: `superpowers:${slug}`, configuration_json: { phases },
    files: [{ path: "SKILL.md", content_base64: "", content_hash: "hash" }], content_hash: "hash",
  };
}

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

  test("never schedules an unsafe automated merge", () => {
    expect(reviewedMergeBinding("review_and_merge", "approved", "head-sha", "main", "base-sha")).toBeNull();
    expect(reviewedMergeBinding("review_only", "approved", "head-sha", "main", "base-sha")).toBeNull();
    expect(reviewedMergeBinding("review_and_merge", "rejected", "head-sha", "main", "base-sha")).toBeNull();

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
