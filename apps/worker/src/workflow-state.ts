import { failExecutionPublication } from "./execution-publication.ts";
import { failJob } from "@dcc/domain";

type QueryResult = { rows: any[]; rowCount?: number | null };
type Client = { query: (sql: string, values?: unknown[]) => Promise<QueryResult> };
type Transaction = <T>(callback: (client: Client) => Promise<T>) => Promise<T>;

type Job = {
  id: string;
  type: string;
  status: string;
  payload_json: Record<string, unknown>;
};

export async function terminalizePrReview(client: Client, reviewId: string, errorCode: string, message: string) {
  return client.query(
    `UPDATE pr_ai_reviews SET status='error',error_code=$2,error_message=$3,completed_at=now()
     WHERE id=$1 AND status='running'`,
    [reviewId, errorCode, message],
  );
}

async function transitionTicket(
  client: Client,
  job: Job,
  status: string,
  reason: string,
  runId?: string,
) {
  const ticketId = job.payload_json.ticket_id;
  if (typeof ticketId !== "string") return;
  const current = (await client.query("SELECT status FROM tickets WHERE id=$1 FOR UPDATE", [ticketId])).rows[0];
  if (!current || current.status === status
    || ["Cancelled", "Rejected", "Merged", "Completed", "Closed Without Merge", "Archived"].includes(current.status)) return;
  await client.query("UPDATE tickets SET status=$2,updated_at=now() WHERE id=$1", [ticketId, status]);
  await client.query(
    `INSERT INTO ticket_status_history
       (ticket_id,previous_status,new_status,reason,actor_type,related_job_id,related_run_id)
     VALUES ($1,$2,$3,$4,'worker',$5,$6)`,
    [ticketId, current.status, status, reason, job.id, runId ?? null],
  );
}

async function reconcileJob(client: Client, job: Job, errorCode: string, message: string) {
  // Ticket cancellation locks the ticket before related runs/attempts. Match
  // that order so failure recovery cannot deadlock with, or overwrite, an
  // administrator cancellation racing this transaction.
  if (typeof job.payload_json.ticket_id === "string") {
    const ticket = (await client.query(
      "SELECT status FROM tickets WHERE id=$1 FOR UPDATE",
      [job.payload_json.ticket_id],
    )).rows[0];
    if (ticket?.status === "Cancelled" && job.status === "queued") {
      const cancelled = await client.query(
        `UPDATE jobs SET status='cancelled',completed_at=now(),available_at=NULL,
           claimed_at=NULL,claimed_by=NULL,lease_expires_at=NULL,updated_at=now()
         WHERE id=$1 AND status='queued'`,
        [job.id],
      );
      if (cancelled.rowCount) job.status = "cancelled";
    }
  }
  if (errorCode === "worker_lease_expired" && ["execution.run", "execution.repair", "pull-request.retry"].includes(job.type)) {
    const attemptId = job.payload_json.execution_attempt_id;
    if (typeof attemptId === "string") {
      const publication = await failExecutionPublication(client, {
        attemptId,
        jobId: job.id,
        errorMessage: message,
        reason: "Worker lease expired during pull-request publication",
        preserveRetryable: job.status === "queued",
      });
      if (publication === "published") {
        await client.query(
          "UPDATE jobs SET status='completed',completed_at=now(),error_json=NULL,updated_at=now() WHERE id=$1",
          [job.id],
        );
        job.status = "completed";
      }
      if (publication === "published" || publication === "failed") return;
    }
  }
  const run = (await client.query(
    `UPDATE agent_runs
     SET status=CASE WHEN status='cancellation_requested' OR $4='cancelled' THEN 'cancelled' ELSE 'failed' END,
         finished_at=now(),exit_code=COALESCE(exit_code,1),error_code=$2,error_message=$3
     WHERE metadata_json->>'job_id'=$1 AND status IN ('running','cancellation_requested')
     RETURNING id,status`,
    [job.id, errorCode, message, job.status],
  )).rows[0];
  const terminal = job.status !== "queued";

  if (job.type === "planning.generate" || job.type === "planning.revise") {
    await transitionTicket(
      client,
      job,
      terminal ? "Planning Failed" : job.type === "planning.revise" ? "Plan Revision Queued" : "Planning Queued",
      message,
      run?.id,
    );
    return;
  }
  if (["execution.run", "execution.repair", "pull-request.retry"].includes(job.type)) {
    const attemptId = job.payload_json.execution_attempt_id;
    if (typeof attemptId === "string") {
      await client.query(
        `UPDATE execution_attempts
         SET validation_status=$2,completed_at=CASE WHEN $2 IN ('failed','cancelled') THEN now() ELSE NULL END
         WHERE id=$1 AND validation_status <> 'cancelled'`,
        [attemptId, job.status === "cancelled" ? "cancelled" : terminal ? "failed" : "queued"],
      );
    }
    await transitionTicket(client, job, job.status === "cancelled" ? "Cancelled" : terminal ? "Execution Failed" : "Execution Queued", message, run?.id);
    return;
  }
  if (job.type === "pr.ai_review" && terminal) {
    const reviewId = job.payload_json.pr_ai_review_id;
    if (typeof reviewId === "string") {
      await terminalizePrReview(client, reviewId, errorCode, message);
    }
    return;
  }
  if (job.type === "pr.conflict_resolution" && terminal) {
    const resolutionId = job.payload_json.pr_conflict_resolution_id;
    if (typeof resolutionId === "string") {
      await client.query(
        `UPDATE pr_conflict_resolutions SET status='error',error_message=$2,completed_at=now()
         WHERE id=$1 AND status='running'`,
        [resolutionId, message],
      );
    }
  }
}

