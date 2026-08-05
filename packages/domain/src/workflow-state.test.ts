import { beforeEach, expect, test, vi } from "vitest";

const database = vi.hoisted(() => ({
  pool: { query: vi.fn() },
  inTransaction: vi.fn(),
}));

vi.mock("@dcc/database", () => database);

import { claimJob, completeJob, enqueueJob, failJob } from "./index.ts";
import * as notificationModule from "./notifications.ts";

type DeliveryPrimitives = {
  claimNotificationDelivery: (workerId: string) => Promise<unknown>;
  renewNotificationDeliveryLease: (id: string, workerId: string) => Promise<boolean>;
  completeNotificationDelivery: (id: string, workerId: string, responseStatus?: number) => Promise<boolean>;
  failNotificationDelivery: (id: string, workerId: string, error: unknown, responseStatus?: number) => Promise<boolean>;
};

const notifications = notificationModule as typeof notificationModule & DeliveryPrimitives;
type QueryClient = { query: ReturnType<typeof vi.fn> };

beforeEach(() => vi.clearAllMocks());

test("suppresses an active duplicate and persists a linked terminal rerun", async () => {
  database.pool.query
    .mockResolvedValueOnce({ rows: [{ id: "active-job", status: "queued" }] })
    .mockResolvedValueOnce({ rowCount: 1, rows: [] })
    .mockResolvedValueOnce({ rows: [{ id: "rerun-job", rerun_of: "terminal-job" }] });

  await expect(enqueueJob({ type: "workflow", payload: {}, idempotencyKey: "active-key" }))
    .resolves.toMatchObject({ id: "active-job" });
  await expect(enqueueJob({ type: "workflow", payload: {}, idempotencyKey: "rerun-key", rerunOf: "terminal-job" }))
    .resolves.toMatchObject({ id: "rerun-job" });

  expect(database.pool.query.mock.calls[2]).toEqual([
    expect.stringContaining("rerun_of"),
    expect.arrayContaining(["terminal-job"]),
  ]);
});

test("rejects a rerun whose source is not terminal", async () => {
  database.pool.query.mockResolvedValue({ rowCount: 0, rows: [] });

  await expect(enqueueJob({ type: "workflow", payload: {}, idempotencyKey: "rerun-key", rerunOf: "active-job" }))
    .rejects.toThrow("rerun source must be terminal");
});

test("claims jobs with a 60-second lease", async () => {
  const client = { query: vi.fn().mockResolvedValue({ rows: [{ id: "job-id" }] }) };
  database.inTransaction.mockImplementation(async (fn: (client: QueryClient) => unknown) => fn(client));

  await expect(claimJob("worker-a", ["workflow"])).resolves.toMatchObject({ id: "job-id" });

  expect(client.query).toHaveBeenCalledWith(
    expect.stringContaining("lease_expires_at = now() + interval '60 seconds'"),
    ["worker-a", ["workflow"]],
  );
});

test("renews only a live job lease", async () => {
  database.pool.query.mockResolvedValue({ rowCount: 1, rows: [] });

  await expect((await import("./index.ts") as typeof import("./index.ts") & {
    renewJobLease: (id: string, workerId: string) => Promise<boolean>;
  }).renewJobLease("job-id", "worker-a")).resolves.toBe(true);

  expect(database.pool.query).toHaveBeenCalledWith(
    expect.stringContaining("lease_expires_at > now()"),
    ["job-id", "worker-a"],
  );
});

test("rejects job completion from a different or expired owner", async () => {
  database.pool.query.mockResolvedValue({ rowCount: 0, rows: [] });

  await expect(completeJob("job-id", "worker-b")).resolves.toBe(false);
  expect(database.pool.query).toHaveBeenCalledWith(
    expect.stringContaining("lease_expires_at > now()"),
    ["job-id", "worker-b"],
  );
});

test("rejects job failure from a different or expired owner", async () => {
  database.pool.query.mockResolvedValue({ rowCount: 0, rows: [] });

  await expect(failJob("job-id", "worker-b", new Error("failed"))).resolves.toBe(false);
  expect(database.pool.query).toHaveBeenCalledWith(
    expect.stringContaining("lease_expires_at > now()"),
    ["job-id", "worker-b", "failed"],
  );
});

test("claims notification deliveries with a 60-second lease", async () => {
  const client = { query: vi.fn().mockResolvedValue({ rows: [{ id: "delivery-id" }] }) };
  database.inTransaction.mockImplementation(async (fn: (client: QueryClient) => unknown) => fn(client));

  await expect(notifications.claimNotificationDelivery("worker-a")).resolves.toMatchObject({ id: "delivery-id" });

  expect(client.query).toHaveBeenCalledWith(
    expect.stringContaining("ELSE now() + interval '60 seconds'"),
    ["worker-a"],
  );
});

test("renews only a live notification delivery lease", async () => {
  database.pool.query.mockResolvedValue({ rowCount: 1, rows: [] });

  await expect(notifications.renewNotificationDeliveryLease("delivery-id", "worker-a")).resolves.toBe(true);
  expect(database.pool.query).toHaveBeenCalledWith(
    expect.stringContaining("lease_expires_at > now()"),
    ["delivery-id", "worker-a"],
  );
});

test("rejects notification delivery completion and failure from a different or expired owner", async () => {
  database.pool.query.mockResolvedValue({ rowCount: 0, rows: [] });

  await expect(notifications.completeNotificationDelivery("delivery-id", "worker-b")).resolves.toBe(false);
  await expect(notifications.failNotificationDelivery("delivery-id", "worker-b", new Error("failed"))).resolves.toBe(false);
  expect(database.pool.query.mock.calls.map(([sql]) => sql)).toEqual([
    expect.stringContaining("lease_expires_at > now()"),
    expect.stringContaining("lease_expires_at > now()"),
  ]);
});
