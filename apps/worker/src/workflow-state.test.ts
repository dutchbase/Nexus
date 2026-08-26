import { afterEach, expect, test, vi } from "vitest";

import {
  LeaseLostError,
  recoverExpiredWorkflowState,
  refuseClaudeJobs,
  withLeaseHeartbeat,
} from "./workflow-state.ts";

type Result = { rows: any[]; rowCount?: number };
type Transaction = Parameters<typeof recoverExpiredWorkflowState>[0];

test("terminalizes a mismatched durable PR review with its stable error", async () => {
  let review = { status: "running", error_code: null as string | null, error_message: null as string | null };
  const client = { query: vi.fn(async (_sql: string, values?: unknown[]) => {
    review = { status: "error", error_code: values?.[1] as string, error_message: values?.[2] as string };
    return { rows: [{ ...review }], rowCount: 1 };
  }) };
  const workflow = await import("./workflow-state.ts") as any;

  await workflow.terminalizePrReview(client, "review-1", "review_destination_mismatch", "does not match payload pull request");

  expect(review).toEqual({
    status: "error", error_code: "review_destination_mismatch", error_message: "does not match payload pull request",
  });
  expect(client.query).toHaveBeenCalledWith(expect.stringContaining("UPDATE pr_ai_reviews"), [
    "review-1", "review_destination_mismatch", "does not match payload pull request",
  ]);
});

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

test("recovers a stranded planning run once and leaves its final state idempotent", async () => {
  let recovered = false;
  let ticketStatus = "Planning";
  const history: string[] = [];
  const query = vi.fn(async (sql: string, values?: unknown[]): Promise<Result> => {
    if (sql.includes("UPDATE jobs j") && sql.includes("lease_expires_at <= now()")) {
      if (recovered) return { rows: [], rowCount: 0 };
      recovered = true;
      return { rows: [{ id: "planning", type: "planning.generate", status: "failed", payload_json: { ticket_id: "ticket-planning" } }], rowCount: 1 };
    }
    if (sql.includes("UPDATE notification_deliveries nd")) return { rows: [], rowCount: 0 };
    if (sql.includes("UPDATE agent_runs")) return { rows: [{ id: "run-planning" }], rowCount: 1 };
    if (sql.includes("SELECT status FROM tickets")) return { rows: [{ status: ticketStatus }], rowCount: 1 };
    if (sql.includes("UPDATE tickets SET status=$2")) ticketStatus = values?.[1] as string;
    if (sql.includes("INSERT INTO ticket_status_history")) history.push(ticketStatus);
    return { rows: [], rowCount: 1 };
  });
  const inTransaction = (async (callback: (client: any) => unknown) => callback({ query })) as Transaction;

  await expect(recoverExpiredWorkflowState(inTransaction)).resolves.toEqual({ jobs: 1, deliveries: 0 });
  await expect(recoverExpiredWorkflowState(inTransaction)).resolves.toEqual({ jobs: 0, deliveries: 0 });

  expect(ticketStatus).toBe("Planning Failed");
  expect(history).toEqual(["Planning Failed"]);
  expect(query.mock.calls.filter(([sql]) => (sql as string).includes("UPDATE agent_runs"))).toHaveLength(1);
});

