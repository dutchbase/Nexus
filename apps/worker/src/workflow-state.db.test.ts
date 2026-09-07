import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import pg from "pg";

process.env.DATABASE_URL = process.env.DCC_TEST_DATABASE_URL ?? "postgres://unused:unused@127.0.0.1:1/unused";

const testDatabaseUrl = process.env.DCC_TEST_DATABASE_URL;
const integration = testDatabaseUrl ? describe : describe.skip;
let migrationDirectory = "";

async function client() {
  const connection = new pg.Client({ connectionString: testDatabaseUrl });
  await connection.connect();
  return connection;
}

async function backendPid(connection: pg.Client) {
  return Number((await connection.query("SELECT pg_backend_pid() pid")).rows[0].pid);
}

function transaction(connection: pg.Client) {
  return async <T>(use: (client: pg.Client) => Promise<T>) => {
    await connection.query("BEGIN");
    try {
      const result = await use(connection);
      await connection.query("COMMIT");
      return result;
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    }
  };
}

async function waitForTicketLock(observer: pg.Client, pid: number) {
  const deadline = Date.now() + 2_000;
  let last: unknown;
  while (Date.now() < deadline) {
    await observer.query("SELECT pg_stat_clear_snapshot()");
    const row = (await observer.query(
      "SELECT wait_event_type,query FROM pg_stat_activity WHERE pid=$1",
      [pid],
    )).rows[0];
    last = row;
    if (row?.wait_event_type === "Lock" && String(row.query).includes("FROM tickets")) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`workflow transaction did not wait for the ticket lock: ${JSON.stringify(last)}`);
}

async function seedExecution(connection: pg.Client) {
  const projectId = randomUUID();
  const ticketId = randomUUID();
  const runId = randomUUID();
  const attemptId = randomUUID();
  const jobId = randomUUID();
  await connection.query(
    "INSERT INTO projects (id,slug,name,repository_path) VALUES ($1,$2,'Race project','/tmp/race')",
    [projectId, `race-${projectId}`],
  );
  await connection.query(
    "INSERT INTO tickets (id,ticket_number,project_id,title,status) VALUES ($1,$2,$3,'Race ticket','Executing')",
    [ticketId, `R-${ticketId}`, projectId],
  );
  const planId = (await connection.query(
    "INSERT INTO plans (ticket_id) VALUES ($1) RETURNING id",
    [ticketId],
  )).rows[0].id;
  const planVersionId = (await connection.query(
    `INSERT INTO plan_versions (plan_id,version,content_markdown,content_hash)
     VALUES ($1,1,'plan',encode(digest('plan','sha256'),'hex')) RETURNING id`,
    [planId],
  )).rows[0].id;
  await connection.query(
    `INSERT INTO agent_runs (id,ticket_id,project_id,run_type,status,started_at,metadata_json)
     VALUES ($1,$2,$3,'execution','running',now(),$4)`,
    [runId, ticketId, projectId, { job_id: jobId }],
  );
  await connection.query(
    `INSERT INTO execution_attempts (id,ticket_id,plan_version_id,agent_run_id,attempt_number,validation_status)
     VALUES ($1,$2,$3,$4,1,'queued')`,
    [attemptId, ticketId, planVersionId, runId],
  );
  await connection.query(
    `INSERT INTO jobs (id,type,status,payload_json,idempotency_key,attempt,max_attempts,claimed_by,lease_expires_at)
     VALUES ($1,'execution.run','running',$2,$3,1,2,'worker-1',now()+interval '1 minute')`,
    [jobId, { ticket_id: ticketId, execution_attempt_id: attemptId }, `race:${jobId}`],
  );
  return { ticketId, runId, attemptId, jobId };
}

const lease = {
  signal: new AbortController().signal,
  assertOwned: vi.fn(async () => undefined),
  run: async <T>(action: () => Promise<T> | T) => action(),
};

