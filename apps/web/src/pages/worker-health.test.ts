import { describe, expect, it } from "vitest";
import { workerHealth } from "./shared.ts";
import { WORKER_STALE_AFTER_MS } from "@dcc/domain";

const row = (ageMs: number) => ({ id: "w1", heartbeat_at: new Date(Date.now() - ageMs).toISOString(), capabilities: ["execution.run"], version: "1.0" });

describe("workerHealth", () => {
  it("reports healthy for a worker that only heartbeats", () => {
    expect(workerHealth(row(5_000)).tone).toBe("ok");
  });
  it("reports stale past the documented interval", () => {
    const h = workerHealth(row(WORKER_STALE_AFTER_MS + 1_000));
    expect(h.tone).toBe("warn");
    expect(h.label).toBe("stale");
  });
  it("reports no worker when the table is empty", () => {
    expect(workerHealth(undefined).label).toBe("no worker registered");
  });
  it("names the heartbeat source and capabilities in the detail", () => {
    const h = workerHealth(row(5_000));
    expect(h.detail).toContain("workers.heartbeat_at");
    expect(h.detail).toContain("1 job type");
  });
});
