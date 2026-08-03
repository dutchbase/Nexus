import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("execution log artifact lifecycle", () => {
  it("stages and registers the log before invocation, then finalizes it", async () => {
    const worker = await readFile(new URL("./worker.ts", import.meta.url), "utf8");
    const execution = worker.slice(worker.indexOf("async function runExecution"), worker.indexOf("async function publishExecutionAttempt"));

    expect(execution.indexOf("const stagedLog = await stageArtifact")).toBeLessThan(execution.indexOf("await runPrivateExecution"));
    expect(execution).toContain("'execution_log','staged'");
    expect(execution).toContain("logPath: stagedLog.stagedPath");
    expect(execution).toContain("await finalizeRegisteredArtifact(stagedLog)");
    expect(execution).not.toContain("const logDirectory =");
  });
});
