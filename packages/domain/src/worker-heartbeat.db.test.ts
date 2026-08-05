import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pg from "pg";

process.env.DATABASE_URL = process.env.DCC_TEST_DATABASE_URL ?? "postgres://unused:unused@127.0.0.1:1/unused";
const { migrate } = await import("../../database/src/migrate.ts");
const { recordWorkerHeartbeat } = await import("./index.ts");

const testDatabaseUrl = process.env.DCC_TEST_DATABASE_URL;
const integration = testDatabaseUrl ? describe : describe.skip;
let migrationDirectory = "";

async function resetDatabase() {
  const client = new pg.Client({ connectionString: testDatabaseUrl });
  await client.connect();
  try {
    await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  } finally {
    await client.end();
  }
}

integration("recordWorkerHeartbeat", () => {
  beforeAll(async () => {
    migrationDirectory = await mkdtemp(join(tmpdir(), "dcc-worker-heartbeat-"));
    await cp(new URL("../../database/migrations/", import.meta.url), migrationDirectory, { recursive: true });
  });

  beforeEach(async () => {
    await resetDatabase();
    await migrate({ connectionString: testDatabaseUrl!, directory: migrationDirectory });
  });

  afterAll(async () => {
    if (migrationDirectory) await rm(migrationDirectory, { recursive: true, force: true });
  });

  it("upserts and advances heartbeat_at", async () => {
    const client = new pg.Client({ connectionString: testDatabaseUrl });
    await client.connect();
    try {
      await recordWorkerHeartbeat("worker-1", ["execution.run"], "1.0");
      const first = (await client.query("SELECT * FROM workers WHERE id=$1", ["worker-1"])).rows;
      expect(first).toHaveLength(1);
      expect(first[0].capabilities).toEqual(["execution.run"]);
      expect(first[0].version).toBe("1.0");
      const firstHeartbeatAt = new Date(first[0].heartbeat_at).getTime();

      await new Promise((resolve) => setTimeout(resolve, 20));
      await recordWorkerHeartbeat("worker-1", ["execution.run", "planning.generate"], "1.1");

      const rows = (await client.query("SELECT * FROM workers WHERE id=$1", ["worker-1"])).rows;
      expect(rows).toHaveLength(1);
      expect(rows[0].capabilities).toEqual(["execution.run", "planning.generate"]);
      expect(rows[0].version).toBe("1.1");
      expect(new Date(rows[0].heartbeat_at).getTime()).toBeGreaterThanOrEqual(firstHeartbeatAt);
    } finally {
      await client.end();
    }
  });
});
