import { beforeEach, expect, test, vi } from "vitest";

// Mocking style reused verbatim from packages/domain/src/workflow-state.test.ts
// (the enqueueJob/claimJob primitives) and apps/worker/src/workflow-state.test.ts
// (the recovery transaction dispatcher).
const database = vi.hoisted(() => ({
  pool: { query: vi.fn() },
  inTransaction: vi.fn(),
}));

vi.mock("@dcc/database", () => database);

import { claimJob, enqueueJob } from "@dcc/domain";
import { recoverExpiredWorkflowState } from "./workflow-state.ts";

beforeEach(() => vi.clearAllMocks());

test("carries a job from route enqueue through worker claim to a terminal recovery state", async () => {
  const job = {
    id: "job-1",
    type: "execution.repair",
    status: "queued",
    attempt: 0,
    max_attempts: 1,
    payload_json: { ticket_id: "ticket-1", execution_attempt_id: "attempt-1" },
  };
  let ticketStatus = "Executing";
  const history: string[] = [];

  // (a) the web route enqueues a job via pool.query, same as apps/web/src/server.ts's enqueueJob() calls.
  database.pool.query.mockImplementation(async (sql: string) => {
    if (sql.includes("INSERT INTO jobs")) return { rows: [{ ...job }], rowCount: 1 };
    throw new Error(`unexpected pool query: ${sql}`);
  });

  // (b)+(c) the worker claims the job and later recovers it after its lease expires, both inside
  // a transaction — matching the transactionClient() dispatcher in apps/worker/src/workflow-state.test.ts.
  database.inTransaction.mockImplementation(async (callback: (client: any) => unknown) => {
    const client = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        if (sql.includes("UPDATE jobs j") && sql.includes("lease_expires_at <= now()")) {
          // recoverExpiredWorkflowState: attempt (1) has reached max_attempts (1), so recovery
          // is terminal rather than a requeue.
          job.status = job.attempt < job.max_attempts ? "queued" : "failed";
          return {
            rows: [{ id: job.id, type: job.type, status: job.status, payload_json: job.payload_json }],
            rowCount: 1,
          };
        }
        if (sql.includes("UPDATE jobs j")) {
          // claimJob
          job.status = "running";
          job.attempt += 1;
          return { rows: [{ ...job }], rowCount: 1 };
        }
        if (sql.includes("UPDATE notification_deliveries nd")) return { rows: [], rowCount: 0 };
        if (sql.includes("FROM execution_publications ep")) return { rows: [], rowCount: 0 };
        if (sql.includes("UPDATE agent_runs")) return { rows: [{ id: "run-1" }], rowCount: 1 };
        if (sql.includes("UPDATE execution_attempts")) return { rows: [], rowCount: 1 };
        if (sql.includes("SELECT status FROM tickets")) return { rows: [{ status: ticketStatus }], rowCount: 1 };
        if (sql.includes("UPDATE tickets SET status=$2")) {
          ticketStatus = values?.[1] as string;
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes("INSERT INTO ticket_status_history")) {
          history.push(ticketStatus);
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes("INSERT INTO audit_events")) return { rows: [], rowCount: 1 };
        throw new Error(`unexpected transaction query: ${sql}`);
      }),
    };
    return callback(client);
  });

  const enqueued = await enqueueJob({
    type: "execution.repair",
    payload: job.payload_json,
    idempotencyKey: "journey-key",
    maxAttempts: 1,
  });
  expect(enqueued).toMatchObject({ id: "job-1", status: "queued" });

  const claimed = await claimJob("worker-1", ["execution.repair"]);
  expect(claimed).toMatchObject({ id: "job-1", status: "running", attempt: 1 });

  await expect(recoverExpiredWorkflowState(database.inTransaction)).resolves.toEqual({ jobs: 1, deliveries: 0 });

  expect(job.status).toBe("failed");
  expect(ticketStatus).toBe("Execution Failed");
  expect(history).toEqual(["Execution Failed"]);
});