export async function recoverExpiredWorkflowState(inTransaction: Transaction) {
  return inTransaction(async (client) => {
    const jobs = (await client.query(
      `WITH candidates AS MATERIALIZED (
         SELECT j.id,j.payload_json->>'ticket_id' ticket_id
         FROM jobs j
         WHERE j.status='running' AND j.lease_expires_at <= now()
         ORDER BY j.lease_expires_at
         LIMIT 100
       ),
       locked_tickets AS MATERIALIZED (
         SELECT c.id job_id,t.id ticket_id
         FROM candidates c JOIN tickets t ON t.id::text=c.ticket_id
         ORDER BY t.id
         FOR UPDATE OF t
       ),
       expired AS (
         SELECT j.id,EXISTS (
           SELECT 1 FROM agent_runs ar
           WHERE ar.metadata_json->>'job_id'=j.id::text AND ar.status='cancellation_requested'
         ) cancellation_requested
         FROM candidates c JOIN jobs j ON j.id=c.id
         LEFT JOIN locked_tickets lt ON lt.job_id=j.id
         WHERE j.status='running' AND j.lease_expires_at <= now()
           AND (c.ticket_id IS NULL OR lt.ticket_id IS NOT NULL OR NOT EXISTS (
             SELECT 1 FROM tickets missing WHERE missing.id::text=c.ticket_id
           ))
         FOR UPDATE OF j SKIP LOCKED
       )
       UPDATE jobs j
       SET status=CASE WHEN expired.cancellation_requested THEN 'cancelled' WHEN j.attempt < j.max_attempts THEN 'queued' ELSE 'failed' END,
           available_at=CASE WHEN NOT expired.cancellation_requested AND j.attempt < j.max_attempts THEN now() ELSE j.available_at END,
           completed_at=CASE WHEN NOT expired.cancellation_requested AND j.attempt < j.max_attempts THEN NULL ELSE now() END,
           claimed_at=NULL,claimed_by=NULL,lease_expires_at=NULL,recovery_reason='lease_expired',
           error_json=jsonb_build_object('message','Worker lease expired'),updated_at=now()
       FROM expired WHERE j.id=expired.id
       RETURNING j.id,j.type,j.status,j.payload_json`,
    )).rows as Job[];

    for (const job of jobs) {
      await reconcileJob(client, job, "worker_lease_expired", "Worker lease expired");
      await client.query(
        `INSERT INTO audit_events
           (actor_type,action,entity_type,entity_id,after_json,metadata_json)
         VALUES ('worker','workflow.job.recovered','job',$1,$2,$3)`,
        [job.id, { status: job.status, recovery_reason: "lease_expired" }, { reason: "lease_expired" }],
      );
    }

    // Always run delivery recovery with its own budget — gating it on the jobs
    // page having spare room starved stuck deliveries whenever ≥100 jobs
    // expired in one pass.
    const deliveries = (await client.query(
      `WITH expired AS (
         SELECT id FROM notification_deliveries
         WHERE status='sending' AND lease_expires_at <= now()
         ORDER BY lease_expires_at
         FOR UPDATE SKIP LOCKED
         LIMIT $1
       )
       UPDATE notification_deliveries nd
       SET status='failed',attempt_count=COALESCE(attempt_count,0)+1,next_attempt_at=now(),
           claimed_by=NULL,lease_expires_at=NULL,recovery_reason='lease_expired',
           error_message='Worker lease expired',updated_at=now()
       FROM expired WHERE nd.id=expired.id
       RETURNING nd.id,nd.status`,
      [50],
    )).rows;

    for (const delivery of deliveries) {
      await client.query(
        `INSERT INTO audit_events
           (actor_type,action,entity_type,entity_id,after_json,metadata_json)
         VALUES ('worker','workflow.notification_delivery.recovered','notification_delivery',$1,$2,$3)`,
        [delivery.id, { status: delivery.status, recovery_reason: "lease_expired" }, { reason: "lease_expired" }],
      );
    }
    return { jobs: jobs.length, deliveries: deliveries.length };
  });
}