integration("workflow cancellation transaction ordering", () => {
  beforeAll(async () => {
    migrationDirectory = await mkdtemp(join(tmpdir(), "dcc-workflow-state-"));
    await cp(new URL("../../../packages/database/migrations/", import.meta.url), migrationDirectory, { recursive: true });
    const reset = await client();
    try {
      await reset.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    } finally {
      await reset.end();
    }
    const { migrate } = await import("../../../packages/database/src/migrate.ts");
    await migrate({ connectionString: testDatabaseUrl!, directory: migrationDirectory });
  });

  afterAll(async () => {
    if (migrationDirectory) await rm(migrationDirectory, { recursive: true, force: true });
  });

  test("execution initialization observes cancellation committed while it waits for the ticket", async () => {
    const setup = await client();
    const cancellation = await client();
    const worker = await client();
    try {
      const row = await seedExecution(setup);
      await cancellation.query("BEGIN");
      await cancellation.query("SELECT id FROM tickets WHERE id=$1 FOR UPDATE", [row.ticketId]);
      await cancellation.query("UPDATE tickets SET status='Cancelled' WHERE id=$1", [row.ticketId]);
      await cancellation.query("UPDATE execution_attempts SET validation_status='cancelled' WHERE id=$1", [row.attemptId]);

      const { initializeExecutionAttempt } = await import("./workflow-state.ts");
      const initialized = vi.fn();
      const workerPid = await backendPid(worker);
      const outcome = initializeExecutionAttempt(transaction(worker) as any, lease, row, initialized)
        .then(() => ({ error: undefined }), (error) => ({ error }));
      await waitForTicketLock(cancellation, workerPid);
      await cancellation.query("COMMIT");

      expect((await outcome).error).toMatchObject({ code: "execution_cancelled_before_start" });
      expect(initialized).not.toHaveBeenCalled();
    } finally {
      await cancellation.query("ROLLBACK").catch(() => undefined);
      await Promise.all([setup.end(), cancellation.end(), worker.end()]);
    }
  });

  test("execution finalization observes cancellation committed while it waits for the ticket", async () => {
    const setup = await client();
    const cancellation = await client();
    const worker = await client();
    try {
      const row = await seedExecution(setup);
      await cancellation.query("BEGIN");
      await cancellation.query("SELECT id FROM tickets WHERE id=$1 FOR UPDATE", [row.ticketId]);
      await cancellation.query("UPDATE tickets SET status='Cancelled' WHERE id=$1", [row.ticketId]);
      await cancellation.query("UPDATE agent_runs SET status='cancellation_requested' WHERE id=$1", [row.runId]);

      const { finalizeExecutionInvocation } = await import("./workflow-state.ts");
      const finalized = vi.fn();
      const workerPid = await backendPid(worker);
      const outcome = finalizeExecutionInvocation(transaction(worker) as any, lease, row, finalized)
        .then(() => ({ error: undefined }), (error) => ({ error }));
      await waitForTicketLock(cancellation, workerPid);
      await cancellation.query("COMMIT");

      expect((await outcome).error).toMatchObject({ code: "execution_cancelled" });
      expect(finalized).not.toHaveBeenCalled();
    } finally {
      await cancellation.query("ROLLBACK").catch(() => undefined);
      await Promise.all([setup.end(), cancellation.end(), worker.end()]);
    }
  });

  test("a claimed failure waits behind cancellation without inverting the ticket and job locks", async () => {
    const setup = await client();
    const cancellation = await client();
    const worker = await client();
    try {
      const row = await seedExecution(setup);
      await cancellation.query("BEGIN");
      await cancellation.query("SET LOCAL lock_timeout='500ms'");
      await cancellation.query("SELECT id FROM tickets WHERE id=$1 FOR UPDATE", [row.ticketId]);
      await cancellation.query("UPDATE tickets SET status='Cancelled' WHERE id=$1", [row.ticketId]);

      const { failClaimedWorkflowJob } = await import("./workflow-state.ts");
      const workerPid = await backendPid(worker);
      const outcome = failClaimedWorkflowJob(transaction(worker) as any, lease, {
        id: row.jobId, type: "execution.run", status: "running",
        payload_json: { ticket_id: row.ticketId, execution_attempt_id: row.attemptId },
      }, "worker-1", new Error("agent failed"))
        .then((handled) => ({ handled, error: undefined }), (error) => ({ handled: false, error }));
      await waitForTicketLock(cancellation, workerPid);

      await cancellation.query(
        `UPDATE jobs SET status='cancelled',completed_at=now(),claimed_by=NULL,lease_expires_at=NULL
         WHERE payload_json->>'ticket_id'=$1 AND status='queued'`,
        [row.ticketId],
      );
      await cancellation.query("UPDATE execution_attempts SET validation_status='cancelled' WHERE id=$1", [row.attemptId]);
      await cancellation.query("UPDATE agent_runs SET status='cancellation_requested' WHERE id=$1", [row.runId]);
      await cancellation.query("COMMIT");

      expect(await outcome).toEqual({ handled: true, error: undefined });
      expect((await setup.query("SELECT status FROM jobs WHERE id=$1", [row.jobId])).rows[0].status).toBe("cancelled");
      expect((await setup.query("SELECT status FROM agent_runs WHERE id=$1", [row.runId])).rows[0].status).toBe("cancelled");
      expect((await setup.query("SELECT validation_status FROM execution_attempts WHERE id=$1", [row.attemptId])).rows[0].validation_status).toBe("cancelled");
      expect((await setup.query("SELECT status FROM tickets WHERE id=$1", [row.ticketId])).rows[0].status).toBe("Cancelled");
    } finally {
      await cancellation.query("ROLLBACK").catch(() => undefined);
      await Promise.all([setup.end(), cancellation.end(), worker.end()]);
    }
  });

  test("expired-job recovery locks the ticket first and keeps a concurrent cancellation terminal", async () => {
    const setup = await client();
    const cancellation = await client();
    const worker = await client();
    try {
      const row = await seedExecution(setup);
      await setup.query("UPDATE jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [row.jobId]);
      await cancellation.query("BEGIN");
      await cancellation.query("SET LOCAL lock_timeout='500ms'");
      await cancellation.query("SELECT id FROM tickets WHERE id=$1 FOR UPDATE", [row.ticketId]);
      await cancellation.query("UPDATE tickets SET status='Cancelled' WHERE id=$1", [row.ticketId]);

      const { recoverExpiredWorkflowState } = await import("./workflow-state.ts");
      const workerPid = await backendPid(worker);
      const outcome = recoverExpiredWorkflowState(transaction(worker) as any)
        .then((result) => ({ result, error: undefined }), (error) => ({ result: undefined, error }));
      await waitForTicketLock(cancellation, workerPid);

      await cancellation.query(
        `UPDATE jobs SET status='cancelled',completed_at=now(),claimed_by=NULL,lease_expires_at=NULL
         WHERE payload_json->>'ticket_id'=$1 AND status='queued'`,
        [row.ticketId],
      );
      await cancellation.query("UPDATE execution_attempts SET validation_status='cancelled' WHERE id=$1", [row.attemptId]);
      await cancellation.query("UPDATE agent_runs SET status='cancellation_requested' WHERE id=$1", [row.runId]);
      await cancellation.query("COMMIT");

      expect(await outcome).toEqual({ result: { jobs: 1, deliveries: 0 }, error: undefined });
      expect((await setup.query("SELECT status FROM jobs WHERE id=$1", [row.jobId])).rows[0].status).toBe("cancelled");
      expect((await setup.query("SELECT status FROM agent_runs WHERE id=$1", [row.runId])).rows[0].status).toBe("cancelled");
      expect((await setup.query("SELECT validation_status FROM execution_attempts WHERE id=$1", [row.attemptId])).rows[0].validation_status).toBe("cancelled");
      expect((await setup.query("SELECT status FROM tickets WHERE id=$1", [row.ticketId])).rows[0].status).toBe("Cancelled");
    } finally {
      await cancellation.query("ROLLBACK").catch(() => undefined);
      await Promise.all([setup.end(), cancellation.end(), worker.end()]);
    }
  });
});
