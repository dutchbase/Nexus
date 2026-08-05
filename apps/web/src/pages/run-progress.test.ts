import { describe, expect, it } from "vitest";
import { runProgress, RUN_STALE_AFTER_MS } from "./shared.ts";

describe("runProgress", () => {
  it("labels phase without inventing a percentage", () => {
    const p = runProgress({ phase: "tool_use", heartbeat_at: new Date().toISOString(), turn: null, max_turns: null });
    expect(p.label).toContain("tool_use");
    expect(p.label).not.toContain("%");
    expect(p.stale).toBe(false);
  });
  it("marks a run stale after the documented heartbeat window", () => {
    const p = runProgress({ phase: "tool_use", heartbeat_at: new Date(Date.now() - RUN_STALE_AFTER_MS - 1000).toISOString(), turn: null, max_turns: null });
    expect(p.stale).toBe(true);
  });
});