export async function refuseClaudeJobs(
  inTransaction: Transaction,
  jobTypes: string[],
  code: string,
  message: string,
) {
  return inTransaction(async (client) => {
    const jobs = (await client.query(
      `UPDATE jobs
       SET status=$1,completed_at=now(),error_json=jsonb_build_object('message',$2::text),updated_at=now()
       WHERE status='queued' AND type=ANY($3::text[])
       RETURNING id,type,status,payload_json`,
      [code, message, jobTypes],
    )).rows as Job[];
    for (const job of jobs) await reconcileJob(client, job, code, message);
    return jobs.length;
  });
}

export async function blockClaimedClaudeJob(
  inTransaction: Transaction,
  lease: LeaseGuard,
  job: Job,
  workerId: string,
  code: string,
  message: string,
) {
  return inTransaction(async (client) => {
    await lease.assertOwned();
    const blocked = (await client.query(
      `UPDATE jobs
       SET status=$3,completed_at=now(),claimed_by=NULL,lease_expires_at=NULL,
           error_json=jsonb_build_object('message',$4::text),updated_at=now()
       WHERE id=$1 AND status='running' AND claimed_by=$2 AND lease_expires_at > now()
       RETURNING id,type,status,payload_json`,
      [job.id, workerId, code, message],
    )).rows[0] as Job | undefined;
    if (!blocked) throw new LeaseLostError();
    await reconcileJob(client, blocked, code, message);
  });
}

export async function failClaimedWorkflowJob(
  inTransaction: Transaction,
  lease: LeaseGuard,
  job: Job,
  workerId: string,
  error: unknown,
) {
  const message = error instanceof Error ? error.message : "job failed";
  return inTransaction(async (client) => {
    await lease.assertOwned();
    const ticketId = job.payload_json.ticket_id;
    const ticket = typeof ticketId === "string"
      ? (await client.query("SELECT status FROM tickets WHERE id=$1 FOR UPDATE", [ticketId])).rows[0]
      : undefined;
    if (ticket?.status === "Cancelled") {
      const cancelled = (await client.query(
        `UPDATE jobs
         SET status='cancelled',completed_at=now(),claimed_by=NULL,lease_expires_at=NULL,
             error_json=jsonb_build_object('message',$3::text),updated_at=now()
         WHERE id=$1 AND status='running' AND claimed_by=$2 AND lease_expires_at > now()
         RETURNING id,type,status,payload_json`,
        [job.id, workerId, message],
      )).rows[0] as Job | undefined;
      if (!cancelled) return false;
      await reconcileJob(client, cancelled, "execution_cancelled", "execution was cancelled");
      return true;
    }
    if (!(await failJob(job.id, workerId, error, client as any))) return false;
    const failed = (await client.query(
      "SELECT id,type,status,payload_json FROM jobs WHERE id=$1",
      [job.id],
    )).rows[0] as Job | undefined;
    if (!failed) return false;
    await reconcileJob(client, failed, "job_failed", message);
    return true;
  });
}

export class LeaseLostError extends Error {
  constructor() {
    super("workflow lease ownership lost");
  }
}

export type LeaseGuard = {
  signal: AbortSignal;
  assertOwned: () => Promise<void>;
  run: <T>(action: () => Promise<T> | T) => Promise<T>;
};

export async function initializePlanningAttempt<T>(
  inTransaction: Transaction,
  lease: LeaseGuard,
  initialize: (client: Client) => Promise<T>,
): Promise<T> {
  return inTransaction(async (client) => {
    await lease.assertOwned();
    return initialize(client);
  });
}