test("recovers an expired conflict job by its recorded job identifier", async () => {
  let runStatus = "running";
  let resolutionStatus = "running";
  const query = vi.fn(async (sql: string, values?: unknown[]): Promise<Result> => {
    if (sql.includes("UPDATE jobs j") && sql.includes("lease_expires_at <= now()")) {
      return { rows: [{
        id: "job-conflict", type: "pr.conflict_resolution", status: "failed",
        payload_json: { pr_conflict_resolution_id: "resolution-1" },
      }], rowCount: 1 };
    }
    if (sql.includes("UPDATE notification_deliveries nd")) return { rows: [], rowCount: 0 };
    if (sql.includes("UPDATE agent_runs")) {
      if (values?.[0] !== "job-conflict") return { rows: [], rowCount: 0 };
      runStatus = "failed";
      return { rows: [{ id: "run-conflict" }], rowCount: 1 };
    }
    if (sql.includes("UPDATE pr_conflict_resolutions")) {
      if (values?.[0] !== "resolution-1") return { rows: [], rowCount: 0 };
      resolutionStatus = "error";
    }
    return { rows: [], rowCount: 1 };
  });
  const inTransaction = (async (callback: (client: any) => unknown) => callback({ query })) as Transaction;

  await expect(recoverExpiredWorkflowState(inTransaction)).resolves.toEqual({ jobs: 1, deliveries: 0 });

  expect(runStatus).toBe("failed");
  expect(resolutionStatus).toBe("error");
  expect(query).toHaveBeenCalledWith(expect.stringContaining("metadata_json->>'job_id'=$1"), [
    "job-conflict", "worker_lease_expired", "Worker lease expired",
  ]);
  expect(query).toHaveBeenCalledWith(expect.stringContaining("UPDATE pr_conflict_resolutions"), [
    "resolution-1", "Worker lease expired",
  ]);
});

