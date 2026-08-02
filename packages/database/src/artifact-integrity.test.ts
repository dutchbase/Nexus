import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { readArtifact } from "./artifacts.ts";

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
        "INSERT INTO artifacts (id,storage_path,artifact_type,status,expires_at,agent_run_id,execution_attempt_id) VALUES (gen_random_uuid(),$q$worktrees/invalid.tar$q$,$q$worktree$q$,$q$staged$q$,now() + interval $q$1 hour$q$,$1,$2)",
        [otherRunId, attemptId],
      )).rejects.toThrow("worktree artifacts require matching run and execution attempt owners");

      const artifactId = (await client.query(
        "INSERT INTO artifacts (id,storage_path,artifact_type,status,expires_at,agent_run_id,execution_attempt_id) VALUES (gen_random_uuid(),$q$logs/valid.log$q$,$q$execution_log$q$,$q$staged$q$,now() + interval $q$1 hour$q$,$1,$2) RETURNING id",
        [runId, attemptId],
      )).rows[0].id;
      await client.query("UPDATE execution_attempts SET agent_run_id=$1 WHERE id=$2", [otherRunId, attemptId]);
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

  it("backfills and serves a pre-022 controlled legacy execution log", async () => {
    await resetDatabase();
    const migrationName = "022_historic_execution_log_artifacts.sql";
    await rm(join(migrationDirectory, migrationName));
    await migrate({ connectionString: testDatabaseUrl!, directory: migrationDirectory });
    const root = await mkdtemp(join(tmpdir(), "dcc-legacy-log-"));
    const runId = randomUUID();
    const storagePath = `logs/${runId}.log`;
    const legacyPath = `/legacy/data/${storagePath}`;
    const client = new pg.Client({ connectionString: testDatabaseUrl });
    await client.connect();
    try {
      await client.query(
        "INSERT INTO agent_runs (id,status,metadata_json) VALUES ($1,$q$completed$q$,jsonb_build_object($q$log_path$q$,$2))",
        [runId, legacyPath],
      );
      await mkdir(join(root, "logs"), { recursive: true });
      await writeFile(join(root, storagePath), "legacy execution output");

      await cp(new URL("../migrations/022_historic_execution_log_artifacts.sql", import.meta.url), join(migrationDirectory, migrationName));
      await migrate({ connectionString: testDatabaseUrl!, directory: migrationDirectory });

      const row = (await client.query(
        `SELECT ar.id,a.storage_path,a.status FROM agent_runs ar
         JOIN artifacts a ON a.agent_run_id=ar.id AND a.artifact_type=$q$execution_log$q$ AND a.status IN ($q$staged$q$,$q$finalized$q$)
         WHERE ar.id=$1`,
        [runId],
      )).rows[0];
      expect(row).toMatchObject({ id: runId, storage_path: storagePath, status: "staged" });
      await expect(readArtifact(root, row.storage_path).then((content) => content.toString("utf8"))).resolves.toBe("legacy execution output");
    } finally {
      await client.end();
      await rm(root, { recursive: true, force: true });
    }
  });

});