function executionCancellation(code: "execution_cancelled_before_start" | "execution_cancelled") {
  return Object.assign(new Error(code === "execution_cancelled_before_start"
    ? "execution was cancelled before the agent started" : "execution was cancelled"), { code });
}

export async function initializeExecutionAttempt<T>(
  inTransaction: Transaction,
  lease: LeaseGuard,
  input: { ticketId: string; attemptId: string },
  initialize: (client: Client, ticket: any, attempt: any) => Promise<T>,
) {
  return inTransaction(async (client) => {
    await lease.assertOwned();
    const ticket = (await client.query("SELECT status FROM tickets WHERE id=$1 FOR UPDATE", [input.ticketId])).rows[0];
    const attempt = (await client.query(
      "SELECT * FROM execution_attempts WHERE id=$1 AND ticket_id=$2 FOR UPDATE",
      [input.attemptId, input.ticketId],
    )).rows[0];
    if (!ticket || !attempt) throw new Error("execution attempt is no longer available");
    if (ticket.status === "Cancelled" || attempt.validation_status === "cancelled") {
      throw executionCancellation("execution_cancelled_before_start");
    }
    if (attempt.validation_status !== "queued") throw new Error("execution attempt is no longer queued");
    const competing = (await client.query(
      `SELECT 1 FROM execution_attempts
       WHERE ticket_id=$1 AND id<>$2 AND validation_status IN ('queued','executing','pending') LIMIT 1 FOR UPDATE`,
      [input.ticketId, input.attemptId],
    )).rowCount;
    if (competing) throw new Error("another execution is already active");
    return initialize(client, ticket, attempt);
  });
}

export async function finalizeExecutionInvocation<T>(
  inTransaction: Transaction,
  lease: LeaseGuard,
  input: { ticketId: string; runId: string },
  finalize: (client: Client, ticket: any, run: any) => Promise<T>,
) {
  return inTransaction(async (client) => {
    await lease.assertOwned();
    const ticket = (await client.query("SELECT status FROM tickets WHERE id=$1 FOR UPDATE", [input.ticketId])).rows[0];
    const run = (await client.query("SELECT status FROM agent_runs WHERE id=$1 FOR UPDATE", [input.runId])).rows[0];
    if (!ticket || !run) throw new Error("execution run is no longer available");
    if (ticket.status === "Cancelled" || run.status === "cancellation_requested") {
      throw executionCancellation("execution_cancelled");
    }
    if (run.status !== "running") throw new Error("execution run is no longer active");
    return finalize(client, ticket, run);
  });
}

export function observeRunCancellation(
  client: Client,
  runId: string,
  onError: (error: unknown) => void,
  intervalMs = 250,
) {
  const controller = new AbortController();
  let polling = Promise.resolve();
  let lastHeartbeat = 0;
  const poll = () => {
    polling = polling.then(async () => {
      const heartbeat = Date.now() - lastHeartbeat >= 15_000;
      const row = (await client.query(
        heartbeat
          ? "UPDATE agent_runs SET heartbeat_at=now() WHERE id=$1 RETURNING status"
          : "SELECT status FROM agent_runs WHERE id=$1",
        [runId],
      )).rows[0];
      if (heartbeat) lastHeartbeat = Date.now();
      if (row?.status === "cancellation_requested") controller.abort();
    }).catch(onError);
    return polling;
  };
  const timer = setInterval(() => { void poll(); }, intervalMs);
  void poll();
  return {
    signal: controller.signal,
    abort: () => controller.abort(),
    stop: async () => { clearInterval(timer); await polling; },
  };
}

export async function finalizeCancellableRun<T>(
  inTransaction: Transaction,
  lease: LeaseGuard,
  runId: string,
  finalize: (client: Client, run: any) => Promise<T>,
) {
  return inTransaction(async (client) => {
    await lease.assertOwned();
    const run = (await client.query("SELECT status FROM agent_runs WHERE id=$1 FOR UPDATE", [runId])).rows[0];
    if (!run) throw new Error("agent run is no longer available");
    if (run.status === "cancellation_requested") throw executionCancellation("execution_cancelled");
    if (run.status !== "running") throw new Error("agent run is no longer active");
    return finalize(client, run);
  });
}

