import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { callRoute, createTestSession } from "../../../tests/helpers/ticket-http.ts";

const testDatabaseUrl = process.env.DCC_TEST_DATABASE_URL;
process.env.NODE_ENV = "test";
process.env.DCC_PROCESS_ROLE = "web";
process.env.DATABASE_URL = testDatabaseUrl ?? "postgres://unused:unused@127.0.0.1:1/unused";
const integration = testDatabaseUrl ? describe : describe.skip;
const { pool } = await import("@dcc/database");
const { migrate } = await import("../../../packages/database/src/migrate.ts");

const adminReads = [
  "/api/admin/tickets", "/api/admin/projects", "/api/admin/jobs", "/api/admin/audit", "/api/admin/pull-requests", "/api/admin/prompts",
  "/api/admin/tickets/ticket-1/plans", "/api/admin/runs/11111111-1111-4111-8111-111111111111/events", "/api/admin/runs/11111111-1111-4111-8111-111111111111/log",
  "/api/admin/tickets/ticket-1/prompt-preview", "/api/admin/notifications/providers", "/api/admin/plans/11111111-1111-4111-8111-111111111111/feedback",
];
const adminActions: Array<[string, "POST" | "PATCH"]> = [
  ["/api/admin/tickets/ticket-1/acknowledge", "POST"], ["/api/admin/tickets/ticket-1/approve-planning", "POST"], ["/api/admin/tickets/ticket-1/execute", "POST"],
  ["/api/admin/plans/11111111-1111-4111-8111-111111111111/request-revision", "POST"], ["/api/admin/plan-versions/11111111-1111-4111-8111-111111111111/approve", "POST"],
  ["/api/admin/tickets/ticket-1/cancel", "POST"], ["/api/admin/runs/11111111-1111-4111-8111-111111111111/retry", "POST"],
  ["/api/admin/pull-requests/11111111-1111-4111-8111-111111111111/approve", "POST"], ["/api/admin/projects/11111111-1111-4111-8111-111111111111/deployment/promote", "POST"],
  ["/api/admin/tickets/ticket-1", "PATCH"],
];

integration("reporter role boundary", () => {
  let reporterSession: Awaited<ReturnType<typeof createTestSession>>;
  let adminSession: Awaited<ReturnType<typeof createTestSession>>;

  beforeAll(async () => {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await migrate({ connectionString: testDatabaseUrl! });
    const reporter = (await pool.query("INSERT INTO users(username,password_hash,role) VALUES ('boundary-reporter','test-hash','reporter') RETURNING id")).rows[0];
    const admin = (await pool.query("INSERT INTO users(username,password_hash,role) VALUES ('boundary-admin','test-hash','admin') RETURNING id")).rows[0];
    reporterSession = await createTestSession(pool, reporter.id);
    adminSession = await createTestSession(pool, admin.id);
  });
  afterAll(async () => { await pool.end(); });

  test("denies reporters every admin route before reads or actions", async () => {
    const before = (await pool.query("SELECT (SELECT count(*) FROM jobs)::integer jobs, (SELECT count(*) FROM agent_runs)::integer runs, (SELECT count(*) FROM tickets)::integer tickets")).rows[0];
    for (const path of adminReads) expect((await callRoute(path, reporterSession)).status).toBe(403);
    for (const [path, method] of adminActions) expect((await callRoute(path, { ...reporterSession, method, body: {} })).status).toBe(403);
    for (const path of ["/admin", "/admin/attachments/11111111-1111-4111-8111-111111111111?download=1", "/admin/runs", "/admin/queue", "/admin/notifications", "/admin/ai-usage", "/admin/settings", "/admin/system"]) {
      const result = await callRoute(path, reporterSession);
      expect(result.status).toBe(403);
      expect(result.text).not.toContain("Running agents");
    }
    expect((await callRoute("/admin", { ...reporterSession, method: "HEAD" })).status).toBe(403);
    expect((await pool.query("SELECT (SELECT count(*) FROM jobs)::integer jobs, (SELECT count(*) FROM agent_runs)::integer runs, (SELECT count(*) FROM tickets)::integer tickets")).rows[0]).toEqual(before);
  });

  test("keeps session endpoints shared while protecting admin routes", async () => {
    expect((await callRoute("/api/admin/tickets")).status).toBe(401);
    expect((await callRoute("/api/admin/tickets", { ...reporterSession, method: "POST" })).status).toBe(403);
    expect((await callRoute("/api/admin/tickets", { ...reporterSession, method: "POST", csrf: "bad" })).status).toBe(403);
    expect((await callRoute("/api/session", reporterSession)).body).toEqual({ user: { id: expect.any(String), username: "boundary-reporter", role: "reporter" } });
    expect((await callRoute("/api/admin/tickets", adminSession)).status).toBe(200);
    expect((await callRoute("/api/logout", { ...reporterSession, method: "POST", csrf: reporterSession.csrf })).status).toBe(200);
    reporterSession = await createTestSession(pool, (await pool.query("SELECT id FROM users WHERE username='boundary-reporter'")).rows[0].id);
    await pool.query("UPDATE users SET is_active=false WHERE username='boundary-reporter'");
    expect((await callRoute("/api/admin/tickets", reporterSession)).status).toBe(401);
  });
});
