import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";

const worker = () => readFile(new URL("./worker.ts", import.meta.url), "utf8");

test("uses the recorded base for repair output and a final publish scan", async () => {
  const source = await worker();

  expect(source).toContain("worktreeDiff(sourceAttempt.worktree_path, sourceAttempt.base_commit)");
  expect(source).toContain("validateEffectiveWorktree({");
  expect(source).toContain("baseCommit: input.attempt.base_commit");
});

test("runs PR review in a disposable detached worktree and cleans it up", async () => {
  const source = await worker();

  expect(source).toContain("createPullRequestReviewWorktree({");
  expect(source).toContain("workingDirectory: reviewWorktree.worktreePath");
  expect(source).toContain("await reviewWorktree.cleanup()");
});

test("gives the read-only PR review an immutable-diff-first ten-turn budget", async () => {
  const source = await worker();
  const start = source.indexOf("async function runPrAiReview");
  const invocation = source.slice(start, source.indexOf("async function runFollowUpDescription", start));

  expect(invocation).toContain("Inspect the supplied immutable diff first");
  expect(invocation).toContain('tools: ["Read", "Glob", "Grep"]');
  expect(invocation).toContain("maxTurns: 10");
});

test("publishes reviews through the resumable outbox without automatic merge", async () => {
  const source = await worker();
  const start = source.indexOf("async function runPrAiReview");
  const invocation = source.slice(start, source.indexOf("async function runFollowUpDescription", start));

  expect(invocation).toContain("resumePrReviewPublication");
  expect(invocation).not.toContain("approveAndMergePullRequest");
  expect(invocation).not.toContain("reviewedMergeBinding");
});