test("always runs delivery recovery with its own budget, even when the jobs page is full", async () => {
  const jobs = Array.from({ length: 100 }, (_, index) => ({
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

  await expect(recoverExpiredWorkflowState(inTransaction)).resolves.toEqual({ jobs: 100, deliveries: 1 });

  // A full jobs page must not starve stuck deliveries: the delivery sweep
  // always gets its own LIMIT.
  expect(query).toHaveBeenCalledWith(expect.stringContaining("UPDATE notification_deliveries nd"), [50]);
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

test("records a stable terminal code when an AI review exhausts recovery", async () => {
  const query = vi.fn(async (sql: string): Promise<Result> => {
    if (sql.includes("UPDATE jobs j") && sql.includes("lease_expires_at <= now()")) return { rows: [{
      id: "job-1", type: "pr.ai_review", status: "failed", payload_json: { pr_ai_review_id: "review-1" },
    }], rowCount: 1 };
    if (sql.includes("UPDATE notification_deliveries nd")) return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 1 };
  });
  const inTransaction = (async (callback: (client: any) => unknown) => callback({ query })) as Transaction;

  await recoverExpiredWorkflowState(inTransaction);

  expect(query).toHaveBeenCalledWith(expect.stringContaining("error_code=$2"), [
    "review-1", "worker_lease_expired", "Worker lease expired",
  ]);
});

test.each(["execution.run", "execution.repair", "pull-request.retry"])("recovers a stranded %s publication as retryable once", async (type) => {
  let publicationStatus = "publishing";
  let ticketStatus = "Validating";
  const history: string[] = [];
  const publicationAudits: string[] = [];
  const query = vi.fn(async (sql: string): Promise<Result> => {
    if (sql.includes("UPDATE jobs j") && sql.includes("lease_expires_at <= now()")) return { rows: [{
      id: "job-1", type, status: "failed",
      payload_json: { ticket_id: "ticket-1", execution_attempt_id: "attempt-1" },
    }], rowCount: 1 };
    if (sql.includes("UPDATE notification_deliveries nd")) return { rows: [], rowCount: 0 };
    if (sql.includes("FROM execution_publications ep")) return { rows: [{
      id: "publication-1", status: publicationStatus, ticket_id: "ticket-1",
      agent_run_id: "run-1", plan_version_id: "plan-1",
    }], rowCount: 1 };
    if (sql.includes("UPDATE execution_publications")) {
      publicationStatus = "failed";
      return { rows: [{ id: "publication-1" }], rowCount: 1 };
    }
    if (sql.includes("SELECT status FROM tickets")) return { rows: [{ status: ticketStatus }], rowCount: 1 };
    if (sql.includes("UPDATE tickets SET status='PR Creation Failed'")) ticketStatus = "PR Creation Failed";
    if (sql.includes("INSERT INTO ticket_status_history")) history.push("PR Creation Failed");
    if (sql.includes("'execution.publication.failed'")) publicationAudits.push("failed");
    return { rows: [], rowCount: 1 };
  });
  const inTransaction = (async (callback: (client: any) => unknown) => callback({ query })) as Transaction;

  await recoverExpiredWorkflowState(inTransaction);

  expect(publicationStatus).toBe("failed");
  expect(ticketStatus).toBe("PR Creation Failed");
  expect(history).toEqual(["PR Creation Failed"]);
  expect(publicationAudits).toEqual(["failed"]);
});

test.each(
  ["execution.run", "execution.repair", "pull-request.retry"].flatMap((type) =>
    ["pending", "publishing"].map((publicationState) => [type, publicationState] as const),
  ),
)("keeps a requeued %s publication %s and reconciles its workflow state", async (type, publicationState) => {
  let publicationStatus = publicationState;
  let runStatus = "running";
  let attemptStatus = "validated";
  let ticketStatus = "Validating";
  const history: string[] = [];
  const query = vi.fn(async (sql: string): Promise<Result> => {
    if (sql.includes("UPDATE jobs j") && sql.includes("lease_expires_at <= now()")) return { rows: [{
      id: "job-1", type, status: "queued",
      payload_json: { ticket_id: "ticket-1", execution_attempt_id: "attempt-1" },
    }], rowCount: 1 };
    if (sql.includes("UPDATE notification_deliveries nd")) return { rows: [], rowCount: 0 };
    if (sql.includes("FROM execution_publications ep")) return { rows: [{
      id: "publication-1", status: publicationStatus, ticket_id: "ticket-1",
      agent_run_id: "run-1", plan_version_id: "plan-1",
    }], rowCount: 1 };
    if (sql.includes("UPDATE execution_publications")) {
      publicationStatus = "failed";
      return { rows: [{ id: "publication-1" }], rowCount: 1 };
    }
    if (sql.includes("UPDATE agent_runs")) {
      runStatus = "failed";
      return { rows: [{ id: "run-1" }], rowCount: 1 };
    }
    if (sql.includes("UPDATE execution_attempts")) attemptStatus = "queued";
    if (sql.includes("SELECT status FROM tickets")) return { rows: [{ status: ticketStatus }], rowCount: 1 };
    if (sql.includes("UPDATE tickets SET status=$2")) ticketStatus = "Execution Queued";
    if (sql.includes("INSERT INTO ticket_status_history")) history.push("Execution Queued");
    return { rows: [], rowCount: 1 };
  });
  const inTransaction = (async (callback: (client: any) => unknown) => callback({ query })) as Transaction;

  await recoverExpiredWorkflowState(inTransaction);

  expect(publicationStatus).toBe(publicationState);
  expect(runStatus).toBe("failed");
  expect(attemptStatus).toBe("queued");
  expect(ticketStatus).toBe("Execution Queued");
  expect(history).toEqual(["Execution Queued"]);
});

test.each(["execution.run", "execution.repair", "pull-request.retry"])("reopens a requeued %s failed publication and reconciles its workflow state", async (type) => {
  let publicationStatus = "failed";
  let publicationOwner: string | null = "job-0";
  let publicationError: string | null = "provider failed";
  let publicationPublishedAt: string | null = "2026-08-03T17:00:00Z";
  let runStatus = "running";
  let attemptStatus = "validated";
  let ticketStatus = "PR Creation Failed";
  const query = vi.fn(async (sql: string): Promise<Result> => {
    if (sql.includes("UPDATE jobs j") && sql.includes("lease_expires_at <= now()")) return { rows: [{
      id: "job-1", type, status: "queued",
      payload_json: { ticket_id: "ticket-1", execution_attempt_id: "attempt-1" },
    }], rowCount: 1 };
    if (sql.includes("UPDATE notification_deliveries nd")) return { rows: [], rowCount: 0 };
    if (sql.includes("FROM execution_publications ep")) return { rows: [{
      id: "publication-1", status: publicationStatus, last_job_id: publicationOwner, ticket_id: "ticket-1",
      agent_run_id: "run-1", plan_version_id: "plan-1",
    }], rowCount: 1 };
    if (sql.includes("SET status='pending',last_job_id=NULL,error_message=NULL,published_at=NULL")) {
      publicationStatus = "pending";
      publicationOwner = null;
      publicationError = null;
      publicationPublishedAt = null;
      return { rows: [{ id: "publication-1" }], rowCount: 1 };
    }
    if (sql.includes("UPDATE agent_runs")) {
      runStatus = "failed";
      return { rows: [{ id: "run-1" }], rowCount: 1 };
    }
    if (sql.includes("UPDATE execution_attempts")) attemptStatus = "queued";
    if (sql.includes("SELECT status FROM tickets")) return { rows: [{ status: ticketStatus }], rowCount: 1 };
    if (sql.includes("UPDATE tickets SET status=$2")) ticketStatus = "Execution Queued";
    return { rows: [], rowCount: 1 };
  });
  const inTransaction = (async (callback: (client: any) => unknown) => callback({ query })) as Transaction;

  await recoverExpiredWorkflowState(inTransaction);

  expect(publicationStatus).toBe("pending");
  expect(publicationOwner).toBeNull();
  expect(publicationError).toBeNull();
  expect(publicationPublishedAt).toBeNull();
  expect(runStatus).toBe("failed");
  expect(attemptStatus).toBe("queued");
  expect(ticketStatus).toBe("Execution Queued");
});

test.each(["execution.run", "execution.repair", "pull-request.retry"])("does not reopen a terminal %s failed publication", async (type) => {
  let publicationStatus = "failed";
  const query = vi.fn(async (sql: string): Promise<Result> => {
    if (sql.includes("UPDATE jobs j") && sql.includes("lease_expires_at <= now()")) return { rows: [{
      id: "job-1", type, status: "failed",
      payload_json: { ticket_id: "ticket-1", execution_attempt_id: "attempt-1" },
    }], rowCount: 1 };
    if (sql.includes("UPDATE notification_deliveries nd")) return { rows: [], rowCount: 0 };
    if (sql.includes("FROM execution_publications ep")) return { rows: [{
      id: "publication-1", status: publicationStatus, last_job_id: "job-1", ticket_id: "ticket-1",
      agent_run_id: "run-1", plan_version_id: "plan-1",
    }], rowCount: 1 };
    if (sql.includes("SET status='pending'")) publicationStatus = "pending";
    return { rows: [], rowCount: 1 };
  });
  const inTransaction = (async (callback: (client: any) => unknown) => callback({ query })) as Transaction;

  await recoverExpiredWorkflowState(inTransaction);

  expect(publicationStatus).toBe("failed");
});

test.each(
  ["execution.run", "execution.repair", "pull-request.retry"].flatMap((type) =>
    ["failed", "queued"].map((status) => [type, status] as const),
  ),
)("completes a recovered %s job with status %s when publication already succeeded for that job", async (type, status) => {
  let jobStatus = "failed";
  const query = vi.fn(async (sql: string): Promise<Result> => {
    if (sql.includes("UPDATE jobs j") && sql.includes("lease_expires_at <= now()")) return { rows: [{
      id: "job-1", type, status,
      payload_json: { ticket_id: "ticket-1", execution_attempt_id: "attempt-1" },
    }], rowCount: 1 };
    if (sql.includes("UPDATE notification_deliveries nd")) return { rows: [], rowCount: 0 };
    if (sql.includes("FROM execution_publications ep")) return { rows: [{
      id: "publication-1", status: "published", ticket_id: "ticket-1",
      last_job_id: "job-1", agent_run_id: "run-1", plan_version_id: "plan-1",
    }], rowCount: 1 };
    if (sql.includes("UPDATE jobs SET status='completed'")) jobStatus = "completed";
    return { rows: [], rowCount: 1 };
  });
  const inTransaction = (async (callback: (client: any) => unknown) => callback({ query })) as Transaction;

  await recoverExpiredWorkflowState(inTransaction);

  expect(jobStatus).toBe("completed");
  expect(query.mock.calls.some(([sql]) => (sql as string).includes("UPDATE execution_attempts"))).toBe(false);
  expect(query.mock.calls.some(([sql]) => (sql as string).includes("UPDATE agent_runs"))).toBe(false);
  expect(query.mock.calls.some(([sql]) => (sql as string).includes("UPDATE tickets"))).toBe(false);
});

test("fails a recovered repair whose publication belongs to an older job", async () => {
  let jobStatus = "failed";
  let runStatus = "running";
  let attemptStatus = "completed";
  let ticketStatus = "PR Ready for Review";
  const history: string[] = [];
  const query = vi.fn(async (sql: string): Promise<Result> => {
    if (sql.includes("UPDATE jobs j") && sql.includes("lease_expires_at <= now()")) return { rows: [{
      id: "job-2", type: "execution.repair", status: "failed",
      payload_json: { ticket_id: "ticket-1", execution_attempt_id: "attempt-1" },
    }], rowCount: 1 };
    if (sql.includes("UPDATE notification_deliveries nd")) return { rows: [], rowCount: 0 };
    if (sql.includes("FROM execution_publications ep")) return { rows: [{
      id: "publication-1", status: "published", last_job_id: "job-1", ticket_id: "ticket-1",
      agent_run_id: "run-1", plan_version_id: "plan-1",
    }], rowCount: 1 };
    if (sql.includes("UPDATE jobs SET status='completed'")) jobStatus = "completed";
    if (sql.includes("UPDATE agent_runs")) {
      runStatus = "failed";
      return { rows: [{ id: "run-2" }], rowCount: 1 };
    }
    if (sql.includes("UPDATE execution_attempts")) attemptStatus = "failed";
    if (sql.includes("SELECT status FROM tickets")) return { rows: [{ status: ticketStatus }], rowCount: 1 };
    if (sql.includes("UPDATE tickets SET status=$2")) ticketStatus = "Execution Failed";
    if (sql.includes("INSERT INTO ticket_status_history")) history.push("Execution Failed");
    return { rows: [], rowCount: 1 };
  });
  const inTransaction = (async (callback: (client: any) => unknown) => callback({ query })) as Transaction;

  await recoverExpiredWorkflowState(inTransaction);

  expect(jobStatus).toBe("failed");
  expect(runStatus).toBe("failed");
  expect(attemptStatus).toBe("failed");
  expect(ticketStatus).toBe("Execution Failed");
  expect(history).toEqual(["Execution Failed"]);
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
  expect(query).toHaveBeenCalledWith(expect.stringContaining("UPDATE pr_ai_reviews"), ["review-row", "blocked_auth", "Authentication unavailable"]);
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

test("contains lease loss raised while recording a normal handler failure", async () => {
  const workflow = await import("./workflow-state.ts") as any;
  expect(typeof workflow.withContainedLeaseHeartbeat).toBe("function");
  const renew = vi.fn().mockResolvedValue(false);

  await expect(workflow.withContainedLeaseHeartbeat(renew, async (lease: any) => {
    try {
      throw new Error("handler failed");
    } catch {
      await lease.run(async () => undefined);
    }
  })).resolves.toBeUndefined();
});

test("stops a terminal write batch when ownership is lost between writes", async () => {
  const workflow = await import("./workflow-state.ts") as any;
  expect(typeof workflow.runLeaseFencedBatch).toBe("function");
  const renew = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  const writes: string[] = [];

  await expect(withLeaseHeartbeat(renew, (lease) => workflow.runLeaseFencedBatch(lease, [
    async () => { writes.push("first"); },
    async () => { writes.push("stale-second"); },
  ]))).rejects.toBeInstanceOf(LeaseLostError);

  expect(writes).toEqual(["first"]);
});

afterEach(() => vi.useRealTimers());
