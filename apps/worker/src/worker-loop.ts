type TimerService = { stop: () => Promise<void> };

function startNonOverlappingTimer(run: () => Promise<void>, intervalMs: number, onError: (error: unknown) => void): TimerService {
  let active: Promise<void> | null = null;
  let stopped = false;
  const tick = () => {
    if (stopped || active) return;
    active = run().catch(onError).finally(() => { active = null; });
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await active;
    },
  };
}

export function startWorkerServices(input: {
  heartbeat: () => Promise<void>;
  maintenance: () => Promise<void>;
  heartbeatIntervalMs: number;
  maintenanceIntervalMs?: number;
  onError?: (error: unknown) => void;
}) {
  const onError = input.onError ?? (() => undefined);
  const services = [
    startNonOverlappingTimer(input.heartbeat, input.heartbeatIntervalMs, onError),
    startNonOverlappingTimer(input.maintenance, input.maintenanceIntervalMs ?? 250, onError),
  ];
  return { stop: async () => { await Promise.all(services.map((service) => service.stop())); } };
}

export async function runWorkerTick<T>(input: {
  claim: () => Promise<T | null>;
  handle: (job: T) => Promise<void>;
  idle: () => Promise<void>;
}) {
  const job = await input.claim();
  if (!job) {
    await input.idle();
    return false;
  }
  await input.handle(job);
  return true;
}
