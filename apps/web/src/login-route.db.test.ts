import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

const testDatabaseUrl = process.env.DCC_TEST_DATABASE_URL;
process.env.DATABASE_URL = testDatabaseUrl ?? "postgres://unused:unused@127.0.0.1:1/unused";
process.env.DCC_PROCESS_ROLE = "web";
const integration = testDatabaseUrl ? describe : describe.skip;
const { pool } = await import("@dcc/database");
const { migrate } = await import("../../../packages/database/src/migrate.ts");
const { hashPassword } = await import("../../../packages/database/src/password.ts");

function request(body: unknown, cookie?: string, csrf?: string) {
  return {
    method: "POST", url: cookie ? "/api/admin/logout" : "/api/admin/login",
    headers: { host: "test", ...(cookie ? { cookie } : {}), ...(csrf ? { "x-csrf-token": csrf } : {}) },
    socket: { remoteAddress: "192.0.2.10" },
    async *[Symbol.asyncIterator]() { if (!cookie) yield Buffer.from(JSON.stringify(body)); },
  } as any;
}

function response() {
  return { writeHead: vi.fn(), end: vi.fn() } as any;
}

integration("login route", () => {
  beforeAll(async () => {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await migrate({ connectionString: testDatabaseUrl! });
  });
  afterAll(async () => { await pool.end(); });

  test("creates a normal session whose CSRF token authorizes logout", async () => {
    await pool.query(
      "INSERT INTO users (username,password_hash) VALUES ('admin',$1)",
      [await hashPassword("correct horse")],
    );
    const { route } = await import("./server.ts");
    const login = response();
    await route(request({ username: "admin", password: "correct horse" }), login);

    expect(login.writeHead.mock.calls[0][0]).toBe(200);
    const body = JSON.parse(login.end.mock.calls[0][0]);
    expect(body.csrfToken).toBeTruthy();
    const cookies = login.writeHead.mock.calls[0][1]["set-cookie"] as string[];
    const session = cookies.find((value) => value.startsWith("dcc_session="))!.split(";")[0];

    const logout = response();
    await route(request({}, session, body.csrfToken), logout);
    expect(logout.writeHead.mock.calls[0][0]).toBe(200);
    expect(JSON.parse(logout.end.mock.calls[0][0])).toEqual({ ok: true });
    expect((await pool.query("SELECT succeeded FROM login_attempts WHERE username='admin'")).rows).toEqual([{ succeeded: true }]);
  });

  test("unknown users receive the same generic credential error", async () => {
    const { route } = await import("./server.ts");
    const failed = response();
    await route(request({ username: "missing", password: "wrong" }), failed);
    expect(failed.writeHead.mock.calls[0][0]).toBe(401);
    expect(JSON.parse(failed.end.mock.calls[0][0])).toEqual({ error: "invalid credentials" });
  });
});
