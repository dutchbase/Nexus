import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { callRoute, createTestSession } from "../../../tests/helpers/ticket-http.ts";

const testDatabaseUrl = process.env.DCC_TEST_DATABASE_URL;
process.env.NODE_ENV = "test";
process.env.DCC_PROCESS_ROLE = "web";
process.env.DATABASE_URL = testDatabaseUrl ?? "postgres://unused:unused@127.0.0.1:1/unused";
const integration = testDatabaseUrl ? describe : describe.skip;
const { pool } = await import("@dcc/database");
const { migrate } = await import("../../../packages/database/src/migrate.ts");

integration("project-scoped ticket submissions", () => {
  let reporterA: any, reporterB: any, reporterC: any, adminSession: any;
  let reporterAId = "";
  let projectA = "", projectB = "", ticketB = "", legacy = "";

  beforeAll(async () => {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await migrate({ connectionString: testDatabaseUrl! });
    const users = (await pool.query(
      `INSERT INTO users(username,password_hash,role) VALUES
       ('submission-a','hash','reporter'),('submission-b','hash','reporter'),('submission-c','hash','reporter') RETURNING id ORDER BY username`,
    )).rows;
    reporterAId = users[0].id;
    [reporterA, reporterB, reporterC] = await Promise.all(users.map((user: any) => createTestSession(pool, user.id)));
    const admin = (await pool.query("INSERT INTO users(username,password_hash,role) VALUES('submission-admin','hash','admin') RETURNING id")).rows[0];
    adminSession = await createTestSession(pool, admin.id);
    const projects = (await pool.query(
      `INSERT INTO projects(slug,name,repository_path) VALUES
       ('submission-a','Project A','/tmp/submission-a'),('submission-b','Project B','/tmp/submission-b') RETURNING id ORDER BY slug`,
    )).rows;
    [projectA, projectB] = projects.map((project: any) => project.id);
    await pool.query("INSERT INTO project_memberships(user_id,project_id) VALUES($1,$3),($2,$3),($4,$5)", [users[0].id, users[1].id, projectA, users[2].id, projectB]);
    ticketB = (await pool.query(
      `INSERT INTO tickets(ticket_number,project_id,title,description,status,created_by_user_id)
       VALUES('DCC-SUB-B',$1,'B ticket','B description','Executing',$2) RETURNING id`, [projectA, users[1].id],
    )).rows[0].id;
    legacy = (await pool.query(
      "INSERT INTO tickets(ticket_number,project_id,title,description,status) VALUES('DCC-LEGACY',$1,'Legacy','Legacy description','Submitted') RETURNING id", [projectA],
    )).rows[0].id;
    await pool.query("INSERT INTO tickets(ticket_number,project_id,title,description,status,created_by_user_id) VALUES('DCC-OTHER',$1,'Other project','Hidden','Submitted',$2)", [projectB, users[2].id]);
  });
  afterAll(async () => { await pool.end(); });

  test("creates, safely projects, edits project tickets, and soft-deletes only its own", async () => {
    const created = await callRoute("/api/tickets", { ...reporterA, method: "POST", csrf: reporterA.csrf,
      body: { project_id: projectA, title: "Broken save", description: "Save leaves an empty page" } });
    expect(created.status).toBe(201);
    expect(created.body.ticket).toMatchObject({ can_delete: true, submission_revision: 1, title: "Broken save" });
    expect(created.body.ticket).not.toHaveProperty("status");
    expect(created.body.ticket).not.toHaveProperty("created_by_user_id");

    const list = await callRoute("/api/tickets", reporterA);
    expect(list.body.tickets.map((ticket: any) => ticket.id)).toContain(ticketB);
    expect(list.body.tickets.some((ticket: any) => ticket.project_id === projectB)).toBe(false);

    const editOther = await callRoute(`/api/tickets/${ticketB}`, { ...reporterA, method: "PATCH", csrf: reporterA.csrf,
      body: { submission_revision: 1, title: "Edited by project member" } });
    expect(editOther.status).toBe(200);
    expect(editOther.body.ticket).toMatchObject({ title: "Edited by project member", submission_revision: 2, can_delete: false });
    expect((await callRoute(`/api/tickets/${ticketB}`, { ...reporterA, method: "DELETE", csrf: reporterA.csrf })).status).toBe(403);
    expect((await callRoute(`/api/tickets/${legacy}`, { ...reporterA, method: "DELETE", csrf: reporterA.csrf })).status).toBe(403);

    const forged = await callRoute(`/api/tickets/${created.body.ticket.id}`, { ...reporterA, method: "PATCH", csrf: reporterA.csrf,
      body: { submission_revision: 1, submission: { project_id: projectB }, status: "Execution Queued" } });
    expect(forged.status).toBe(422);
    expect((await pool.query("SELECT title,status,project_id FROM tickets WHERE id=$1", [created.body.ticket.id])).rows[0])
      .toMatchObject({ title: "Broken save", status: "Submitted", project_id: projectA });

    expect((await callRoute(`/api/tickets/${created.body.ticket.id}`, { ...reporterA, method: "DELETE", csrf: reporterA.csrf })).status).toBe(204);
    expect((await callRoute(`/api/tickets/${created.body.ticket.id}`, reporterA)).status).toBe(404);
    expect((await pool.query("SELECT status,submitter_deleted_at FROM tickets WHERE id=$1", [created.body.ticket.id])).rows[0])
      .toMatchObject({ status: "Submitted", submitter_deleted_at: expect.anything() });
  });

  test("rejects inaccessible projects and stale revisions without partial writes", async () => {
    expect((await callRoute("/api/tickets", { ...reporterA, method: "POST", csrf: reporterA.csrf,
      body: { project_id: projectB, title: "Forbidden", description: "No access" } })).status).toBe(404);
    expect((await callRoute("/api/tickets/DCC-OTHER", reporterA)).status).toBe(404);
    const stale = await callRoute(`/api/tickets/${ticketB}`, { ...reporterB, method: "PATCH", csrf: reporterB.csrf,
      body: { submission_revision: 1, description: "stale write" } });
    expect(stale.status).toBe(409);
    expect((await pool.query("SELECT description FROM tickets WHERE id=$1", [ticketB])).rows[0].description).toBe("B description");
  });

  test("serializes assignment revocation before a waiting reporter edit", async () => {
    const admin = await pool.connect();
    try {
      await admin.query("BEGIN");
      await admin.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [reporterAId]);
      const pending = callRoute(`/api/tickets/${legacy}`, { ...reporterA, method: "PATCH", csrf: reporterA.csrf,
        body: { submission_revision: 1, title: "Must not land" } });
      await admin.query("DELETE FROM project_memberships WHERE user_id=$1 AND project_id=$2", [reporterAId, projectA]);
      await admin.query("COMMIT");
      expect((await pending).status).toBe(404);
      expect((await pool.query("SELECT title FROM tickets WHERE id=$1", [legacy])).rows[0].title).toBe("Legacy");
    } finally {
      await admin.query("ROLLBACK").catch(() => {});
      admin.release();
    }
  });

  test("admin creation stamps ownership and material edits alone advance submission revision", async () => {
    const created = await callRoute("/api/admin/tickets", { ...adminSession, method: "POST", csrf: adminSession.csrf,
      body: { project_id: projectA, title: "Admin ticket", description: "Admin description" } });
    expect(created.status).toBe(201);
    const stored = (await pool.query("SELECT created_by_user_id,submission_revision FROM tickets WHERE id=$1", [created.body.ticket.id])).rows[0];
    expect(stored).toMatchObject({ created_by_user_id: expect.any(String), submission_revision: 1 });
    const material = await callRoute(`/api/admin/tickets/${created.body.ticket.id}`, { ...adminSession, method: "PATCH", csrf: adminSession.csrf,
      body: { source_url: "https://example.test/report" } });
    expect(material.status).toBe(200);
    expect(material.body.ticket.submission_revision).toBe(2);
    const workflowOnly = await callRoute(`/api/admin/tickets/${created.body.ticket.id}`, { ...adminSession, method: "PATCH", csrf: adminSession.csrf,
      body: { status: "Needs Information" } });
    expect(workflowOnly.status).toBe(200);
    expect(workflowOnly.body.ticket.submission_revision).toBe(2);
  });

  test("soft deletion leaves workflow state and operational rows unchanged", async () => {
    const before = (await pool.query(
      `SELECT status,approved_plan_version_id,
       (SELECT count(*)::int FROM jobs) jobs,(SELECT count(*)::int FROM agent_runs WHERE ticket_id=$1) runs
       FROM tickets WHERE id=$1`, [ticketB],
    )).rows[0];
    expect((await callRoute(`/api/tickets/${ticketB}`, { ...reporterB, method: "DELETE", csrf: reporterB.csrf })).status).toBe(204);
    const after = (await pool.query(
      `SELECT status,approved_plan_version_id,
       (SELECT count(*)::int FROM jobs) jobs,(SELECT count(*)::int FROM agent_runs WHERE ticket_id=$1) runs
       FROM tickets WHERE id=$1`, [ticketB],
    )).rows[0];
    expect(after).toEqual(before);
  });
});
