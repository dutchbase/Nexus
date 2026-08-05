import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("run heartbeat/phase", () => {
  it("throttles the cancellation poll into a periodic heartbeat + phase update", async () => {
    const worker = await readFile(new URL("./worker.ts", import.meta.url), "utf8");
    const execution = worker.slice(worker.indexOf("async function runExecution"), worker.indexOf("async function publishExecutionAttempt"));

    expect(worker).toContain("RUN_HEARTBEAT_INTERVAL_MS");
    expect(execution).toContain("let lastPhase: string | null = null;");
    expect(execution).toContain("UPDATE agent_runs SET heartbeat_at=now()");
    expect(execution).toContain("phase=COALESCE($2,phase)");
    expect(execution).toContain("RETURNING status");
    // The cancellation-check logic must still run against the returned status,
    // regardless of which branch (heartbeat UPDATE vs plain SELECT) produced it.
    expect(execution.indexOf("cancellationPoll = setInterval")).toBeLessThan(execution.indexOf("cancellation_requested"));

    // onEvent records the latest event type as the run's phase.
    const onEventIndex = execution.indexOf("onEvent: async");
    expect(onEventIndex).toBeGreaterThan(-1);
    const onEventSlice = execution.slice(onEventIndex, execution.indexOf("},", onEventIndex));
    expect(onEventSlice).toContain("lastPhase = eventType");
  });
});
