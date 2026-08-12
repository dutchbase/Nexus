import { describe, expect, it } from "vitest";
import {
  createExecutionOutcomeTracker,
  describeExecutionDenials,
  executionOutcomeVerdict,
  DENIAL_MARKER,
} from "./execution-outcome.ts";

const resultEvent = (overrides: Record<string, unknown> = {}) => ({
  type: "result", subtype: "success", is_error: false, num_turns: 7, ...overrides,
});
const denial = (id: string) => ({
  type: "user",
  message: { content: [{ type: "tool_result", tool_use_id: id, is_error: true, content: `${DENIAL_MARKER}: Bash is sandboxed.` }] },
});
const bashUse = (id: string) => ({
  type: "assistant",
  message: { content: [{ type: "tool_use", id, name: "Bash", input: { command: "npm test" } }] },
});

describe("executionOutcomeVerdict", () => {
  it("passes a clean success result", () => {
    const tracker = createExecutionOutcomeTracker();
    tracker.observe(resultEvent());
    expect(executionOutcomeVerdict(tracker.snapshot())).toBeNull();
  });
  it("fails error_max_turns with the turn count in the message", () => {
    const tracker = createExecutionOutcomeTracker();
    tracker.observe(resultEvent({ subtype: "error_max_turns", is_error: true, num_turns: 50 }));
    const verdict = executionOutcomeVerdict(tracker.snapshot());
    expect(verdict?.code).toBe("execution_max_turns");
    expect(verdict?.message).toContain("50");
  });
  it("fails is_error results even when subtype says success", () => {
    const tracker = createExecutionOutcomeTracker();
    tracker.observe(resultEvent({ is_error: true }));
    expect(executionOutcomeVerdict(tracker.snapshot())?.code).toBe("execution_incomplete");
  });
  it("fails when no result event was ever seen", () => {
    const tracker = createExecutionOutcomeTracker();
    expect(executionOutcomeVerdict(tracker.snapshot())?.code).toBe("execution_incomplete");
  });
  it("passes a result without subtype (back-compat with fake CLIs)", () => {
    const tracker = createExecutionOutcomeTracker();
    tracker.observe({ type: "result" });
    expect(executionOutcomeVerdict(tracker.snapshot())).toBeNull();
  });
});

describe("denial tracking", () => {
  it("counts consecutive denials and attributes them by tool", () => {
    const tracker = createExecutionOutcomeTracker();
    for (const id of ["t1", "t2", "t3"]) {
      tracker.observe(bashUse(id));
      tracker.observe(denial(id));
    }
    const outcome = tracker.snapshot();
    expect(outcome.deniedToolCalls).toBe(3);
    expect(outcome.maxConsecutiveDeniedToolCalls).toBe(3);
    expect(outcome.denialsByTool).toEqual({ Bash: 3 });
  });
  it("resets the consecutive counter on a successful tool result", () => {
    const tracker = createExecutionOutcomeTracker();
    tracker.observe(bashUse("t1")); tracker.observe(denial("t1"));
    tracker.observe({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", is_error: false, content: "ok" }] } });
    tracker.observe(bashUse("t3")); tracker.observe(denial("t3"));
    expect(tracker.snapshot().maxConsecutiveDeniedToolCalls).toBe(1);
  });
  it("observe() returns the running consecutive count", () => {
    const tracker = createExecutionOutcomeTracker();
    tracker.observe(bashUse("t1"));
    expect(tracker.observe(denial("t1")).consecutiveDenials).toBe(1);
  });
  it("folds result.permission_denials into reportedDenials and denialsByTool", () => {
    const tracker = createExecutionOutcomeTracker();
    tracker.observe(resultEvent({ permission_denials: [{ tool_name: "Bash" }, { tool_name: "Bash" }] }));
    const outcome = tracker.snapshot();
    expect(outcome.reportedDenials).toBe(2);
    expect(outcome.denialsByTool.Bash).toBe(2);
  });
  it("describes denials for operator-facing messages", () => {
    const tracker = createExecutionOutcomeTracker();
    tracker.observe(bashUse("t1")); tracker.observe(denial("t1"));
    expect(describeExecutionDenials(tracker.snapshot())).toContain("Bash");
  });
});
