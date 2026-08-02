import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pg from "pg";

process.env.DATABASE_URL ??= "postgres://unused:unused@127.0.0.1:1/unused";
const { migrate } = await import("./migrate.js");

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

integration("artifact integrity migration", () => {
  beforeAll(async () => {
    migrationDirectory = await mkdtemp(join(tmpdir(), "dcc-artifact-integrity-"));
    await cp(new URL("../migrations/", import.meta.url), migrationDirectory, { recursive: true });
  });

  beforeEach(async () => {
    await resetDatabase();
    await migrate({ connectionString: testDatabaseUrl!, directory: migrationDirectory });
  });

  afterAll(async () => {
    if (migrationDirectory) await rm(migrationDirectory, { recursive: true, force: true });
  });

  it("requires valid owners and only permits forward lifecycle changes", async () => {
    const client = new pg.Client({ connectionString: testDatabaseUrl });
    await client.connect();
    try {
      const projectId = (await client.query(
        "INSERT INTO projects (slug,name,repository_path) VALUES ($q$artifact-project$q$,$q$Project$q$,$q$/tmp/project$q$) RETURNING id",
      )).rows[0].id;
      const ticketId = (await client.query(
        "INSERT INTO tickets (ticket_number,project_id,title,status) VALUES ($q$A-1$q$,$1,$q$Artifact ticket$q$,$q$Submitted$q$) RETURNING id",
        [projectId],
      )).rows[0].id;
      const planId = (await client.query("INSERT INTO plans (ticket_id) VALUES ($1) RETURNING id", [ticketId])).rows[0].id;
      const planVersionId = (await client.query(
        "INSERT INTO plan_versions (plan_id,version,content_markdown,content_hash) VALUES ($1,1,$q$x$q$,encode(digest($q$x$q$,$q$sha256$q$),$q$hex$q$)) RETURNING id",
        [planId],
      )).rows[0].id;
      const runId = (await client.query("INSERT INTO agent_runs (status) VALUES ($q$running$q$) RETURNING id")).rows[0].id;
      const otherRunId = (await client.query("INSERT INTO agent_runs (status) VALUES ($q$running$q$) RETURNING id")).rows[0].id;
      const attemptId = (await client.query(
        "INSERT INTO execution_attempts (ticket_id,plan_version_id,agent_run_id,attempt_number,validation_status) VALUES ($1,$2,$3,1,$q$executing$q$) RETURNING id",
        [ticketId, planVersionId, runId],
      )).rows[0].id;
      const uploadId = (await client.query(
        "INSERT INTO uploads (storage_path,media_type,size_bytes) VALUES ($q$uploads/image.png$q$,$q$image/png$q$,1) RETURNING id",
      )).rows[0].id;

      await client.query(
        "INSERT INTO artifacts (id,storage_path,artifact_type,status,expires_at,upload_id) VALUES (gen_random_uuid(),$q$uploads/image.png$q$,$q$upload$q$,$q$staged$q$,now() + interval $q$1 hour$q$,$1)",
        [uploadId],
      );
      await expect(client.query(
        "INSERT INTO artifacts (id,storage_path,artifact_type,status,expires_at,upload_id,agent_run_id) VALUES (gen_random_uuid(),$q$uploads/invalid.png$q$,$q$upload$q$,$q$staged$q$,now() + interval $q$1 hour$q$,$1,$2)",
        [uploadId, runId],
      )).rejects.toThrow("upload artifacts require only an upload owner");
      await expect(client.query(
        "INSERT INTO artifacts (id,storage_path,artifact_type,status,expires_at,agent_run_id,execution_attempt_id) VALUES (gen_random_uuid(),$q$logs/invalid.log$q$,$q$execution_log$q$,$q$staged$q$,now() + interval $q$1 hour$q$,$1,$2)",
        [otherRunId, attemptId],
      )).rejects.toThrow("run artifacts require matching run and execution attempt owners");

      const artifactId = (await client.query(
        "INSERT INTO artifacts (id,storage_path,artifact_type,status,expires_at,agent_run_id,execution_attempt_id) VALUES (gen_random_uuid(),$q$logs/valid.log$q$,$q$execution_log$q$,$q$staged$q$,now() + interval $q$1 hour$q$,$1,$2) RETURNING id",
        [runId, attemptId],
      )).rows[0].id;
      await client.query(
        "UPDATE artifacts SET status=$q$finalized$q$,sha256=repeat($q$a$q$,64),expires_at=NULL,finalized_at=now() WHERE id=$1",
        [artifactId],
      );
      await expect(client.query(
        "UPDATE artifacts SET status=$q$staged$q$,sha256=NULL,expires_at=now() + interval $q$1 hour$q$,finalized_at=NULL WHERE id=$1",
        [artifactId],
      )).rejects.toThrow("artifact lifecycle cannot move backward");
    } finally {
      await client.end();
    }
  });
});
