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

async function connection() {
  const client = new pg.Client({ connectionString: testDatabaseUrl });
  await client.connect();
  return client;
}

const evidence = (url: string, message = "captured") => ({
  sourceUrl: url, device: {}, console: [{ level: "error", message }], network: [], events: [], metadata: {},
  unavailableSections: [], truncatedSections: [],
});

integration("Jam enrichment publication", () => {
  beforeAll(async () => {
    migrationDirectory = await mkdtemp(join(tmpdir(), "dcc-jam-enrichment-"));
    await cp(new URL("../../../packages/database/migrations/", import.meta.url), migrationDirectory, { recursive: true });
    const reset = await connection();
    try { await reset.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public"); } finally { await reset.end(); }
    const { migrate } = await import("../../../packages/database/src/migrate.ts");
    await migrate({ connectionString: testDatabaseUrl!, directory: migrationDirectory });
    process.env.DCC_JAM_TOKEN = "test-token";
  });

  afterAll(async () => {
    delete process.env.DCC_JAM_TOKEN;
    const { pool } = await import("@dcc/database");
    await pool.end();
    if (migrationDirectory) await rm(migrationDirectory, { recursive: true, force: true });
  });

  async function seed(options: { state?: string; hash?: string | null; maxAttempts?: number } = {}) {
    const client = await connection();
    const projectId = randomUUID(), ticketId = randomUUID(), generation = randomUUID(), userId = randomUUID();
    await client.query("INSERT INTO users(id,username,password_hash,role) VALUES($1,$2,'hash','reporter')", [userId, `jam-${userId}`]);
    await client.query("INSERT INTO projects(id,slug,name,repository_path) VALUES($1,$2,'Jam','/tmp/jam')", [projectId, `jam-${projectId}`]);
    await client.query(
      `INSERT INTO tickets(id,ticket_number,project_id,title,status,jam_url,created_by_user_id,updated_at,submission_updated_at)
       VALUES($1,$2,$3,'Jam ticket','Submitted','https://jam.dev/c/old',$4,'2000-01-01','2000-01-01')`,
      [ticketId, `J-${ticketId}`, projectId, userId],
    );
    await client.query(
      "INSERT INTO ticket_jam_contexts(ticket_id,source_url,generation,state,content_hash,data_json) VALUES($1,'https://jam.dev/c/old',$2,$3,$4,$5)",
      [ticketId, generation, options.state ?? "queued", options.hash ?? null, options.hash ? evidence("https://jam.dev/c/old") : null],
    );
    const jobId = randomUUID();
    await client.query(
      "INSERT INTO jobs(id,type,payload_json,idempotency_key,max_attempts) VALUES($1,'ticket.jam_enrich',$2,$3,$4)",
      [jobId, { ticket_id: ticketId, generation }, `jam:${jobId}`, options.maxAttempts ?? 3],
    );
    await client.end();
    return { ticketId, generation, jobId, userId };
  }

  async function claim(row: Awaited<ReturnType<typeof seed>>, workerId = `worker-${randomUUID()}`) {
    const { claimJob } = await import("@dcc/domain");
    const job = await claimJob(workerId, ["ticket.jam_enrich"]);
    expect(job).toMatchObject({ id: row.jobId, status: "running", claimed_by: workerId });
    return { job, workerId };
  }

  async function owned<T>(jobId: string, workerId: string, action: (lease: any) => Promise<T>) {
    const { renewJobLease } = await import("@dcc/domain");
    const { withLeaseHeartbeat } = await import("./workflow-state.ts");
    return withLeaseHeartbeat(() => renewJobLease(jobId, workerId), action);
  }

  async function snapshot(ticketId: string) {
    const client = await connection();
    try {
      return (await client.query(
        `SELECT t.status,t.submission_revision,t.submission_updated_at,t.updated_at,
          (SELECT count(*)::int FROM agent_runs WHERE ticket_id=t.id) agent_runs
         FROM tickets t WHERE t.id=$1`, [ticketId],
      )).rows[0];
    } finally { await client.end(); }
  }

  async function runSuccess(row: Awaited<ReturnType<typeof seed>>, contentHash = "new-hash", message = "captured") {
    const { job, workerId } = await claim(row);
    const { completeJob } = await import("@dcc/domain");
    const { runJamEnrichment } = await import("./jam-enrichment.ts");
    await owned(job.id, workerId, async (lease) => {
      await runJamEnrichment(job, lease, async (source) => ({ state: "ready", evidence: evidence(source.url, message), contentHash }));
      expect(await completeJob(job.id, workerId)).toBe(true);
    });
  }

  test.each(["replace", "clear", "delete"])("discards an in-flight fetch after ticket %s", async (change) => {
    const row = await seed();
    const before = await snapshot(row.ticketId);
    const { job, workerId } = await claim(row);
    let resolve!: (value: any) => void;
    const pending = new Promise((done) => { resolve = done; });
    const { runJamEnrichment } = await import("./jam-enrichment.ts");
    const running = owned(job.id, workerId, (lease) => runJamEnrichment(job, lease, () => pending as any));
    const observer = await connection();
    try {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const context = (await observer.query("SELECT state,generation FROM ticket_jam_contexts WHERE ticket_id=$1", [row.ticketId])).rows[0];
        if (context?.state === "fetching" && context.generation === row.generation) break;
        await new Promise((done) => setTimeout(done, 10));
      }
      if (change === "replace") {
        await observer.query("UPDATE tickets SET jam_url='https://jam.dev/c/new' WHERE id=$1", [row.ticketId]);
        await observer.query("UPDATE ticket_jam_contexts SET source_url='https://jam.dev/c/new',generation=$2,state='queued',data_json=NULL WHERE ticket_id=$1", [row.ticketId, randomUUID()]);
      } else if (change === "clear") {
        await observer.query("UPDATE tickets SET jam_url=NULL WHERE id=$1", [row.ticketId]);
        await observer.query("DELETE FROM ticket_jam_contexts WHERE ticket_id=$1", [row.ticketId]);
      } else {
        await observer.query("UPDATE tickets SET submitter_deleted_at=now(),submitter_deleted_by=$2 WHERE id=$1", [row.ticketId, row.userId]);
      }
      resolve({ state: "ready", evidence: evidence("https://jam.dev/c/old"), contentHash: "old-hash" });
      await running;
      const context = (await observer.query("SELECT generation,state,data_json FROM ticket_jam_contexts WHERE ticket_id=$1", [row.ticketId])).rows[0];
      if (change === "replace") expect(context).toMatchObject({ state: "queued", data_json: null });
      else if (change === "clear") expect(context).toBeUndefined();
      else expect(context).toMatchObject({ state: "fetching", data_json: null });
      expect(await snapshot(row.ticketId)).toMatchObject({
        status: before.status, submission_revision: before.submission_revision,
        submission_updated_at: before.submission_updated_at, agent_runs: 0,
      });
    } finally { await observer.end(); }
  });

  test("a real lost lease cannot publish or record failure", async () => {
    const row = await seed();
    const { job, workerId } = await claim(row);
    const observer = await connection();
    const { runJamEnrichment, failJamEnrichment } = await import("./jam-enrichment.ts");
    const { JamImportError } = await import("./jam-client.ts");
    await expect(owned(job.id, workerId, async (lease) => {
      await runJamEnrichment(job, lease, async () => {
        await observer.query("UPDATE jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [job.id]);
        return { state: "ready", evidence: evidence("https://jam.dev/c/old"), contentHash: "lost" };
      });
    })).rejects.toMatchObject({ code: "lease_lost" });
    await expect(owned(job.id, workerId, (lease) => failJamEnrichment(job, workerId, new JamImportError("timeout", true), lease)))
      .rejects.toMatchObject({ code: "lease_lost" });
    expect((await observer.query("SELECT state,data_json,content_hash FROM ticket_jam_contexts WHERE ticket_id=$1", [row.ticketId])).rows[0])
      .toEqual({ state: "fetching", data_json: null, content_hash: null });
    expect((await observer.query("SELECT status,error_json FROM jobs WHERE id=$1", [job.id])).rows[0]).toEqual({ status: "running", error_json: null });
    await observer.end();
  });

  test("reenters a fetching generation after restart and identical delivery is a material no-op", async () => {
    const row = await seed({ state: "fetching", hash: "same-hash" });
    const before = await snapshot(row.ticketId);
    await runSuccess(row, "same-hash");
    const observer = await connection();
    try {
      expect((await observer.query("SELECT state,content_hash FROM ticket_jam_contexts WHERE ticket_id=$1", [row.ticketId])).rows[0])
        .toEqual({ state: "ready", content_hash: "same-hash" });
      expect(await snapshot(row.ticketId)).toEqual(before);
      const duplicateJobId = randomUUID();
      await observer.query(
        "INSERT INTO jobs(id,type,payload_json,idempotency_key) VALUES($1,'ticket.jam_enrich',$2,$3)",
        [duplicateJobId, { ticket_id: row.ticketId, generation: row.generation }, `jam:${duplicateJobId}`],
      );
      await runSuccess({ ...row, jobId: duplicateJobId }, "same-hash");
      expect(await snapshot(row.ticketId)).toEqual(before);
    } finally { await observer.end(); }
  });

  test("only a material hash change marks the approved plan stale without changing reporter or workflow state", async () => {
    const row = await seed({ hash: "old-hash" });
    const observer = await connection();
    const planId = (await observer.query("INSERT INTO plans(ticket_id) VALUES($1) RETURNING id", [row.ticketId])).rows[0].id;
    const versionId = (await observer.query("INSERT INTO plan_versions(plan_id,version,content_markdown,content_hash) VALUES($1,1,'plan','hash') RETURNING id", [planId])).rows[0].id;
    await observer.query("UPDATE tickets SET approved_plan_version_id=$2 WHERE id=$1", [row.ticketId, versionId]);
    const before = await snapshot(row.ticketId);
    await runSuccess(row, "new-hash", "changed");
    expect((await observer.query("SELECT potentially_stale FROM plans WHERE id=$1", [planId])).rows[0].potentially_stale).toBe(true);
    const after = await snapshot(row.ticketId);
    expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
    expect(after).toMatchObject({
      status: before.status, submission_revision: before.submission_revision,
      submission_updated_at: before.submission_updated_at, agent_runs: 0,
    });
    await observer.end();
  });

  test("a completed import blocks queued execution before spawn while a started run keeps approved evidence", async () => {
    const row = await seed({ hash: "old-hash" });
    const observer = await connection();
    const { buildApprovedInputSnapshot } = await import("@dcc/domain");
    const { approvedExecutionInput, runQueuedExecutionBoundary } = await import("./worker-boundary.ts");
    const planId = (await observer.query("INSERT INTO plans(ticket_id) VALUES($1) RETURNING id", [row.ticketId])).rows[0].id;
    const planHash = "plan-hash";
    const versionId = (await observer.query("INSERT INTO plan_versions(plan_id,version,content_markdown,content_hash) VALUES($1,1,'plan',$2) RETURNING id", [planId, planHash])).rows[0].id;
    await observer.query("UPDATE plans SET current_version_id=$2 WHERE id=$1", [planId, versionId]);
    const captured = buildApprovedInputSnapshot({
      plan: { versionId, version: 1, contentHash: planHash },
      ticket: { title: "Jam ticket", jamEvidence: { contentHash: "old-hash", evidence: evidence("https://jam.dev/c/old", "approved evidence") } },
      project: { configVersion: 1, config: { enabled: true, slug: "jam", repositoryPath: "/tmp/jam", defaultBranch: "main" } },
      models: { execution: { model: "sonnet", reasoningLevel: "high" } },
      prompts: [{ phase: "execution", content: "Approved execution prompt", provenance: [] }], skills: [], policySources: [],
    } as any);
    const snapshotId = (await observer.query("INSERT INTO approved_input_snapshots(ticket_id,plan_version_id,material_input_json,input_hash,created_by) VALUES($1,$2,$3,$4,$5) RETURNING id", [row.ticketId, versionId, captured.materialInput, captured.inputHash, row.userId])).rows[0].id;
    await observer.query("UPDATE tickets SET status='Execution Queued',approved_plan_version_id=$2,approved_plan_hash=$3,approved_input_snapshot_id=$4 WHERE id=$1", [row.ticketId, versionId, planHash, snapshotId]);
    const startedInput = approvedExecutionInput({ id: snapshotId, inputHash: captured.inputHash, materialInput: captured.materialInput }, "execution", { worktreePath: "/tmp/run", branchName: "run", baseCommit: "base" });
    await runSuccess(row, "new-hash", "new live evidence");

    const spawnAgent = vi.fn();
    await expect(runQueuedExecutionBoundary(observer, {
      payload_json: { ticket_id: row.ticketId, plan_version_id: versionId, approved_input_snapshot_id: snapshotId },
    }, spawnAgent)).rejects.toThrow("execution gate failed: plan_potentially_stale");
    expect(spawnAgent).not.toHaveBeenCalled();
    expect(startedInput.jamEvidence).toMatchObject({ contentHash: "old-hash", evidence: { console: [{ message: "approved evidence" }] } });
    expect(JSON.stringify(startedInput)).not.toContain("new live evidence");
    await observer.end();
  });

  test("honors Retry-After, succeeds on the next claim, and exhausts timeout retries", async () => {
    const { failJamEnrichment } = await import("./jam-enrichment.ts");
    const { JamImportError } = await import("./jam-client.ts");
    const retry = await seed();
    const first = await claim(retry);
    await owned(first.job.id, first.workerId, (lease) =>
      failJamEnrichment(first.job, first.workerId, new JamImportError("rate_limited", true, 30), lease));
    const observer = await connection();
    let job = (await observer.query("SELECT status,available_at FROM jobs WHERE id=$1", [retry.jobId])).rows[0];
    expect(job.status).toBe("queued");
    expect(job.available_at.getTime()).toBeGreaterThanOrEqual(Date.now() + 29_000);
    await observer.query("UPDATE jobs SET available_at=now() WHERE id=$1", [retry.jobId]);
    await runSuccess(retry);
    expect((await observer.query("SELECT status,attempt FROM jobs WHERE id=$1", [retry.jobId])).rows[0]).toEqual({ status: "completed", attempt: 2 });

    const exhausted = await seed({ maxAttempts: 2 });
    for (let attempt = 0; attempt < 2; attempt++) {
      const claimed = await claim(exhausted);
      await owned(claimed.job.id, claimed.workerId, (lease) =>
        failJamEnrichment(claimed.job, claimed.workerId, new JamImportError("timeout", true), lease));
      if (attempt === 0) await observer.query("UPDATE jobs SET available_at=now() WHERE id=$1", [exhausted.jobId]);
    }
    expect((await observer.query("SELECT status,error_json->>'message' message FROM jobs WHERE id=$1", [exhausted.jobId])).rows[0])
      .toEqual({ status: "failed", message: "timeout" });
    expect((await observer.query("SELECT state,error_code FROM ticket_jam_contexts WHERE ticket_id=$1", [exhausted.ticketId])).rows[0])
      .toEqual({ state: "failed", error_code: "timeout" });
    await observer.end();
  });

  test.each([
    ["not_configured", "not_configured"], ["access_denied", "failed"], ["not_found", "failed"],
  ])("terminalizes permanent %s without workflow side effects", async (code, state) => {
    const row = await seed();
    const before = await snapshot(row.ticketId);
    const { job, workerId } = await claim(row);
    const { failJamEnrichment, runJamEnrichment } = await import("./jam-enrichment.ts");
    const { JamImportError } = await import("./jam-client.ts");
    const previousToken = process.env.DCC_JAM_TOKEN;
    if (code === "not_configured") delete process.env.DCC_JAM_TOKEN;
    try {
      await owned(job.id, workerId, async (lease) => {
        let failure: unknown;
        try {
          await runJamEnrichment(job, lease, async () => { throw new JamImportError(code as any, false); });
        } catch (error) { failure = error; }
        expect(failure).toMatchObject({ code });
        await failJamEnrichment(job, workerId, failure as any, lease);
      });
    } finally {
      if (previousToken === undefined) delete process.env.DCC_JAM_TOKEN;
      else process.env.DCC_JAM_TOKEN = previousToken;
    }
    const observer = await connection();
    expect((await observer.query("SELECT status,error_json FROM jobs WHERE id=$1", [row.jobId])).rows[0]).toEqual({ status: "completed", error_json: null });
    expect((await observer.query("SELECT state,error_code FROM ticket_jam_contexts WHERE ticket_id=$1", [row.ticketId])).rows[0]).toEqual({ state, error_code: code });
    expect(await snapshot(row.ticketId)).toEqual(before);
    await observer.end();
  });
});
