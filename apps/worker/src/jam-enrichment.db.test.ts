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

const evidence = (url: string) => ({
  sourceUrl: url, device: {}, console: [], network: [], events: [], metadata: {},
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

  async function seed() {
    const client = await connection();
    const projectId = randomUUID(), ticketId = randomUUID(), generation = randomUUID(), jobId = randomUUID();
    await client.query("INSERT INTO projects(id,slug,name,repository_path) VALUES($1,$2,'Jam','/tmp/jam')", [projectId, `jam-${projectId}`]);
    await client.query("INSERT INTO tickets(id,ticket_number,project_id,title,status,jam_url) VALUES($1,$2,$3,'Jam ticket','Submitted',$4)", [ticketId, `J-${ticketId}`, projectId, "https://jam.dev/c/old"]);
    await client.query("INSERT INTO ticket_jam_contexts(ticket_id,source_url,generation,state) VALUES($1,$2,$3,'queued')", [ticketId, "https://jam.dev/c/old", generation]);
    await client.query(
      "INSERT INTO jobs(id,type,status,payload_json,idempotency_key,attempt,max_attempts,claimed_by,lease_expires_at) VALUES($1,'ticket.jam_enrich','running',$2,$3,1,3,'worker-1',now()+interval '1 minute')",
      [jobId, { ticket_id: ticketId, generation }, `jam:${jobId}`],
    );
    await client.end();
    return { ticketId, generation, jobId, job: { id: jobId, type: "ticket.jam_enrich", attempt: 1, max_attempts: 3, claimed_by: "worker-1", payload_json: { ticket_id: ticketId, generation } } };
  }

  test("discards an old fetch after the source generation is replaced", async () => {
    const row = await seed();
    let resolve!: (value: any) => void;
    const pending = new Promise((done) => { resolve = done; });
    const lease = { signal: new AbortController().signal, assertOwned: vi.fn(async () => undefined) };
    const { runJamEnrichment } = await import("./jam-enrichment.ts");
    const running = runJamEnrichment(row.job, lease, () => pending as any);
    const observer = await connection();
    try {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        if ((await observer.query("SELECT state FROM ticket_jam_contexts WHERE ticket_id=$1", [row.ticketId])).rows[0]?.state === "fetching") break;
        await new Promise((done) => setTimeout(done, 10));
      }
      const nextGeneration = randomUUID();
      await observer.query("UPDATE tickets SET jam_url='https://jam.dev/c/new' WHERE id=$1", [row.ticketId]);
      await observer.query("UPDATE ticket_jam_contexts SET source_url='https://jam.dev/c/new',generation=$2,state='queued',data_json=NULL WHERE ticket_id=$1", [row.ticketId, nextGeneration]);
      resolve({ state: "ready", evidence: evidence("https://jam.dev/c/old"), contentHash: "old-hash" });
      await running;
      const current = (await observer.query("SELECT generation,state,data_json FROM ticket_jam_contexts WHERE ticket_id=$1", [row.ticketId])).rows[0];
      expect(current).toMatchObject({ generation: nextGeneration, state: "queued", data_json: null });
      expect((await observer.query("SELECT status FROM tickets WHERE id=$1", [row.ticketId])).rows[0].status).toBe("Submitted");
      expect(Number((await observer.query("SELECT count(*) count FROM agent_runs WHERE ticket_id=$1", [row.ticketId])).rows[0].count)).toBe(0);
    } finally { await observer.end(); }
  });

  test("requeues retryable failures and records only their safe code", async () => {
    const row = await seed();
    const lease = { signal: new AbortController().signal, assertOwned: vi.fn(async () => undefined) };
    const { failJamEnrichment } = await import("./jam-enrichment.ts");
    const { JamImportError } = await import("./jam-client.ts");
    await failJamEnrichment(row.job, "worker-1", new JamImportError("rate_limited", true, 30), lease);
    const observer = await connection();
    try {
      expect((await observer.query("SELECT status,error_json->>'message' message FROM jobs WHERE id=$1", [row.jobId])).rows[0]).toMatchObject({ status: "queued", message: "rate_limited" });
      expect((await observer.query("SELECT state,error_code FROM ticket_jam_contexts WHERE ticket_id=$1", [row.ticketId])).rows[0]).toMatchObject({ state: "queued", error_code: "rate_limited" });
    } finally { await observer.end(); }
  });
});
