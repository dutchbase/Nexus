import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pg from "pg";

process.env.DATABASE_URL ??= "postgres://unused:unused@127.0.0.1:1/unused";
const { migrate, validateMigrations } = await import("./migrate.js");

describe("validateMigrations", () => {
  it("rejects invalid and ambiguous names before any migration can run", () => {
    expect(() => validateMigrations(["001_foundation.sql", "001_duplicate.sql"], [])).toThrow("duplicate migration prefix 001");
    expect(() => validateMigrations(["foundation.sql"], [])).toThrow("invalid migration filename foundation.sql");
  });
});

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

integration("migrate", () => {
  beforeEach(async () => {
    await resetDatabase();
    migrationDirectory = await mkdtemp(join(tmpdir(), "dcc-migrations-"));
  });

  afterEach(async () => {
    if (migrationDirectory) await rm(migrationDirectory, { recursive: true, force: true });
  });

  it("serializes concurrent runners", async () => {
    await writeFile(join(migrationDirectory, "001_serialized.sql"), "SELECT pg_sleep(0.05); CREATE TABLE migration_lock_test (id integer);");
    await Promise.all([
      migrate({ connectionString: testDatabaseUrl!, directory: migrationDirectory }),
      migrate({ connectionString: testDatabaseUrl!, directory: migrationDirectory }),
    ]);
    const client = new pg.Client({ connectionString: testDatabaseUrl });
    await client.connect();
    try {
      expect((await client.query("SELECT COUNT(*)::int AS count FROM schema_migrations")).rows[0].count).toBe(1);
    } finally {
      await client.end();
    }
  });

  it("rejects invalid filenames before DDL", async () => {
    await writeFile(join(migrationDirectory, "invalid.sql"), "CREATE TABLE should_not_exist (id integer);");
    await expect(migrate({ connectionString: testDatabaseUrl!, directory: migrationDirectory })).rejects.toThrow("invalid migration filename");
    const client = new pg.Client({ connectionString: testDatabaseUrl });
    await client.connect();
    try {
      expect((await client.query("SELECT to_regclass('should_not_exist') AS table_name")).rows[0].table_name).toBeNull();
    } finally {
      await client.end();
    }
  });

  it("records failed migration attempts outside the DDL transaction", async () => {
    await writeFile(join(migrationDirectory, "001_fail.sql"), "CREATE TABLE ddl_rollback (id integer); SELECT 1/0;");
    await expect(migrate({ connectionString: testDatabaseUrl!, directory: migrationDirectory })).rejects.toThrow();
    const client = new pg.Client({ connectionString: testDatabaseUrl });
    await client.connect();
    try {
      const result = await client.query("SELECT status, finished_at, error_text FROM migration_attempts");
      expect(result.rows[0]).toMatchObject({ status: "failed" });
      expect(result.rows[0].finished_at).toBeTruthy();
      expect(result.rows[0].error_text).toBeTruthy();
    } finally {
      await client.end();
    }
  });

  it("enforces lifecycle statuses and append-only audit events", async () => {
    await cp(new URL("../migrations/", import.meta.url), migrationDirectory, { recursive: true });
    await migrate({ connectionString: testDatabaseUrl!, directory: migrationDirectory });
    const client = new pg.Client({ connectionString: testDatabaseUrl });
    await client.connect();
    try {
      await expect(client.query("INSERT INTO jobs (type,status, idempotency_key) VALUES ($q$test$q$, $q$invalid$q$, $q$kfml$q$)")).rejects.toThrow();
      const eventId = (await client.query("INSERT INTO audit_events (actor_type, action) VALUES ('test', 'created') RETURNING id")).rows[0].id;
      await expect(client.query("UPDATE audit_events SET action='changed' WHERE id=$1", [eventId])).rejects.toThrow();
    } finally {
      await client.end();
    }
  });
});
