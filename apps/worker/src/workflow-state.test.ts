import { afterEach, expect, test, vi } from "vitest";

import {
  LeaseLostError,
  recoverExpiredWorkflowState,
  refuseClaudeJobs,
  withLeaseHeartbeat,
} from "./workflow-state.ts";

type Result = { rows: any[]; rowCount?: number };
type Transaction = Parameters<typeof recoverExpiredWorkflowState>[0];

function transactionClient(recoveredJobs: any[], recoveredDeliveries: any[] = []) {
  let recoveryPass = 0;
  const query = vi.fn(async (sql: string, values?: unknown[]): Promise<Result> => {
    if (sql.includes("UPDATE jobs j") && sql.includes("lease_expires_at <= now()")) {
      recoveryPass += 1;
      return { rows: recoveryPass === 1 ? recoveredJobs : [], rowCount: recoveryPass === 1 ? recoveredJobs.length : 0 };
    }
    if (sql.includes("UPDATE notification_deliveries nd") && sql.includes("lease_expires_at <= now()")) {
      return { rows: recoveryPass === 1 ? recoveredDeliveries : [], rowCount: recoveryPass === 1 ? recoveredDeliveries.length : 0 };
    }
    if (sql.includes("UPDATE agent_runs")) return { rows: [], rowCount: 0 };
    if (sql.includes("SELECT status FROM tickets")) return { rows: [{ status: "Executing" }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  });
  return { query };
}

test("recovers each expired job and delivery once in a bounded locked transaction", async () => {
  const client = transactionClient(
    [{ id: "job-1", type: "execution.run", status: "queued", payload_json: { ticket_id: "ticket-1", execution_attempt_id: "attempt-1" } }],
    [{ id: "delivery-1", status: "failed" }],
  );
  const transaction = vi.fn(async (callback: (client: any) => unknown) => callback(client));
  const inTransaction = transaction as unknown as Transaction;

  await expect(recoverExpiredWorkflowState(inTransaction)).resolves.toEqual({ jobs: 1, deliveries: 1 });
  await expect(recoverExpiredWorkflowState(inTransaction)).resolves.toEqual({ jobs: 0, deliveries: 0 });

  const recoverySql = client.query.mock.calls
    .map(([sql]) => sql as string)
    .filter((sql) => sql.includes("lease_expires_at <= now()"));
  expect(recoverySql).toHaveLength(4);
  expect(recoverySql.every((sql) => sql.includes("FOR UPDATE SKIP LOCKED") && sql.includes("LIMIT"))).toBe(true);
  expect(client.query.mock.calls.filter(([sql]) => (sql as string).includes("INSERT INTO audit_events"))).toHaveLength(2);
  expect(transaction).toHaveBeenCalledTimes(2);
});

test("shares the 100-row recovery budget across jobs and deliveries", async () => {
  const jobs = Array.from({ length: 37 }, (_, index) => ({
    id: `job-${index}`, type: "project.validate", status: "queued", payload_json: {},
  }));
  const query = vi.fn(async (sql: string): Promise<Result> => {
    if (sql.includes("UPDATE jobs j")) return { rows: jobs, rowCount: jobs.length };
    if (sql.includes("UPDATE notification_deliveries nd")) return { rows: [{ id: "delivery", status: "failed" }], rowCount: 1 };
    if (sql.includes("UPDATE agent_runs")) return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 1 };
  });
  const client = { query };
  const inTransaction = (async (callback: (client: any) => unknown) => callback(client)) as Transaction;

  await expect(recoverExpiredWorkflowState(inTransaction)).resolves.toEqual({ jobs: 37, deliveries: 1 });

  expect(query).toHaveBeenCalledWith(expect.stringContaining("UPDATE notification_deliveries nd"), [63]);
});

test("fails an exhausted recovered job and reconciles its run, attempt, ticket, and history", async () => {
  const client = transactionClient([{
    id: "job-1", type: "execution.repair", status: "failed",
    payload_json: { ticket_id: "ticket-1", execution_attempt_id: "attempt-1" },
  }]);
  client.query.mockImplementation(async (sql: string, values?: unknown[]): Promise<Result> => {
    if (sql.includes("UPDATE jobs j") && sql.includes("lease_expires_at <= now()")) {
      return { rows: [{
        id: "job-1", type: "execution.repair", status: "failed",
        payload_json: { ticket_id: "ticket-1", execution_attempt_id: "attempt-1" },
      }], rowCount: 1 };
    }
    if (sql.includes("UPDATE notification_deliveries nd")) return { rows: [], rowCount: 0 };
    if (sql.includes("UPDATE agent_runs")) return { rows: [{ id: "run-1" }], rowCount: 1 };
    if (sql.includes("SELECT status FROM tickets")) return { rows: [{ status: "Executing" }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  });
  const inTransaction = (async (callback: (client: any) => unknown) => callback(client)) as Transaction;

  await recoverExpiredWorkflowState(inTransaction);

  expect(client.query).toHaveBeenCalledWith(expect.stringContaining(
    "CASE WHEN j.attempt < j.max_attempts THEN 'queued' ELSE 'failed' END",
  ));
  expect(client.query).toHaveBeenCalledWith(expect.stringContaining("error_code=$2"), ["job-1", "worker_lease_expired", "Worker lease expired"]);
  expect(client.query).toHaveBeenCalledWith(expect.stringContaining("UPDATE execution_attempts"), ["attempt-1", "failed"]);
  expect(client.query).toHaveBeenCalledWith(expect.stringContaining("UPDATE tickets SET status=$2"), ["ticket-1", "Execution Failed"]);
  expect(client.query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO ticket_status_history"), [
    "ticket-1", "Executing", "Execution Failed", "Worker lease expired", "job-1", "run-1",
  ]);
});

test("authentication refusal applies the terminal state matrix without duplicate ticket history", async () => {
  const jobs = [
    { id: "planning", type: "planning.generate", payload_json: { ticket_id: "ticket-planning" } },
    { id: "execution", type: "execution.run", payload_json: { ticket_id: "ticket-execution", execution_attempt_id: "attempt" } },
    { id: "review", type: "pr.ai_review", payload_json: { pr_ai_review_id: "review-row" } },
    { id: "conflict", type: "pr.conflict_resolution", payload_json: { pr_conflict_resolution_id: "conflict-row" } },
  ];
  const query = vi.fn(async (sql: string, values?: unknown[]): Promise<Result> => {
    if (sql.includes("UPDATE jobs") && sql.includes("status='queued'")) return { rows: jobs, rowCount: jobs.length };
    if (sql.includes("UPDATE agent_runs")) return { rows: [], rowCount: 0 };
    if (sql.includes("SELECT status FROM tickets")) {
      const ticket = values?.[0];
      return { rows: [{ status: ticket === "ticket-planning" ? "Planning Failed" : "Executing" }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  });
  const client = { query };
  const inTransaction = (async (callback: (client: any) => unknown) => callback(client)) as Transaction;

  await expect(refuseClaudeJobs(inTransaction, jobs.map((job) => job.type), "blocked_auth", "Authentication unavailable"))
    .resolves.toBe(4);

  expect(query).toHaveBeenCalledWith(expect.stringContaining("WHERE status='queued'"), [
    "blocked_auth", "Authentication unavailable", jobs.map((job) => job.type),
  ]);
  expect(query).toHaveBeenCalledWith(expect.stringContaining("UPDATE execution_attempts"), ["attempt", "failed"]);
  expect(query).toHaveBeenCalledWith(expect.stringContaining("UPDATE pr_ai_reviews"), ["review-row", "Authentication unavailable"]);
  expect(query).toHaveBeenCalledWith(expect.stringContaining("UPDATE pr_conflict_resolutions"), ["conflict-row", "Authentication unavailable"]);
  expect(query.mock.calls.filter(([sql]) => (sql as string).includes("INSERT INTO ticket_status_history"))).toHaveLength(1);
});

test("renews every 20 seconds, reports lost ownership, and always clears its timer", async () => {
  vi.useFakeTimers();
  const renew = vi.fn().mockResolvedValue(false);
  let finish!: () => void;
  const workDone = new Promise<void>((resolve) => { finish = resolve; });

  const running = withLeaseHeartbeat(renew, async (lease) => {
    await workDone;
    await lease.assertOwned();
  });
  await vi.advanceTimersByTimeAsync(20_000);
  finish();

  await expect(running).rejects.toBeInstanceOf(LeaseLostError);
  expect(renew).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

test("fences irreversible actions with a fresh lease check and aborts after ownership loss", async () => {
  const renew = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  const action = vi.fn();

  await withLeaseHeartbeat(renew, async (lease) => {
    await lease.run(action);
    await expect(lease.run(action)).rejects.toBeInstanceOf(LeaseLostError);
    expect(lease.signal.aborted).toBe(true);
  });

  expect(action).toHaveBeenCalledTimes(1);
});

afterEach(() => vi.useRealTimers());
