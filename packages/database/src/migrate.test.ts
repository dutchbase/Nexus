import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pg from "pg";

process.env.DATABASE_URL ??= "postgres://unused:unused@127.0.0.1:1/unused";
const { migrate, validateMigrations } = await import("./migrate.js");

describe("validateMigrations", () => {
  it("rejects invalid filenames", () => {
    expect(() => validateMigrations(["foundation.sql"], [])).toThrow("invalid migration filename foundation.sql");
  });

  it("rejects duplicate migration prefixes", () => {
    expect(() => validateMigrations(["001_foundation.sql", "001_duplicate.sql"], [])).toThrow("duplicate migration prefix 001");
  });

  it("rejects pending prefixes at or below applied history", () => {
    expect(() => validateMigrations(["002_late.sql"], ["003_applied.sql"])).toThrow("pending migration prefix 002 is not greater than applied maximum 3");
  });

  it("recognizes the renamed migration through its legacy applied name", () => {
    expect(() => validateMigrations(["017_project_agent_start_path.sql"], ["015_project_agent_start_path.sql"])).not.toThrow();
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
      expect((await client.query("SELECT to_regclass($q$should_not_exist$q$) AS table_name")).rows[0].table_name).toBeNull();
    } finally {
      await client.end();
    }
  });

  it("rejects historical ordering before migration bookkeeping DDL", async () => {
    const client = new pg.Client({ connectionString: testDatabaseUrl });
    await client.connect();
    try {
      await client.query("CREATE TABLE schema_migrations (name text PRIMARY KEY)");
      await client.query("INSERT INTO schema_migrations (name) VALUES ($q$003_applied.sql$q$)");
    } finally {
      await client.end();
    }
    await writeFile(join(migrationDirectory, "002_late.sql"), "CREATE TABLE should_not_exist (id integer);");
    await expect(migrate({ connectionString: testDatabaseUrl!, directory: migrationDirectory })).rejects.toThrow("pending migration prefix 002");
    const verify = new pg.Client({ connectionString: testDatabaseUrl });
    await verify.connect();
    try {
      expect((await verify.query("SELECT to_regclass($q$migration_attempts$q$) AS table_name")).rows[0].table_name).toBeNull();
      expect((await verify.query("SELECT to_regclass($q$should_not_exist$q$) AS table_name")).rows[0].table_name).toBeNull();
    } finally {
      await verify.end();
    }
  });

  it("skips the renamed migration when its legacy name is applied", async () => {
    const client = new pg.Client({ connectionString: testDatabaseUrl });
    await client.connect();
    try {
      await client.query("CREATE TABLE schema_migrations (name text PRIMARY KEY)");
      await client.query("INSERT INTO schema_migrations (name) VALUES ($q$015_project_agent_start_path.sql$q$)");
    } finally {
      await client.end();
    }
    await writeFile(join(migrationDirectory, "017_project_agent_start_path.sql"), "CREATE TABLE should_not_exist (id integer);");
    await migrate({ connectionString: testDatabaseUrl!, directory: migrationDirectory });
    const verify = new pg.Client({ connectionString: testDatabaseUrl });
    await verify.connect();
    try {
      expect((await verify.query("SELECT to_regclass($q$should_not_exist$q$) AS table_name")).rows[0].table_name).toBeNull();
    } finally {
      await verify.end();
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

  it("allows live cancellation statuses", async () => {
    await cp(new URL("../migrations/", import.meta.url), migrationDirectory, { recursive: true });
    await migrate({ connectionString: testDatabaseUrl!, directory: migrationDirectory });
    const client = new pg.Client({ connectionString: testDatabaseUrl });
    await client.connect();
    try {
      const projectId = (await client.query("INSERT INTO projects (slug,name,repository_path) VALUES ($q$project$q$,$q$Project$q$,$q$/tmp/project$q$) RETURNING id")).rows[0].id;
      const ticketId = (await client.query("INSERT INTO tickets (ticket_number,project_id,title,status) VALUES ($q$T-1$q$,$1,$q$Ticket$q$,$q$Cancelled$q$) RETURNING id", [projectId])).rows[0].id;
      await client.query("INSERT INTO jobs (type,status,idempotency_key) VALUES ($q$test$q$,$q$cancelled$q$,$q$cancelled-job$q$)");
      const planId = (await client.query("INSERT INTO plans (ticket_id) VALUES ($1) RETURNING id", [ticketId])).rows[0].id;
      const planVersionId = (await client.query("INSERT INTO plan_versions (plan_id,version,content_markdown,content_hash) VALUES ($1,1,$q$x$q$,encode(digest($q$x$q$,$q$sha256$q$),$q$hex$q$)) RETURNING id", [planId])).rows[0].id;
      await client.query("INSERT INTO execution_attempts (ticket_id,plan_version_id,attempt_number,validation_status) VALUES ($1,$2,1,$q$cancelled$q$)", [ticketId, planVersionId]);
      await client.query("INSERT INTO execution_attempts (ticket_id,plan_version_id,attempt_number,validation_status) VALUES ($1,$2,2,$q$timed_out$q$)", [ticketId, planVersionId]);
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
      const projectId = (await client.query("INSERT INTO projects (slug,name,repository_path) VALUES ($q$invalid-project$q$,$q$Project$q$,$q$/tmp/project$q$) RETURNING id")).rows[0].id;
      const ticketId = (await client.query("INSERT INTO tickets (ticket_number,project_id,title,status) VALUES ($q$T-2$q$,$1,$q$Ticket$q$,$q$Submitted$q$) RETURNING id", [projectId])).rows[0].id;
      const planId = (await client.query("INSERT INTO plans (ticket_id) VALUES ($1) RETURNING id", [ticketId])).rows[0].id;
      const planVersionId = (await client.query("INSERT INTO plan_versions (plan_id,version,content_markdown,content_hash) VALUES ($1,1,$q$x$q$,encode(digest($q$x$q$,$q$sha256$q$),$q$hex$q$)) RETURNING id", [planId])).rows[0].id;
      await expect(client.query("INSERT INTO jobs (type,status,idempotency_key) VALUES ($q$test$q$,$q$invalid$q$,$q$invalid-job$q$)")).rejects.toThrow();
      await expect(client.query("INSERT INTO agent_runs (status) VALUES ($q$invalid$q$)")).rejects.toThrow();
      await expect(client.query("INSERT INTO notification_deliveries (status) VALUES ($q$invalid$q$)")).rejects.toThrow();
      await expect(client.query("UPDATE tickets SET status=$q$invalid$q$ WHERE id=$1", [ticketId])).rejects.toThrow();
      await expect(client.query("INSERT INTO execution_attempts (ticket_id,plan_version_id,attempt_number,validation_status) VALUES ($1,$2,1,$q$invalid$q$)", [ticketId, planVersionId])).rejects.toThrow();
      const eventId = (await client.query("INSERT INTO audit_events (actor_type,action) VALUES ($q$test$q$,$q$created$q$) RETURNING id")).rows[0].id;
      await expect(client.query("UPDATE audit_events SET action=$q$changed$q$ WHERE id=$1", [eventId])).rejects.toThrow();
    } finally {
      await client.end();
    }
  });
});
