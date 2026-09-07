import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

const testDatabaseUrl = process.env.DCC_TEST_DATABASE_URL;
process.env.DATABASE_URL = testDatabaseUrl ?? "postgres://unused:unused@127.0.0.1:1/unused";
const integration = testDatabaseUrl ? describe : describe.skip;
const { pool } = await import("@dcc/database");
const { migrate } = await import("../../../packages/database/src/migrate.ts");
const { markLoginAttemptSucceeded, reserveLoginAttempt } = await import("./login-quota.ts");

integration("login quota", () => {
  beforeAll(async () => {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await migrate({ connectionString: testDatabaseUrl! });
  });
  beforeEach(async () => { await pool.query("TRUNCATE login_attempts"); });
  afterAll(async () => { await pool.end(); });

  test("atomically reserves at most the threshold under concurrent requests", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => reserveLoginAttempt({
      username: "admin", ip: "192.0.2.1", threshold: 2, windowMinutes: 15,
    })));

    expect(results.filter((result) => "attemptId" in result)).toHaveLength(2);
    expect(results.filter((result) => "retryAfterSeconds" in result)).toHaveLength(6);
    expect(Number((await pool.query("SELECT count(*) FROM login_attempts")).rows[0].count)).toBe(2);
  });

  test("account quota applies across rotating IP addresses", async () => {
    await reserveLoginAttempt({ username: "admin", ip: "192.0.2.1", threshold: 2, windowMinutes: 15 });
    await reserveLoginAttempt({ username: "admin", ip: "192.0.2.2", threshold: 2, windowMinutes: 15 });

    const third = await reserveLoginAttempt({ username: "admin", ip: "192.0.2.3", threshold: 2, windowMinutes: 15 });

    expect(third).toHaveProperty("retryAfterSeconds");
    expect(Number((third as { retryAfterSeconds: number }).retryAfterSeconds)).toBeGreaterThanOrEqual(1);
  });

  test("a successful login marks only its reservation and preserves shared-IP failures", async () => {
    const alice = await reserveLoginAttempt({ username: "alice", ip: "192.0.2.1", threshold: 2, windowMinutes: 15 });
    const bob = await reserveLoginAttempt({ username: "bob", ip: "192.0.2.1", threshold: 2, windowMinutes: 15 });
    expect("attemptId" in alice && "attemptId" in bob).toBe(true);

    await markLoginAttemptSucceeded((bob as { attemptId: string }).attemptId);
    const charlie = await reserveLoginAttempt({ username: "charlie", ip: "192.0.2.1", threshold: 2, windowMinutes: 15 });
    const dave = await reserveLoginAttempt({ username: "dave", ip: "192.0.2.1", threshold: 2, windowMinutes: 15 });

    expect(charlie).toHaveProperty("attemptId");
    expect(dave).toHaveProperty("retryAfterSeconds");
    expect((await pool.query("SELECT username,succeeded FROM login_attempts ORDER BY username")).rows).toEqual([
      { username: "alice", succeeded: false },
      { username: "bob", succeeded: true },
      { username: "charlie", succeeded: false },
    ]);
  });
});
