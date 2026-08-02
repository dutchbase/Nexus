import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";

const worker = () => readFile(new URL("./worker.ts", import.meta.url), "utf8");

test("reviews the detached checkout read-only and posts the complete review", async () => {
  const source = await worker();

  expect(source).toContain("Inspect the checked-out repository with only Read, Glob, and Grep");
  expect(source).toContain('tools: ["Read", "Glob", "Grep"]');
  expect(source).toContain("createPullRequestComment(owner, repo, pullRequest.number, result.markdown)");
  expect(source).toContain("if (payload.mode === \"review_and_merge\" && verdict.verdict === \"approved\")");
  expect(source).toContain("await reviewWorktree.cleanup()");
});
