import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("planning cancellation poll", () => {
  it("mirrors runExecution's cancellationPoll inside runPlanning", async () => {
    const worker = await readFile(new URL("./worker.ts", import.meta.url), "utf8");
    const planning = worker.slice(worker.indexOf("async function runPlanning"), worker.indexOf("async function runExecution"));

    expect(worker).toContain("let activePlanningCancellation: AbortController | null = null;");
    expect(worker).toContain("activeExecutionCancellation?.abort(); activePlanningCancellation?.abort();");

    expect(planning).toContain("const cancellation = new AbortController();");
    expect(planning).toContain("activePlanningCancellation = cancellation;");
    expect(planning.indexOf("cancellationPoll = setInterval")).toBeLessThan(planning.indexOf("cancellation_requested"));
    expect(planning).toContain("cancellation.abort()");

    // Both invocation branches must listen on the poll's controller, not just the lease signal.
    expect(planning).toContain("signal: AbortSignal.any([cancellation.signal, lease.signal])");
    expect(planning).toContain('cancelledErrorCode: "planning_cancelled"');

    // Cleanup must use the identity guard, matching activeExecutionCancellation's finally block.
    expect(planning).toContain("clearInterval(cancellationPoll);");
    expect(planning).toContain("if (activePlanningCancellation === cancellation) activePlanningCancellation = null;");
  });
});
