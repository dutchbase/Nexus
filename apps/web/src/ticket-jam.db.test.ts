import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

const testDatabaseUrl = process.env.DCC_TEST_DATABASE_URL;
process.env.NODE_ENV = "test";
process.env.DCC_PROCESS_ROLE = "web";
process.env.DATABASE_URL = testDatabaseUrl ?? "postgres://unused:unused@127.0.0.1:1/unused";
const integration = testDatabaseUrl ? describe : describe.skip;
const { pool } = await import("@dcc/database");
const { migrate } = await import("../../../packages/database/src/migrate.ts");
const { createSubmission, updateSubmission } = await import("./ticket-submissions.ts");
const { adminApi, submitPublicForm } = await import("./server.ts");
const { ticketApi } = await import("./ticket-api.ts");
const { reporterTicketsPage } = await import("./pages/reporter-tickets.ts");
const { validateWebRuntime } = await import("./security.ts");

const request = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST", headers, socket: { remoteAddress: "127.0.0.22" },
  async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); },
} as any);
const response = () => {
  const result = { status: 0, body: null as any, writeHead: vi.fn((status: number) => { result.status = status; }), end: vi.fn((body?: string) => { result.body = body ? JSON.parse(body) : null; }) };
  return result as any;
};

integration("ticket Jam source transactions", () => {
  let userId = "", adminId = "", projectId = "", publicForm: any;
  const actor = () => ({ userId, role: "reporter" as const });

  beforeAll(async () => {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await migrate({ connectionString: testDatabaseUrl! });
    userId = (await pool.query("INSERT INTO users(username,password_hash,role) VALUES('jam-reporter','hash','reporter') RETURNING id")).rows[0].id;
    adminId = (await pool.query("INSERT INTO users(username,password_hash,role) VALUES('jam-admin','hash','admin') RETURNING id")).rows[0].id;
    projectId = (await pool.query("INSERT INTO projects(slug,name,repository_path) VALUES('jam-project','Jam project','/tmp/jam-project') RETURNING id")).rows[0].id;
    await pool.query("INSERT INTO project_memberships(user_id,project_id) VALUES($1,$2)", [userId, projectId]);
    publicForm = (await pool.query("INSERT INTO forms(name,slug,title,status,fixed_project_id,settings_json) VALUES('Jam public','jam-public','Jam public','published',$1,'{\"notify_on_submission\":false}') RETURNING *", [projectId])).rows[0];
    await pool.query(`INSERT INTO form_fields(form_id,field_key,field_type,label,required,position) VALUES
      ($1,'title','short_text','Title',true,10),($1,'description','long_text','Description',true,20),
      ($1,'jam_url','jam_link','Jam link',false,30)`, [publicForm.id]);
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
    const before = (await pool.query("SELECT (SELECT count(*) FROM tickets) tickets,(SELECT count(*) FROM ticket_jam_contexts) contexts,(SELECT count(*) FROM jobs WHERE type='ticket.jam_enrich') jobs")).rows[0];
    await pool.query(`CREATE FUNCTION fail_jam_test_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.action='ticket.create' AND NEW.after_json->>'title'='Rollback Jam' THEN RAISE EXCEPTION 'forced failure after enqueue'; END IF; RETURN NEW; END $$`);
    await pool.query("CREATE TRIGGER fail_jam_test_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_jam_test_audit()");
    try {
      await expect(createSubmission(actor(), { project_id: projectId, title: "Rollback Jam", description: "bad", jam_url: "https://jam.dev/c/nope" })).rejects.toThrow("forced failure after enqueue");
    } finally {
      await pool.query("DROP TRIGGER fail_jam_test_audit ON audit_events; DROP FUNCTION fail_jam_test_audit()");
    }
    const after = (await pool.query("SELECT (SELECT count(*) FROM tickets) tickets,(SELECT count(*) FROM ticket_jam_contexts) contexts,(SELECT count(*) FROM jobs WHERE type='ticket.jam_enrich') jobs")).rows[0];
    expect(after).toEqual(before);
  });

  test("admin create and edit each queue the selected Jam generation", async () => {
    const createdResponse = response();
    await adminApi(request({ project_id: projectId, title: "Admin Jam", description: "Capture", jam_url: "https://jam.dev/c/admin-one" }), createdResponse,
      new URL("http://test/api/admin/tickets"), { user_id: adminId, role: "admin" });
    expect(createdResponse.status).toBe(201);
    const ticketId = createdResponse.body.ticket.id;
    expect(Number((await pool.query("SELECT count(*) FROM jobs WHERE type='ticket.jam_enrich' AND payload_json->>'ticket_id'=$1", [ticketId])).rows[0].count)).toBe(1);

    const editedResponse = response();
    const edit = request({ jam_url: "https://jam.dev/c/admin-two" }); edit.method = "PATCH";
    await adminApi(edit, editedResponse, new URL(`http://test/api/admin/tickets/${ticketId}`), { user_id: adminId, role: "admin" });
    expect(editedResponse.status).toBe(200);
    expect((await pool.query("SELECT source_url FROM ticket_jam_contexts WHERE ticket_id=$1", [ticketId])).rows[0].source_url).toBe("https://jam.dev/c/admin-two");
    expect(Number((await pool.query("SELECT count(*) FROM jobs WHERE type='ticket.jam_enrich' AND payload_json->>'ticket_id'=$1", [ticketId])).rows[0].count)).toBe(2);

    await pool.query("UPDATE ticket_jam_contexts SET state='failed',data_json='{\"console\":[\"saved\"]}' WHERE ticket_id=$1", [ticketId]);
    const retryResponse = response();
    await adminApi(request({}), retryResponse, new URL(`http://test/api/admin/tickets/${ticketId}/jam/retry`), { user_id: adminId, role: "admin" });
    expect(retryResponse.status).toBe(202);
    expect((await pool.query("SELECT state,data_json FROM ticket_jam_contexts WHERE ticket_id=$1", [ticketId])).rows[0])
      .toEqual({ state: "queued", data_json: { console: ["saved"] } });
    expect(Number((await pool.query("SELECT count(*) FROM jobs WHERE type='ticket.jam_enrich' AND payload_json->>'ticket_id'=$1", [ticketId])).rows[0].count)).toBe(3);
    await expect(adminApi(request({}), response(), new URL(`http://test/api/admin/tickets/${ticketId}/jam/retry`), { user_id: adminId, role: "admin" }))
      .rejects.toMatchObject({ status: 409 });
  });

  test("public idempotency retries return the saved ticket without another Jam job", async () => {
    const key = "11111111-1111-4111-8111-111111111111";
    const first = response(), second = response();
    await submitPublicForm(request({ title: "Public Jam", description: "Capture", jam_url: "https://jam.dev/c/public" }, { "idempotency-key": key }), first, publicForm);
    await submitPublicForm(request({ title: "Public Jam", description: "Capture", jam_url: "https://jam.dev/c/public" }, { "idempotency-key": key }), second, publicForm);
    expect([first.status, second.status]).toEqual([201, 201]);
    expect(second.body.ticket.id).toBe(first.body.ticket.id);
    expect(Number((await pool.query("SELECT count(*) FROM jobs WHERE type='ticket.jam_enrich' AND payload_json->>'ticket_id'=$1", [first.body.ticket.id])).rows[0].count)).toBe(1);
  });

  test("keeps the worker Jam token out of web, API, HTML, jobs, and audit records", async () => {
    const sentinel = "sentinel-jam-service-token";
    expect(() => validateWebRuntime({
      NODE_ENV: "production", DCC_PROCESS_ROLE: "web", APP_BASE_URL: "https://nexus.test", DCC_JAM_TOKEN: sentinel,
    })).toThrow("DCC_JAM_TOKEN");

    const previous = process.env.DCC_JAM_TOKEN;
    process.env.DCC_JAM_TOKEN = sentinel;
    try {
      const created = await createSubmission(actor(), {
        project_id: projectId, title: "Secret boundary", description: "Capture", jam_url: "https://jam.dev/c/secret-boundary",
      });
      const apiResponse = response();
      const apiRequest = request({}); apiRequest.method = "GET";
      await ticketApi(apiRequest, apiResponse, new URL(`http://test/api/tickets/${created.ticket_number}`), actor());
      const page = await reporterTicketsPage.render(new URL(`http://test/tickets/${created.ticket_number}`), { user_id: userId, role: "reporter" } as any);
      const persisted = await pool.query(
        `SELECT
          (SELECT payload_json FROM jobs WHERE type='ticket.jam_enrich' AND payload_json->>'ticket_id'=$1 ORDER BY created_at DESC LIMIT 1) job,
          (SELECT jsonb_agg(jsonb_build_object('before',before_json,'after',after_json,'metadata',metadata_json))
             FROM audit_events WHERE entity_id=$1) audit`,
        [created.id],
      );
      expect(apiResponse.status).toBe(200);
      expect(page?.status).toBe(200);
      for (const surface of [apiResponse.body, page?.body, persisted.rows[0]]) {
        expect(JSON.stringify(surface)).not.toContain(sentinel);
      }
    } finally {
      if (previous === undefined) delete process.env.DCC_JAM_TOKEN;
      else process.env.DCC_JAM_TOKEN = previous;
    }
  });
});
