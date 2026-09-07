import { afterEach, describe, expect, it, vi } from "vitest";
import { runWorkerTick, startWorkerServices } from "./worker-loop.ts";

afterEach(() => vi.useRealTimers());

describe("worker loop", () => {
  it("keeps heartbeat and maintenance active while a claimed job is busy without overlapping passes", async () => {
    vi.useFakeTimers();
    let finishJob!: () => void;
    let finishMaintenance!: () => void;
    const jobDone = new Promise<void>((resolve) => { finishJob = resolve; });
    const maintenanceDone = new Promise<void>((resolve) => { finishMaintenance = resolve; });
    const heartbeat = vi.fn(async () => undefined);
    const maintenance = vi.fn(async () => maintenanceDone);
    const services = startWorkerServices({ heartbeat, maintenance, heartbeatIntervalMs: 10, maintenanceIntervalMs: 10 });
    const busyTick = runWorkerTick({
      claim: async () => ({ id: "job" }),
      handle: async () => jobDone,
      idle: async () => undefined,
    });

    await vi.advanceTimersByTimeAsync(35);
    expect(heartbeat).toHaveBeenCalledTimes(4);
    expect(maintenance).toHaveBeenCalledTimes(1);

    finishMaintenance();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10);
    expect(maintenance).toHaveBeenCalledTimes(2);

    finishJob();
    await expect(busyTick).resolves.toBe(true);
    await services.stop();
  });

  it("waits once when no job is claimable", async () => {
    const idle = vi.fn(async () => undefined);
    const handle = vi.fn();
    await expect(runWorkerTick({ claim: async () => null, handle, idle })).resolves.toBe(false);
    expect(idle).toHaveBeenCalledOnce();
    expect(handle).not.toHaveBeenCalled();
  });
});
