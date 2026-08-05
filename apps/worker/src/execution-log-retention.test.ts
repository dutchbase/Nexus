import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

// PRD G10-F04: a repair must never hide a prior execution attempt's log — it
// must never overwrite or delete the artifacts row a previous attempt wrote.
// Each attempt (including repairs) inserts its own execution_log artifact row
// keyed by its own execution_attempt_id; runExecution never runs an UPDATE or
// DELETE against artifacts. This is a text-structure check on worker.ts,
// following the same pattern as execution-log-artifact-lifecycle.test.ts.
describe("execution log retention", () => {
  it("only ever inserts execution_log artifacts, never updates or deletes them", async () => {
    const worker = await readFile(new URL("./worker.ts", import.meta.url), "utf8");
    const execution = worker.slice(worker.indexOf("async function runExecution"), worker.indexOf("async function publishExecutionAttempt"));

    expect(execution).toContain("INSERT INTO artifacts");
    expect(execution).toContain("'execution_log','staged'");
    expect(execution).not.toMatch(/UPDATE artifacts/);
    expect(execution).not.toMatch(/DELETE FROM artifacts/);
  });
});
