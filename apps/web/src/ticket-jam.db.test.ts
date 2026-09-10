import { afterAll, beforeAll, describe, expect, test } from "vitest";

const testDatabaseUrl = process.env.DCC_TEST_DATABASE_URL;
process.env.NODE_ENV = "test";
process.env.DCC_PROCESS_ROLE = "web";
process.env.DATABASE_URL = testDatabaseUrl ?? "postgres://unused:unused@127.0.0.1:1/unused";
const integration = testDatabaseUrl ? describe : describe.skip;
const { pool } = await import("@dcc/database");
const { migrate } = await import("../../../packages/database/src/migrate.ts");
const { createSubmission, updateSubmission } = await import("./ticket-submissions.ts");

integration("ticket Jam source transactions", () => {
  let userId = "", projectId = "";
  const actor = () => ({ userId, role: "reporter" as const });

  beforeAll(async () => {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await migrate({ connectionString: testDatabaseUrl! });
    userId = (await pool.query("INSERT INTO users(username,password_hash,role) VALUES('jam-reporter','hash','reporter') RETURNING id")).rows[0].id;
    projectId = (await pool.query("INSERT INTO projects(slug,name,repository_path) VALUES('jam-project','Jam project','/tmp/jam-project') RETURNING id")).rows[0].id;
    await pool.query("INSERT INTO project_memberships(user_id,project_id) VALUES($1,$2)", [userId, projectId]);
  });
  afterAll(async () => { await pool.end(); });

  test("queues one generation, keeps identical saves idempotent, and invalidates replaced evidence", async () => {
    const created = await createSubmission(actor(), { project_id: projectId, title: "Jam", description: "Capture", jam_url: "https://jam.dev/c/first?copy=1" });
    expect(created).toMatchObject({ jam_url: "https://jam.dev/c/first", jam_import: { state: "queued" } });
    const first = (await pool.query("SELECT * FROM ticket_jam_contexts WHERE ticket_id=$1", [created.id])).rows[0];
    expect(Number((await pool.query("SELECT count(*) FROM jobs WHERE type='ticket.jam_enrich' AND payload_json->>'ticket_id'=$1", [created.id])).rows[0].count)).toBe(1);
    expect(Number((await pool.query("SELECT count(*) FROM agent_runs WHERE ticket_id=$1", [created.id])).rows[0].count)).toBe(0);

    const unchanged = await updateSubmission(actor(), created.id, { submission_revision: 1, jam_url: "https://jam.dev/c/first#again" });
    expect(unchanged.submission_revision).toBe(1);
    expect((await pool.query("SELECT generation FROM ticket_jam_contexts WHERE ticket_id=$1", [created.id])).rows[0].generation).toBe(first.generation);

    await pool.query("UPDATE ticket_jam_contexts SET state='ready',data_json='{\"secret\":true}' WHERE ticket_id=$1", [created.id]);
    const replaced = await updateSubmission(actor(), created.id, { submission_revision: 1, jam_url: "https://jam.dev/c/second" });
    expect(replaced.submission_revision).toBe(2);
    expect((await pool.query("SELECT source_url,state,data_json FROM ticket_jam_contexts WHERE ticket_id=$1", [created.id])).rows[0])
      .toEqual({ source_url: "https://jam.dev/c/second", state: "queued", data_json: null });
    await updateSubmission(actor(), created.id, { submission_revision: 2, jam_url: "" });
    expect((await pool.query("SELECT 1 FROM ticket_jam_contexts WHERE ticket_id=$1", [created.id])).rowCount).toBe(0);
  });

  test("rolls back Jam rows and jobs when creation fails", async () => {
    await expect(createSubmission(actor(), { project_id: projectId, title: "", description: "bad", jam_url: "https://jam.dev/c/nope" })).rejects.toMatchObject({ status: 422 });
    expect(Number((await pool.query("SELECT count(*) FROM ticket_jam_contexts")).rows[0].count)).toBe(0);
  });
});
