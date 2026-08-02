import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";

const worker = () => readFile(new URL("./worker.ts", import.meta.url), "utf8");

test("uses the recorded base for repair output and a final publish scan", async () => {
  const source = await worker();

  expect(source).toContain("worktreeDiff(worktree.worktreePath, worktree.baseCommit ?? attempt.base_commit)");
  expect(source).toContain("validateEffectiveWorktree({");
  expect(source).toContain("baseCommit: input.attempt.base_commit");
});

test("runs PR review in a disposable detached worktree and cleans it up", async () => {
  const source = await worker();

  expect(source).toContain("createPullRequestReviewWorktree({");
  expect(source).toContain("workingDirectory: reviewWorktree.worktreePath");
  expect(source).toContain("await reviewWorktree.cleanup()");
});
