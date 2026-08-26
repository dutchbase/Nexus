import { failExecutionPublication } from "./execution-publication.ts";

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
  if (!current || current.status === status) return;
  await client.query("UPDATE tickets SET status=$2,updated_at=now() WHERE id=$1", [ticketId, status]);
  await client.query(
    `INSERT INTO ticket_status_history
       (ticket_id,previous_status,new_status,reason,actor_type,related_job_id,related_run_id)
     VALUES ($1,$2,$3,$4,'worker',$5,$6)`,
    [ticketId, current.status, status, reason, job.id, runId ?? null],
  );
}

async function reconcileJob(client: Client, job: Job, errorCode: string, message: string) {
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
     SET status='failed',finished_at=now(),exit_code=COALESCE(exit_code,1),error_code=$2,error_message=$3
     WHERE metadata_json->>'job_id'=$1 AND status='running'
     RETURNING id`,
    [job.id, errorCode, message],
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
         SET validation_status=$2,completed_at=CASE WHEN $2='failed' THEN now() ELSE NULL END
         WHERE id=$1`,
        [attemptId, terminal ? "failed" : "queued"],
      );
    }
    await transitionTicket(client, job, terminal ? "Execution Failed" : "Execution Queued", message, run?.id);
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
      `WITH expired AS (
         SELECT id FROM jobs
         WHERE status='running' AND lease_expires_at <= now()
         ORDER BY lease_expires_at
         FOR UPDATE SKIP LOCKED
         LIMIT 100
       )
       UPDATE jobs j
       SET status=CASE WHEN j.attempt < j.max_attempts THEN 'queued' ELSE 'failed' END,
           available_at=CASE WHEN j.attempt < j.max_attempts THEN now() ELSE j.available_at END,
           completed_at=CASE WHEN j.attempt < j.max_attempts THEN NULL ELSE now() END,
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
