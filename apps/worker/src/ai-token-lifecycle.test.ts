import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";

test("records every worker AI lifecycle with invocation context and terminal usage", async () => {
  const worker = await readFile(new URL("./worker.ts", import.meta.url), "utf8");

  expect(worker).toContain("createAiInvocation");
  expect(worker).toContain("if (result.usage) await recordAiUsage({ runId, ...result.usage })");
  expect(worker).toContain("else await recordAiUnavailable(runId)");
  for (const route of ["runPlanning", "runExecution", "runPrAiReview", "runFollowUpDescription", "runPrConflictResolution"]) {
    const source = worker.slice(worker.indexOf(`async function ${route}`));
    expect(source).toContain("createAiInvocation");
    expect(source).toContain("finalizeAiUsage");
    expect(source).toContain("recordAiUnavailable");
  }
});

test("snapshots prompts for each PR invocation context", async () => {
  const worker = await readFile(new URL("./worker.ts", import.meta.url), "utf8");

  for (const route of ["runPrAiReview", "runFollowUpDescription", "runPrConflictResolution"]) {
    expect(worker.slice(worker.indexOf(`async function ${route}`))).toContain("snapshotPrompt");
  }
});