export async function finalizePlanningSuccess<T>(
  inTransaction: Transaction,
  lease: LeaseGuard,
  input: { jobId: string; workerId: string },
  finalize: (client: Client) => Promise<T>,
): Promise<T> {
  return inTransaction(async (client) => {
    const value = await finalize(client);
    const completed = await lease.run(() => client.query(
      `UPDATE jobs SET status='completed',completed_at=now(),claimed_by=NULL,lease_expires_at=NULL,updated_at=now()
       WHERE id=$1 AND status='running' AND claimed_by=$2 AND lease_expires_at > now()
       RETURNING id`,
      [input.jobId, input.workerId],
    ));
    if (completed.rowCount !== 1) throw new LeaseLostError();
    return value;
  });
}

export async function finalizePlanningFailure<T>(
  inTransaction: Transaction,
  lease: LeaseGuard,
  input: { jobId: string; workerId: string; message: string },
  finalize: (client: Client) => Promise<T>,
): Promise<T> {
  return inTransaction(async (client) => {
    const value = await finalize(client);
    const failed = await lease.run(() => client.query(
      `UPDATE jobs SET status='failed',completed_at=now(),claimed_by=NULL,lease_expires_at=NULL,
       error_json=jsonb_build_object('message',$3::text),updated_at=now()
       WHERE id=$1 AND status='running' AND claimed_by=$2 AND lease_expires_at > now()
       RETURNING id`,
      [input.jobId, input.workerId, input.message],
    ));
    if (failed.rowCount !== 1) throw new LeaseLostError();
    return value;
  });
}

export function isPlanningCancellation(input: {
  cancelledBeforeStart: boolean; invocationCancelled: boolean; cancellationAborted: boolean; stopping: boolean;
}) {
  return input.cancelledBeforeStart || (input.invocationCancelled && input.cancellationAborted && !input.stopping);
}

export function isWorkflowCancellation(
  code: unknown,
  state: { stopping: boolean; leaseAborted: boolean },
) {
  if (code === "execution_cancelled_before_start" || code === "ticket_cancelled_before_planning") return true;
  return (code === "execution_cancelled" || code === "planning_cancelled")
    && !state.stopping && !state.leaseAborted;
}

export async function finalizePlanningCancellation(
  pool: Client,
  inTransaction: Transaction,
  input: { runId: string; ticketId: string; jobId: string; exitCode: number; errorCode: string; message: string },
) {
  await pool.query(
    `UPDATE agent_runs SET status='cancelled',finished_at=now(),exit_code=$2,error_code=$3,error_message=$4 WHERE id=$1`,
    [input.runId, input.exitCode, input.errorCode, input.message],
  );
  await inTransaction(async (client) => {
    const current = (await client.query("SELECT status FROM tickets WHERE id=$1 FOR UPDATE", [input.ticketId])).rows[0];
    await client.query("UPDATE tickets SET status='Cancelled',updated_at=now() WHERE id=$1", [input.ticketId]);
    await client.query(
      `INSERT INTO ticket_status_history
       (ticket_id,previous_status,new_status,reason,actor_type,related_job_id,related_run_id)
       VALUES ($1,$2,'Cancelled',$3,'worker',$4,$5)`,
      [input.ticketId, current.status, "Planning cancelled", input.jobId, input.runId],
    );
  });
}

export async function withLeaseHeartbeat<T>(
  renew: () => Promise<boolean>,
  work: (lease: LeaseGuard) => Promise<T>,
): Promise<T> {
  let owned = true;
  let renewal = Promise.resolve();
  const controller = new AbortController();
  const check = () => {
    renewal = renewal.then(async () => {
      if (!owned) return;
      owned = await renew();
      if (!owned) controller.abort();
    }).catch(() => {
      owned = false;
      controller.abort();
    });
    return renewal.then(() => owned);
  };
  const assertOwned = async () => {
    if (!(await check())) throw new LeaseLostError();
  };
  const lease: LeaseGuard = {
    signal: controller.signal,
    assertOwned,
    async run(action) {
      await assertOwned();
      return action();
    },
  };
  const timer = setInterval(() => { void check(); }, 20_000);
  try {
    return await work(lease);
  } finally {
    clearInterval(timer);
    await renewal;
  }
}

export async function withContainedLeaseHeartbeat(
  renew: () => Promise<boolean>,
  work: (lease: LeaseGuard) => Promise<unknown>,
): Promise<void> {
  try {
    await withLeaseHeartbeat(renew, work);
  } catch (error) {
    if (!(error instanceof LeaseLostError)) throw error;
  }
}

export async function runLeaseFencedBatch(
  lease: LeaseGuard,
  actions: Array<() => Promise<unknown>>,
): Promise<void> {
  for (const action of actions) await lease.run(action);
}
