import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { callRoute, createTestSession } from "../../../tests/helpers/ticket-http.ts";

const testDatabaseUrl = process.env.DCC_TEST_DATABASE_URL;
process.env.NODE_ENV = "test";
process.env.DCC_PROCESS_ROLE = "web";
process.env.DATABASE_URL = testDatabaseUrl ?? "postgres://unused:unused@127.0.0.1:1/unused";
const integration = testDatabaseUrl ? describe : describe.skip;
const { pool } = await import("@dcc/database");
const { migrate } = await import("../../../packages/database/src/migrate.ts");
const { verifyPassword } = await import("../../../packages/database/src/password.ts");

integration("reporter administration", () => {
  let adminSession: Awaited<ReturnType<typeof createTestSession>>;
  let reporterSession: Awaited<ReturnType<typeof createTestSession>>;
  let adminId = "";
  let reporterId = "";
  let projectA = "";
  let projectB = "";

  beforeAll(async () => {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await migrate({ connectionString: testDatabaseUrl! });
    adminId = (await pool.query("INSERT INTO users(username,password_hash,role) VALUES ('users-admin','hash','admin') RETURNING id")).rows[0].id;
    reporterId = (await pool.query("INSERT INTO users(username,password_hash,role) VALUES ('existing-reporter','hash','reporter') RETURNING id")).rows[0].id;
    projectA = (await pool.query("INSERT INTO projects(slug,name,repository_path) VALUES ('users-a','Project A','/tmp/users-a') RETURNING id")).rows[0].id;
    projectB = (await pool.query("INSERT INTO projects(slug,name,repository_path) VALUES ('users-b','Project B','/tmp/users-b') RETURNING id")).rows[0].id;
    adminSession = await createTestSession(pool, adminId);
    reporterSession = await createTestSession(pool, reporterId);
  });
  afterAll(async () => { await pool.end(); });

  test("creates a reporter with deduplicated assignments without exposing credentials", async () => {
    const created = await callRoute("/api/admin/users", {
      ...adminSession, method: "POST", csrf: adminSession.csrf,
      body: { username: " client-one ", password: "a-long-test-password", project_ids: [projectA, projectA] },
    });
    expect(created.status).toBe(201);
    expect(created.body.user).toMatchObject({ username: "client-one", role: "reporter", project_ids: [projectA] });
    expect(JSON.stringify(created.body)).not.toMatch(/password|hash/i);
    const stored = (await pool.query("SELECT * FROM users WHERE id=$1", [created.body.user.id])).rows[0];
    expect(await verifyPassword(stored.password_hash, "a-long-test-password")).toBe(true);
    const audit = (await pool.query("SELECT before_json,after_json FROM audit_events WHERE entity_id=$1", [stored.id])).rows[0];
    expect(JSON.stringify(audit)).not.toMatch(/password|hash/i);
  });

  test("rejects duplicate usernames and invalid input", async () => {
    const create = (body: Record<string, unknown>) => callRoute("/api/admin/users", { ...adminSession, method: "POST", csrf: adminSession.csrf, body });
    expect((await create({ username: "client-one", password: "another-long-password", project_ids: [] })).status).toBe(409);
    expect((await create({ username: "client-two", password: "another-long-password", project_ids: ["11111111-1111-4111-8111-111111111111"] })).status).toBe(422);
    expect((await create({ username: "client-three", password: "another-long-password", project_ids: [], role: "admin" })).status).toBe(422);
    expect((await create({ username: "bad name", password: "another-long-password", project_ids: [] })).status).toBe(422);
    expect((await pool.query("SELECT username FROM users WHERE username IN ('client-two','client-three')")).rows).toEqual([]);
  });

  test("denies non-admin access", async () => {
    expect((await callRoute("/api/admin/users", reporterSession)).status).toBe(403);
    expect((await callRoute("/api/admin/users", { ...reporterSession, method: "POST", csrf: reporterSession.csrf, body: { username: "blocked-user", password: "a-long-test-password", project_ids: [] } })).status).toBe(403);
  });

  test("replaces projects atomically and invalidates sessions on deactivate and password reset", async () => {
    const created = await callRoute("/api/admin/users", { ...adminSession, method: "POST", csrf: adminSession.csrf, body: { username: "managed-user", password: "a-long-test-password", project_ids: [projectA] } });
    const id = created.body.user.id;
    const firstSession = await createTestSession(pool, id);
    const secondSession = await createTestSession(pool, id);
    const updated = await callRoute(`/api/admin/users/${id}`, { ...adminSession, method: "PATCH", csrf: adminSession.csrf, body: { project_ids: [projectB, projectB] } });
    expect(updated.body.user.project_ids).toEqual([projectB]);
    expect((await callRoute(`/api/admin/users/${id}`, { ...adminSession, method: "PATCH", csrf: adminSession.csrf, body: { project_ids: [projectA, "11111111-1111-4111-8111-111111111111"] } })).status).toBe(422);
    expect((await pool.query("SELECT project_id FROM project_memberships WHERE user_id=$1", [id])).rows).toEqual([{ project_id: projectB }]);
    expect((await callRoute(`/api/admin/users/${id}/password`, { ...adminSession, method: "POST", csrf: adminSession.csrf, body: { password: "a-new-long-password" } })).status).toBe(204);
    expect((await callRoute("/api/session", firstSession)).status).toBe(401);
    const activeSession = await createTestSession(pool, id);
    const deactivated = await callRoute(`/api/admin/users/${id}`, { ...adminSession, method: "PATCH", csrf: adminSession.csrf, body: { is_active: false } });
    expect(deactivated.body.user.is_active).toBe(false);
    expect((await callRoute("/api/session", activeSession)).status).toBe(401);
    expect((await pool.query("SELECT count(*)::int count FROM admin_sessions WHERE user_id=$1 AND invalidated_at IS NULL", [id])).rows[0].count).toBe(0);
    expect((await callRoute("/api/session", secondSession)).status).toBe(401);
  });

  test("does not target admins through reporter endpoints", async () => {
    expect((await callRoute(`/api/admin/users/${adminId}`, { ...adminSession, method: "PATCH", csrf: adminSession.csrf, body: { is_active: false } })).status).toBe(404);
    expect((await callRoute(`/api/admin/users/${adminId}/password`, { ...adminSession, method: "POST", csrf: adminSession.csrf, body: { password: "a-new-long-password" } })).status).toBe(404);
  });

  test("renders the user controls and empty-assignment explanation", async () => {
    const page = await callRoute("/admin/users", adminSession);
    expect(page.status).toBe(200);
    expect(page.text).toContain("Add user");
    expect(page.text).toContain("Initial password");
    expect(page.text).toContain("No assigned projects");
    expect(page.text).toContain('role="alert" data-user-error');
    expect(page.text).not.toMatch(/password_hash/);
  });
});
