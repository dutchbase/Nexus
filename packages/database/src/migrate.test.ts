import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pg from "pg";
import * as approvalTransitions from "../../domain/src/approval-input-snapshot.ts";

process.env.DATABASE_URL ??= "postgres://unused:unused@127.0.0.1:1/unused";
const { migrate, validateMigrations } = await import("./migrate.js");

describe("validateMigrations", () => {
  it("accepts the repository migration directory", async () => {
    await expect(readdir(new URL("../migrations/", import.meta.url)).then((names) => validateMigrations(names, []))).resolves.toBeUndefined();
  });

  it("includes the durable workflow-state migration", async () => {
    await expect(readdir(new URL("../migrations/", import.meta.url))).resolves.toContain("037_workflow_state.sql");
  });

  it("includes the durable deployment safety migration", async () => {
    await expect(readdir(new URL("../migrations/", import.meta.url))).resolves.toContain("042_deployment_safety.sql");
  });

  it("seeds the approved Fable token rates", async () => {
    const migration = await readFile(new URL("../migrations/050_ai_invocation_accounting.sql", import.meta.url), "utf8");
    expect(migration).toContain("('fable','anthropic','2026-08-08T00:00:00Z',10,50,12.5,1,'https://platform.claude.com/docs/en/about-claude/pricing')");
  });

  it("includes rejected deployment history without weakening active SHA deduplication", async () => {
    await expect(readdir(new URL("../migrations/", import.meta.url))).resolves.toContain("044_deployment_rejection_history.sql");
  });

  it("backfills expiry for existing terminal execution worktrees", async () => {
    const migration = await readFile(new URL("../migrations/038_execution_safety.sql", import.meta.url), "utf8");
    expect(migration).toContain("UPDATE execution_attempts");
    expect(migration).toContain("SET worktree_expires_at = now() + interval '1 day'");
    expect(migration).toContain("worktree_path IS NOT NULL");
    expect(migration).toContain("validation_status IN ('completed','published','failed','pr_creation_failed','cancelled','timed_out')");
  });

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
    expect(() => validateMigrations(["019_project_agent_start_path.sql"], ["015_project_agent_start_path.sql"])).not.toThrow();
  });

  it("permits the known follow-up migration after legacy project start path", () => {
    expect(() => validateMigrations(["015_follow_up_ticket_prompt.sql"], ["015_project_agent_start_path.sql"])).not.toThrow();
  });

  it("rejects other pending 015 migrations after legacy project start path", () => {
    expect(() => validateMigrations(["015_unrelated.sql"], ["015_project_agent_start_path.sql"])).toThrow("pending migration prefix 015 is not greater than applied maximum 15");
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

async function createDecisionFixture(client: pg.Client, key: string) {
  const project = (await client.query("INSERT INTO projects (slug,name,repository_path) VALUES ($1,$2,$q$/tmp/project$q$) RETURNING *", [`race-${key}`, `Race ${key}`])).rows[0];
  const ticket = (await client.query("INSERT INTO tickets (ticket_number,project_id,title,status) VALUES ($1,$2,$q$Ticket$q$,$q$Plan Ready for Review$q$) RETURNING *,updated_at::text ticket_version", [`RACE-${key.toUpperCase()}`, project.id])).rows[0];
  const planId = (await client.query("INSERT INTO plans (ticket_id) VALUES ($1) RETURNING id", [ticket.id])).rows[0].id;
  const planVersion = (await client.query("INSERT INTO plan_versions (plan_id,version,content_markdown,content_hash) VALUES ($1,1,$q$x$q$,encode(digest($q$x$q$,$q$sha256$q$),$q$hex$q$)) RETURNING *", [planId])).rows[0];
  await client.query("UPDATE plans SET current_version_id=$2 WHERE id=$1", [planId, planVersion.id]);
  const approvedInput = {
    plan: { versionId: planVersion.id, version: 1, contentHash: planVersion.content_hash },
    ticket: { title: ticket.title }, project: { configVersion: project.config_version, config: {} },
    models: {}, prompts: [], skills: [], policySources: [],
  } as const;
  return { project, ticket, planId, planVersion, approvedInput };
}

integration("migrate", () => {
  beforeEach(async () => {
    await resetDatabase();
    migrationDirectory = await mkdtemp(join(tmpdir(), "dcc-migrations-"));
  });

  afterEach(async () => {
    if (migrationDirectory) await rm(migrationDirectory, { recursive: true, force: true });
  });

  it("stores immutable GitHub policy snapshots and repository freshness", async () => {
    await cp(new URL("../migrations/", import.meta.url), migrationDirectory, { recursive: true });
    await migrate({ connectionString: testDatabaseUrl!, directory: migrationDirectory });
    const client = new pg.Client({ connectionString: testDatabaseUrl });
    await client.connect();
    try {
      const projectId = (await client.query("INSERT INTO projects (slug,name,repository_path) VALUES ($q$github-policy$q$,$q$GitHub policy$q$,$q$/tmp/project$q$) RETURNING id")).rows[0].id;
      const pullRequestId = (await client.query("INSERT INTO pull_requests (project_id) VALUES ($1) RETURNING id", [projectId])).rows[0].id;
      const snapshot = (await client.query(
        `INSERT INTO pull_request_policy_snapshots
         (pull_request_id,material_json,material_hash,head_sha,base_ref,review_state,check_state,refusal_codes,complete,source,fetched_at)
         VALUES ($1,$2,encode(digest(canonical_jsonb($2::jsonb),'sha256'),'hex'),'head','main','approved','success','[]',true,'github',now()) RETURNING id`,
        [pullRequestId, { protected: true }],
      )).rows[0];
      await client.query("UPDATE pull_requests SET current_policy_snapshot_id=$2,policy_complete=true,policy_stale=false WHERE id=$1", [pullRequestId, snapshot.id]);
      await client.query("INSERT INTO github_repository_sync_state (project_id,complete,last_attempted_at,last_completed_at) VALUES ($1,true,now(),now())", [projectId]);

      await expect(client.query("UPDATE pull_request_policy_snapshots SET review_state='pending' WHERE id=$1", [snapshot.id])).rejects.toThrow("immutable");
      expect((await client.query("SELECT current_policy_snapshot_id,policy_complete,policy_stale FROM pull_requests WHERE id=$1", [pullRequestId])).rows[0])
        .toEqual({ current_policy_snapshot_id: snapshot.id, policy_complete: true, policy_stale: false });
    } finally {
      await client.end();
    }
  });

  it("seeds optional fresh policy binding and permits unbound merged attempts", async () => {
    await cp(new URL("../migrations/", import.meta.url), migrationDirectory, { recursive: true });
    await migrate({ connectionString: testDatabaseUrl!, directory: migrationDirectory });
    const client = new pg.Client({ connectionString: testDatabaseUrl });
    await client.connect();
    try {
      expect((await client.query("SELECT require_fresh_policy_binding FROM pull_request_merge_settings WHERE id=1")).rows[0])
        .toEqual({ require_fresh_policy_binding: false });
      const projectId = (await client.query("INSERT INTO projects (slug,name,repository_path) VALUES ($q$unbound-merge$q$,$q$Unbound merge$q$,$q$/tmp/project$q$) RETURNING id")).rows[0].id;
      const pullRequestId = (await client.query("INSERT INTO pull_requests (project_id) VALUES ($1) RETURNING id", [projectId])).rows[0].id;
      const jobId = (await client.query("INSERT INTO jobs (type,idempotency_key) VALUES ($q$merge$q$,$q$unbound-merged-attempt$q$) RETURNING id")).rows[0].id;

      const attempt = await client.query(
        "INSERT INTO pull_request_merge_attempts (job_id,pull_request_id,expected_head_sha,merged_head_sha,merged_sha,state,actor_type,actor_id) VALUES ($1,$2,$q$head$q$,$q$head$q$,$q$merge$q$,$q$merged$q$,$q$worker$q$,$q$worker-1$q$) RETURNING expected_policy_snapshot_id,verified_policy_snapshot_id",
        [jobId, pullRequestId],
      );
      expect(attempt.rows).toEqual([{ expected_policy_snapshot_id: null, verified_policy_snapshot_id: null }]);
    } finally {
      await client.end();
    }
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

  it("rejects approved input snapshots whose hash does not match canonical JSON", async () => {
    await cp(new URL("../migrations/", import.meta.url), migrationDirectory, { recursive: true });
    await migrate({ connectionString: testDatabaseUrl!, directory: migrationDirectory });
    const client = new pg.Client({ connectionString: testDatabaseUrl });
    await client.connect();
    try {
      const projectId = (await client.query("INSERT INTO projects (slug,name,repository_path) VALUES ($q$approval-hash$q$,$q$Approval hash$q$,$q$/tmp/project$q$) RETURNING id")).rows[0].id;
      const ticketId = (await client.query("INSERT INTO tickets (ticket_number,project_id,title,status) VALUES ($q$AH-1$q$,$1,$q$Ticket$q$,$q$Submitted$q$) RETURNING id", [projectId])).rows[0].id;
      const planId = (await client.query("INSERT INTO plans (ticket_id) VALUES ($1) RETURNING id", [ticketId])).rows[0].id;
      const planVersionId = (await client.query("INSERT INTO plan_versions (plan_id,version,content_markdown,content_hash) VALUES ($1,1,$q$x$q$,encode(digest($q$x$q$,$q$sha256$q$),$q$hex$q$)) RETURNING id", [planId])).rows[0].id;
      await client.query("INSERT INTO approved_input_snapshots (ticket_id,plan_version_id,material_input_json,input_hash) VALUES ($1,$2,$q${\"a\":1}$q$,$q$015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862$q$)", [ticketId, planVersionId]);
      await expect(client.query("INSERT INTO approved_input_snapshots (ticket_id,plan_version_id,material_input_json,input_hash) VALUES ($1,$2,$q${\"a\":1}$q$,repeat($q$0$q$,64))", [ticketId, planVersionId])).rejects.toThrow("approved input hash does not match canonical material input");
    } finally {
      await client.end();
    }
  });

  it("accepts the Node hash for exponent-form JSON numbers", async () => {
    await cp(new URL("../migrations/", import.meta.url), migrationDirectory, { recursive: true });
    await migrate({ connectionString: testDatabaseUrl!, directory: migrationDirectory });
    const client = new pg.Client({ connectionString: testDatabaseUrl });
    await client.connect();
    try {
      const projectId = (await client.query("INSERT INTO projects (slug,name,repository_path) VALUES ($q$exponent$q$,$q$Exponent$q$,$q$/tmp/project$q$) RETURNING id")).rows[0].id;
      const ticketId = (await client.query("INSERT INTO tickets (ticket_number,project_id,title,status) VALUES ($q$EXP-1$q$,$1,$q$Ticket$q$,$q$Submitted$q$) RETURNING id", [projectId])).rows[0].id;
      const planId = (await client.query("INSERT INTO plans (ticket_id) VALUES ($1) RETURNING id", [ticketId])).rows[0].id;
      const planVersionId = (await client.query("INSERT INTO plan_versions (plan_id,version,content_markdown,content_hash) VALUES ($1,1,$q$x$q$,encode(digest($q$x$q$,$q$sha256$q$),$q$hex$q$)) RETURNING id", [planId])).rows[0].id;
      const built = approvalTransitions.buildApprovedInputSnapshot({
        plan: { versionId: planVersionId, version: 1, contentHash: "x".repeat(64) },
        ticket: { threshold: 1e-7 }, project: { configVersion: 1, config: {} },
        models: {}, prompts: [], skills: [], policySources: [],
      });
      await expect(client.query(
        "INSERT INTO approved_input_snapshots (ticket_id,plan_version_id,material_input_json,input_hash) VALUES ($1,$2,$3,$4)",
        [ticketId, planVersionId, built.materialInput, built.inputHash],
      )).resolves.toBeDefined();
    } finally {
      await client.end();
    }
  });

  it("returns cleared legacy approvals to the existing plan-review state", async () => {
    await cp(new URL("../migrations/", import.meta.url), migrationDirectory, { recursive: true });
    await Promise.all((await readdir(migrationDirectory))
      .filter((name) => Number(name.slice(0, 3)) >= 36)
      .map((name) => rm(join(migrationDirectory, name))));
    await migrate({ connectionString: testDatabaseUrl!, directory: migrationDirectory });
    const client = new pg.Client({ connectionString: testDatabaseUrl });
    await client.connect();
    try {
      const projectId = (await client.query("INSERT INTO projects (slug,name,repository_path) VALUES ($q$legacy-review$q$,$q$Legacy review$q$,$q$/tmp/project$q$) RETURNING id")).rows[0].id;
      const ticketId = (await client.query("INSERT INTO tickets (ticket_number,project_id,title,status) VALUES ($q$LEGACY-1$q$,$1,$q$Ticket$q$,$q$Plan Approved$q$) RETURNING id", [projectId])).rows[0].id;
      const planId = (await client.query("INSERT INTO plans (ticket_id) VALUES ($1) RETURNING id", [ticketId])).rows[0].id;
      const versionId = (await client.query("INSERT INTO plan_versions (plan_id,version,content_markdown,content_hash) VALUES ($1,1,$q$x$q$,encode(digest($q$x$q$,$q$sha256$q$),$q$hex$q$)) RETURNING id", [planId])).rows[0].id;
      await client.query("UPDATE plans SET current_version_id=$2 WHERE id=$1", [planId, versionId]);
    } finally {
      await client.end();
    }
    await cp(new URL("../migrations/036_legacy_approval_review_state.sql", import.meta.url), join(migrationDirectory, "036_legacy_approval_review_state.sql"));
    await migrate({ connectionString: testDatabaseUrl!, directory: migrationDirectory });
    const verify = new pg.Client({ connectionString: testDatabaseUrl });
    await verify.connect();
    try {
      expect((await verify.query("SELECT status FROM tickets WHERE ticket_number='LEGACY-1'")).rows[0].status).toBe("Plan Ready for Review");
    } finally {
      await verify.end();
    }
  });

  it("invalidates approvals for imported material project changes but not validation updates", async () => {
    await cp(new URL("../migrations/", import.meta.url), migrationDirectory, { recursive: true });
    await migrate({ connectionString: testDatabaseUrl!, directory: migrationDirectory });
    const client = new pg.Client({ connectionString: testDatabaseUrl });
    await client.connect();
    try {
      const project = (await client.query("INSERT INTO projects (slug,name,repository_path) VALUES ($q$imported$q$,$q$Imported$q$,$q$/tmp/old$q$) RETURNING *")).rows[0];
      const ticketId = (await client.query("INSERT INTO tickets (ticket_number,project_id,title,status) VALUES ($q$IMP-1$q$,$1,$q$Ticket$q$,$q$Plan Approved$q$) RETURNING id", [project.id])).rows[0].id;
      const planId = (await client.query("INSERT INTO plans (ticket_id) VALUES ($1) RETURNING id", [ticketId])).rows[0].id;
      const planVersionId = (await client.query("INSERT INTO plan_versions (plan_id,version,content_markdown,content_hash) VALUES ($1,1,$q$x$q$,encode(digest($q$x$q$,$q$sha256$q$),$q$hex$q$)) RETURNING id", [planId])).rows[0].id;
      await client.query("UPDATE plans SET current_version_id=$2 WHERE id=$1", [planId, planVersionId]);
      const snapshotId = (await client.query("INSERT INTO approved_input_snapshots (ticket_id,plan_version_id,material_input_json,input_hash) VALUES ($1,$2,$q${}$q$,$q$44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a$q$) RETURNING id", [ticketId, planVersionId])).rows[0].id;
      await client.query("UPDATE tickets SET approved_plan_version_id=$2,approved_input_snapshot_id=$3 WHERE id=$1", [ticketId, planVersionId, snapshotId]);

      await client.query("UPDATE projects SET health_status=$2,last_validated_at=now(),updated_at=now() WHERE id=$1", [project.id, "healthy"]);
      expect((await client.query("SELECT potentially_stale FROM plans WHERE id=$1", [planId])).rows[0].potentially_stale).toBe(false);

      await client.query("UPDATE projects SET repository_path=$2,updated_at=now() WHERE id=$1", [project.id, "/tmp/imported"]);
      expect((await client.query("SELECT config_version FROM projects WHERE id=$1", [project.id])).rows[0].config_version).toBe(project.config_version + 1);
      expect((await client.query("SELECT potentially_stale FROM plans WHERE id=$1", [planId])).rows[0].potentially_stale).toBe(true);
    } finally {
      await client.end();
    }
  });

  it("stales approvals for phase-required skill material changes and policy removal", async () => {
    await cp(new URL("../migrations/", import.meta.url), migrationDirectory, { recursive: true });
    await migrate({ connectionString: testDatabaseUrl!, directory: migrationDirectory });
    const client = new pg.Client({ connectionString: testDatabaseUrl });
    await client.connect();
    try {
      const projectId = (await client.query("INSERT INTO projects (slug,name,repository_path) VALUES ($q$skill-stale$q$,$q$Skill stale$q$,$q$/tmp/project$q$) RETURNING id")).rows[0].id;
      const ticketId = (await client.query("INSERT INTO tickets (ticket_number,project_id,title,status) VALUES ($q$SKILL-1$q$,$1,$q$Ticket$q$,$q$Plan Approved$q$) RETURNING id", [projectId])).rows[0].id;
      const planId = (await client.query("INSERT INTO plans (ticket_id) VALUES ($1) RETURNING id", [ticketId])).rows[0].id;
      const planVersionId = (await client.query("INSERT INTO plan_versions (plan_id,version,content_markdown,content_hash) VALUES ($1,1,$q$x$q$,encode(digest($q$x$q$,$q$sha256$q$),$q$hex$q$)) RETURNING id", [planId])).rows[0].id;
      await client.query("UPDATE plans SET current_version_id=$2 WHERE id=$1", [planId, planVersionId]);
      const snapshotId = (await client.query("INSERT INTO approved_input_snapshots (ticket_id,plan_version_id,material_input_json,input_hash) VALUES ($1,$2,$q${}$q$,$q$44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a$q$) RETURNING id", [ticketId, planVersionId])).rows[0].id;
      await client.query("UPDATE tickets SET approved_plan_version_id=$2,approved_input_snapshot_id=$3 WHERE id=$1", [ticketId, planVersionId, snapshotId]);
      const skillId = (await client.query("INSERT INTO skills (slug,name,version,configuration_json) VALUES ($q$phase-policy$q$,$q$Phase policy$q$,$q$1$q$,$q${\"required_phases\":[\"planning\"]}$q$) RETURNING id")).rows[0].id;

      for (const update of [
        "version='2'",
        "content_hash=repeat('a',64)",
        "enabled=false",
      ]) {
        await client.query("UPDATE plans SET potentially_stale=false WHERE id=$1", [planId]);
        await client.query(`UPDATE skills SET ${update} WHERE id=$1`, [skillId]);
        expect((await client.query("SELECT potentially_stale FROM plans WHERE id=$1", [planId])).rows[0].potentially_stale).toBe(true);
      }

      await client.query("UPDATE plans SET potentially_stale=false WHERE id=$1", [planId]);
      await client.query("UPDATE skills SET configuration_json='{}'::jsonb WHERE id=$1", [skillId]);
      expect((await client.query("SELECT potentially_stale FROM plans WHERE id=$1", [planId])).rows[0].potentially_stale).toBe(true);

      await client.query("UPDATE skills SET configuration_json='{\"mandatory\":true}'::jsonb WHERE id=$1", [skillId]);
      await client.query("UPDATE plans SET potentially_stale=false WHERE id=$1", [planId]);
      await client.query("UPDATE skills SET configuration_json='{}'::jsonb WHERE id=$1", [skillId]);
      expect((await client.query("SELECT potentially_stale FROM plans WHERE id=$1", [planId])).rows[0].potentially_stale).toBe(true);
    } finally {
      await client.end();
    }
  });

  it("allows exactly one concurrent approval decision and reports the winning snapshot", async () => {
    await cp(new URL("../migrations/", import.meta.url), migrationDirectory, { recursive: true });
    await migrate({ connectionString: testDatabaseUrl!, directory: migrationDirectory });
    const setup = new pg.Client({ connectionString: testDatabaseUrl });
    await setup.connect();
    const project = (await setup.query("INSERT INTO projects (slug,name,repository_path) VALUES ($q$race$q$,$q$Race$q$,$q$/tmp/project$q$) RETURNING *")).rows[0];
    const ticket = (await setup.query("INSERT INTO tickets (ticket_number,project_id,title,status) VALUES ($q$RACE-1$q$,$1,$q$Ticket$q$,$q$Plan Ready for Review$q$) RETURNING *,updated_at::text ticket_version", [project.id])).rows[0];
    const planId = (await setup.query("INSERT INTO plans (ticket_id) VALUES ($1) RETURNING id", [ticket.id])).rows[0].id;
    const planVersion = (await setup.query("INSERT INTO plan_versions (plan_id,version,content_markdown,content_hash) VALUES ($1,1,$q$x$q$,encode(digest($q$x$q$,$q$sha256$q$),$q$hex$q$)) RETURNING *", [planId])).rows[0];
    await setup.query("UPDATE plans SET current_version_id=$2 WHERE id=$1", [planId, planVersion.id]);
    await setup.end();
    const approvedInput = {
      plan: { versionId: planVersion.id, version: 1, contentHash: planVersion.content_hash },
      ticket: { title: ticket.title }, project: { configVersion: project.config_version, config: { repositoryPath: project.repository_path } },
      models: { execution: { model: "sonnet", reasoningLevel: "high" } },
      prompts: [{ phase: "execution", content: "Implement x.", provenance: [] }], skills: [], policySources: [],
    } as const;
    const first = new pg.Client({ connectionString: testDatabaseUrl });
    const second = new pg.Client({ connectionString: testDatabaseUrl });
    await Promise.all([first.connect(), second.connect()]);
    await Promise.all([first.query("BEGIN"), second.query("BEGIN")]);
    try {
      const winner = await approvalTransitions.approvePlanDecision(first as any, {
        ticketId: ticket.id, planVersionId: planVersion.id, expectedTicketVersion: ticket.ticket_version,
        expectedStatus: "Plan Ready for Review", approvedInput, decidedBy: null, skillSnapshotId: null,
      });
      const loser = approvalTransitions.approvePlanDecision(second as any, {
        ticketId: ticket.id, planVersionId: planVersion.id, expectedTicketVersion: ticket.ticket_version,
        expectedStatus: "Plan Ready for Review", approvedInput, decidedBy: null, skillSnapshotId: null,
      });
      await new Promise((resolve) => setImmediate(resolve));
      await first.query("COMMIT");
      await expect(loser).rejects.toMatchObject({ code: "approval_conflict", currentSnapshotId: winner.approvedInputSnapshot.id });
      await second.query("ROLLBACK");
      const verify = new pg.Client({ connectionString: testDatabaseUrl });
      await verify.connect();
      expect((await verify.query("SELECT count(*)::int count FROM approved_input_snapshots")).rows[0].count).toBe(1);
      expect((await verify.query("SELECT count(*)::int count FROM plan_approval_decisions")).rows[0].count).toBe(1);
      await verify.end();
    } finally {
      await Promise.allSettled([first.end(), second.end()]);
    }
  });

  it("rejects approval when the ticket changed after its inputs were built", async () => {
    await cp(new URL("../migrations/", import.meta.url), migrationDirectory, { recursive: true });
    await migrate({ connectionString: testDatabaseUrl!, directory: migrationDirectory });
    const client = new pg.Client({ connectionString: testDatabaseUrl });
    await client.connect();
    try {
      const project = (await client.query("INSERT INTO projects (slug,name,repository_path) VALUES ($q$stale-input$q$,$q$Stale input$q$,$q$/tmp/project$q$) RETURNING *")).rows[0];
      const ticket = (await client.query("INSERT INTO tickets (ticket_number,project_id,title,status) VALUES ($q$STALE-1$q$,$1,$q$Before$q$,$q$Plan Ready for Review$q$) RETURNING *,updated_at::text ticket_version", [project.id])).rows[0];
      const planId = (await client.query("INSERT INTO plans (ticket_id) VALUES ($1) RETURNING id", [ticket.id])).rows[0].id;
      const planVersion = (await client.query("INSERT INTO plan_versions (plan_id,version,content_markdown,content_hash) VALUES ($1,1,$q$x$q$,encode(digest($q$x$q$,$q$sha256$q$),$q$hex$q$)) RETURNING *", [planId])).rows[0];
      await client.query("UPDATE plans SET current_version_id=$2 WHERE id=$1", [planId, planVersion.id]);
      const approvedInput = {
        plan: { versionId: planVersion.id, version: 1, contentHash: planVersion.content_hash },
        ticket: { title: ticket.title }, project: { configVersion: project.config_version, config: {} },
        models: {}, prompts: [], skills: [], policySources: [],
      } as const;
      await client.query("UPDATE tickets SET title=$2,updated_at=clock_timestamp() WHERE id=$1", [ticket.id, "After"]);
      await client.query("BEGIN");
      await expect(approvalTransitions.approvePlanDecision(client as any, {
        ticketId: ticket.id, planVersionId: planVersion.id, expectedTicketVersion: ticket.ticket_version,
        expectedStatus: "Plan Ready for Review", approvedInput, decidedBy: null, skillSnapshotId: null,
      })).rejects.toMatchObject({ code: "approval_conflict" });
      await client.query("ROLLBACK");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      await client.end();
    }
  });

  it("allows only one of concurrent approval and rejection", async () => {
    await cp(new URL("../migrations/", import.meta.url), migrationDirectory, { recursive: true });
    await migrate({ connectionString: testDatabaseUrl!, directory: migrationDirectory });
    const setup = new pg.Client({ connectionString: testDatabaseUrl });
    await setup.connect();
    const fixture = await createDecisionFixture(setup, "approve-reject");
    await setup.end();
    const approval = new pg.Client({ connectionString: testDatabaseUrl });
    const rejection = new pg.Client({ connectionString: testDatabaseUrl });
    await Promise.all([approval.connect(), rejection.connect()]);
    await Promise.all([approval.query("BEGIN"), rejection.query("BEGIN")]);
    try {
      const winner = await approvalTransitions.approvePlanDecision(approval as any, {
        ticketId: fixture.ticket.id, planVersionId: fixture.planVersion.id, expectedTicketVersion: fixture.ticket.ticket_version,
        expectedStatus: "Plan Ready for Review", approvedInput: fixture.approvedInput, decidedBy: null, skillSnapshotId: null,
      });
      const loser = approvalTransitions.rejectPlanDecision(rejection as any, {
        ticketId: fixture.ticket.id, planVersionId: fixture.planVersion.id, expectedTicketVersion: fixture.ticket.ticket_version,
        expectedStatus: "Plan Ready for Review", expectedSnapshotId: null, decidedBy: null,
      });
      await new Promise((resolve) => setImmediate(resolve));
      await approval.query("COMMIT");
      await expect(loser).rejects.toMatchObject({ code: "approval_conflict", currentSnapshotId: winner.approvedInputSnapshot.id });
      await rejection.query("ROLLBACK");
      const verify = new pg.Client({ connectionString: testDatabaseUrl });
      await verify.connect();
      expect((await verify.query("SELECT status,approved_input_snapshot_id FROM tickets WHERE id=$1", [fixture.ticket.id])).rows[0]).toEqual({
        status: "Plan Approved", approved_input_snapshot_id: winner.approvedInputSnapshot.id,
      });
      expect((await verify.query("SELECT count(*)::int count FROM plan_approval_decisions")).rows[0].count).toBe(1);
      await verify.end();
    } finally {
      await Promise.allSettled([approval.end(), rejection.end()]);
    }
  });

  it("allows only one of concurrent approval and revision", async () => {
    await cp(new URL("../migrations/", import.meta.url), migrationDirectory, { recursive: true });
    await migrate({ connectionString: testDatabaseUrl!, directory: migrationDirectory });
    const setup = new pg.Client({ connectionString: testDatabaseUrl });
    await setup.connect();
    const fixture = await createDecisionFixture(setup, "approve-revision");
    await setup.end();
    const approval = new pg.Client({ connectionString: testDatabaseUrl });
    const revision = new pg.Client({ connectionString: testDatabaseUrl });
    await Promise.all([approval.connect(), revision.connect()]);
    await Promise.all([approval.query("BEGIN"), revision.query("BEGIN")]);
    try {
      const winner = await approvalTransitions.approvePlanDecision(approval as any, {
        ticketId: fixture.ticket.id, planVersionId: fixture.planVersion.id, expectedTicketVersion: fixture.ticket.ticket_version,
        expectedStatus: "Plan Ready for Review", approvedInput: fixture.approvedInput, decidedBy: null, skillSnapshotId: null,
      });
      const loser = approvalTransitions.requestPlanRevisionDecision(revision as any, {
        ticketId: fixture.ticket.id, planVersionId: fixture.planVersion.id, expectedTicketVersion: fixture.ticket.ticket_version,
        expectedStatus: "Plan Ready for Review", expectedSnapshotId: null,
      });
      await new Promise((resolve) => setImmediate(resolve));
      await approval.query("COMMIT");
      await expect(loser).rejects.toMatchObject({ code: "approval_conflict", currentSnapshotId: winner.approvedInputSnapshot.id });
      await revision.query("ROLLBACK");
      const verify = new pg.Client({ connectionString: testDatabaseUrl });
      await verify.connect();
      expect((await verify.query("SELECT status,approved_input_snapshot_id FROM tickets WHERE id=$1", [fixture.ticket.id])).rows[0]).toEqual({
        status: "Plan Approved", approved_input_snapshot_id: winner.approvedInputSnapshot.id,
      });
      await verify.end();
    } finally {
      await Promise.allSettled([approval.end(), revision.end()]);
    }
  });

  it("records rejection history and clears every active approval reference", async () => {
    await cp(new URL("../migrations/", import.meta.url), migrationDirectory, { recursive: true });
    await migrate({ connectionString: testDatabaseUrl!, directory: migrationDirectory });
    const client = new pg.Client({ connectionString: testDatabaseUrl });
    await client.connect();
    try {
      const project = (await client.query("INSERT INTO projects (slug,name,repository_path) VALUES ($q$reject$q$,$q$Reject$q$,$q$/tmp/project$q$) RETURNING *")).rows[0];
      const ticket = (await client.query("INSERT INTO tickets (ticket_number,project_id,title,status) VALUES ($q$REJ-1$q$,$1,$q$Ticket$q$,$q$Plan Ready for Review$q$) RETURNING *,updated_at::text ticket_version", [project.id])).rows[0];
      const planId = (await client.query("INSERT INTO plans (ticket_id) VALUES ($1) RETURNING id", [ticket.id])).rows[0].id;
      const planVersion = (await client.query("INSERT INTO plan_versions (plan_id,version,content_markdown,content_hash) VALUES ($1,1,$q$x$q$,encode(digest($q$x$q$,$q$sha256$q$),$q$hex$q$)) RETURNING *", [planId])).rows[0];
      await client.query("UPDATE plans SET current_version_id=$2 WHERE id=$1", [planId, planVersion.id]);
      const approvedInput = {
        plan: { versionId: planVersion.id, version: 1, contentHash: planVersion.content_hash },
        ticket: { title: ticket.title }, project: { configVersion: project.config_version, config: { repositoryPath: project.repository_path } },
        models: { execution: { model: "sonnet", reasoningLevel: "high" } },
        prompts: [{ phase: "execution", content: "Implement x.", provenance: [] }], skills: [], policySources: [],
      } as const;
      await client.query("BEGIN");
      const approved = await approvalTransitions.approvePlanDecision(client as any, {
        ticketId: ticket.id, planVersionId: planVersion.id, expectedTicketVersion: ticket.ticket_version,
        expectedStatus: "Plan Ready for Review", approvedInput, decidedBy: null, skillSnapshotId: null,
      });
      await client.query("COMMIT");

      await client.query("BEGIN");
      const approvedTicketVersion = (await client.query("SELECT updated_at::text ticket_version FROM tickets WHERE id=$1", [ticket.id])).rows[0].ticket_version;
      const rejected = await approvalTransitions.rejectPlanDecision(client as any, {
        ticketId: ticket.id, planVersionId: planVersion.id, expectedTicketVersion: approvedTicketVersion, expectedStatus: "Plan Approved",
        expectedSnapshotId: approved.approvedInputSnapshot.id, decidedBy: null,
      });
      await client.query("COMMIT");

      expect(rejected.ticket).toMatchObject({
        status: "Rejected", approved_plan_version_id: null, approved_plan_hash: null,
        approved_ticket_version: null, approved_project_config_version: null,
        approved_model_config_json: null, approved_skill_snapshot_id: null,
        approved_prompt_versions_json: null, approved_input_snapshot_id: null, plan_approved_at: null,
      });
      expect((await client.query("SELECT decision FROM plan_approval_decisions ORDER BY created_at,id")).rows.map((row) => row.decision)).toEqual(["approved", "rejected"]);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
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
    await writeFile(join(migrationDirectory, "019_project_agent_start_path.sql"), "CREATE TABLE should_not_exist (id integer);");
    await migrate({ connectionString: testDatabaseUrl!, directory: migrationDirectory });
    const verify = new pg.Client({ connectionString: testDatabaseUrl });
    await verify.connect();
    try {
      expect((await verify.query("SELECT to_regclass($q$should_not_exist$q$) AS table_name")).rows[0].table_name).toBeNull();
    } finally {
      await verify.end();
    }
  });

  it("applies follow-up 015 after legacy project start path", async () => {
    const client = new pg.Client({ connectionString: testDatabaseUrl });
    await client.connect();
    try {
      await client.query("CREATE TABLE schema_migrations (name text PRIMARY KEY)");
      await client.query("INSERT INTO schema_migrations (name) VALUES ($q$015_project_agent_start_path.sql$q$)");
    } finally {
      await client.end();
    }
    await writeFile(join(migrationDirectory, "015_follow_up_ticket_prompt.sql"), "CREATE TABLE legacy_follow_up_applied (id integer);");
    await migrate({ connectionString: testDatabaseUrl!, directory: migrationDirectory });
    const verify = new pg.Client({ connectionString: testDatabaseUrl });
    await verify.connect();
    try {
      expect((await verify.query("SELECT to_regclass($q$legacy_follow_up_applied$q$) AS table_name")).rows[0].table_name).toBe("legacy_follow_up_applied");
      expect((await verify.query("SELECT name FROM schema_migrations ORDER BY name")).rows).toEqual([
        { name: "015_follow_up_ticket_prompt.sql" },
        { name: "015_project_agent_start_path.sql" },
      ]);
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
      await client.query("INSERT INTO tickets (ticket_number,project_id,title,status) VALUES ($q$T-2$q$,$1,$q$Ticket$q$,$q$Needs Information$q$)", [projectId]);
      await client.query("INSERT INTO tickets (ticket_number,project_id,title,status) VALUES ($q$T-3$q$,$1,$q$Ticket$q$,$q$Archived$q$)", [projectId]);
      await client.query("INSERT INTO jobs (type,status,idempotency_key) VALUES ($q$test$q$,$q$cancelled$q$,$q$cancelled-job$q$)");
      await client.query("INSERT INTO jobs (type,status,idempotency_key) VALUES ($q$test$q$,$q$blocked_auth$q$,$q$blocked-auth-job$q$)");
      await client.query("INSERT INTO jobs (type,status,idempotency_key) VALUES ($q$test$q$,$q$blocked_auth_configuration$q$,$q$blocked-auth-configuration-job$q$)");
      await client.query("INSERT INTO agent_runs (status) VALUES ($q$timed_out$q$)");
      const planId = (await client.query("INSERT INTO plans (ticket_id) VALUES ($1) RETURNING id", [ticketId])).rows[0].id;
      const planVersionId = (await client.query("INSERT INTO plan_versions (plan_id,version,content_markdown,content_hash) VALUES ($1,1,$q$x$q$,encode(digest($q$x$q$,$q$sha256$q$),$q$hex$q$)) RETURNING id", [planId])).rows[0].id;
      await client.query("INSERT INTO execution_attempts (ticket_id,plan_version_id,attempt_number,validation_status) VALUES ($1,$2,1,$q$cancelled$q$)", [ticketId, planVersionId]);
      await client.query("INSERT INTO execution_attempts (ticket_id,plan_version_id,attempt_number,validation_status) VALUES ($1,$2,2,$q$timed_out$q$)", [ticketId, planVersionId]);
      await client.query("INSERT INTO execution_attempts (ticket_id,plan_version_id,attempt_number,validation_status) VALUES ($1,$2,3,$q$published$q$)", [ticketId, planVersionId]);
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

  it("persists backup recovery verification outcomes", async () => {
    await cp(new URL("../migrations/", import.meta.url), migrationDirectory, { recursive: true });
    await migrate({ connectionString: testDatabaseUrl!, directory: migrationDirectory });
    const client = new pg.Client({ connectionString: testDatabaseUrl });
    await client.connect();
    try {
      await client.query(
        "INSERT INTO backup_recovery_verifications (backup_path,manifest_sha256,status) VALUES ($q$/backups/dcc-20260802T031500Z$q$,repeat($q$a$q$,64),$q$passed$q$)",
      );
      expect((await client.query("SELECT status, failure_step FROM backup_recovery_verifications")).rows).toEqual([
        { status: "passed", failure_step: null },
      ]);
    } finally {
      await client.end();
    }
  });

  it("persists rerun, lease, and publication workflow state", async () => {
    await cp(new URL("../migrations/", import.meta.url), migrationDirectory, { recursive: true });
    await migrate({ connectionString: testDatabaseUrl!, directory: migrationDirectory });
    const client = new pg.Client({ connectionString: testDatabaseUrl });
    await client.connect();
    try {
      const parentJobId = (await client.query("INSERT INTO jobs (type,idempotency_key) VALUES ($q$workflow$q$,$q$workflow-parent$q$) RETURNING id")).rows[0].id;
      const rerunJobId = (await client.query("INSERT INTO jobs (type,idempotency_key,rerun_of,lease_expires_at,recovery_reason) VALUES ($q$workflow$q$,$q$workflow-rerun$q$,$1,now()+interval $q$60 seconds$q$,$q$lease_expired$q$) RETURNING id", [parentJobId])).rows[0].id;
      expect((await client.query("SELECT rerun_of,lease_expires_at IS NOT NULL AS has_lease,recovery_reason FROM jobs WHERE id=$1", [rerunJobId])).rows[0]).toEqual({ rerun_of: parentJobId, has_lease: true, recovery_reason: "lease_expired" });
      await expect(client.query("INSERT INTO jobs (type,idempotency_key,rerun_of) VALUES ($q$workflow$q$,$q$workflow-bad-rerun$q$,gen_random_uuid())")).rejects.toThrow();

      const providerId = (await client.query("INSERT INTO notification_providers (name,type) VALUES ($q$workflow$q$,$q$test$q$) RETURNING id")).rows[0].id;
      const deliveryId = (await client.query("INSERT INTO notification_deliveries (provider_id,status,claimed_by,lease_expires_at,recovery_reason) VALUES ($1,$q$sending$q$,$q$worker-1$q$,now()+interval $q$60 seconds$q$,$q$lease_expired$q$) RETURNING id", [providerId])).rows[0].id;
      expect((await client.query("SELECT claimed_by,lease_expires_at IS NOT NULL AS has_lease,recovery_reason FROM notification_deliveries WHERE id=$1", [deliveryId])).rows[0]).toEqual({ claimed_by: "worker-1", has_lease: true, recovery_reason: "lease_expired" });

      const projectId = (await client.query("INSERT INTO projects (slug,name,repository_path) VALUES ($q$workflow-state$q$,$q$Workflow state$q$,$q$/tmp/project$q$) RETURNING id")).rows[0].id;
      const ticketId = (await client.query("INSERT INTO tickets (ticket_number,project_id,title,status) VALUES ($q$WORKFLOW-1$q$,$1,$q$Workflow state$q$,$q$Submitted$q$) RETURNING id", [projectId])).rows[0].id;
      const planId = (await client.query("INSERT INTO plans (ticket_id) VALUES ($1) RETURNING id", [ticketId])).rows[0].id;
      const planVersionId = (await client.query("INSERT INTO plan_versions (plan_id,version,content_markdown,content_hash) VALUES ($1,1,$q$x$q$,encode(digest($q$x$q$,$q$sha256$q$),$q$hex$q$)) RETURNING id", [planId])).rows[0].id;
      const executionAttemptId = (await client.query("INSERT INTO execution_attempts (ticket_id,plan_version_id,attempt_number) VALUES ($1,$2,1) RETURNING id", [ticketId, planVersionId])).rows[0].id;
      const secondExecutionAttemptId = (await client.query("INSERT INTO execution_attempts (ticket_id,plan_version_id,attempt_number) VALUES ($1,$2,2) RETURNING id", [ticketId, planVersionId])).rows[0].id;
      const publicationJobId = (await client.query("INSERT INTO jobs (type,idempotency_key) VALUES ($q$workflow$q$,$q$workflow-publication-job$q$) RETURNING id")).rows[0].id;
      const pullRequestId = (await client.query("INSERT INTO pull_requests (project_id) VALUES ($1) RETURNING id", [projectId])).rows[0].id;
      const publicationId = (await client.query("INSERT INTO execution_publications (execution_attempt_id,idempotency_key,last_job_id,pull_request_id) VALUES ($1,$q$workflow-publication$q$,$2,$3) RETURNING id", [executionAttemptId, publicationJobId, pullRequestId])).rows[0].id;
      expect((await client.query("SELECT status,attempt_count FROM execution_publications WHERE id=$1", [publicationId])).rows[0]).toEqual({ status: "pending", attempt_count: 0 });
      await expect(client.query("INSERT INTO execution_publications (execution_attempt_id,idempotency_key) VALUES ($1,$q$workflow-second-key$q$)", [executionAttemptId])).rejects.toThrow();
      await expect(client.query("INSERT INTO execution_publications (execution_attempt_id,idempotency_key) VALUES ($1,$q$workflow-publication$q$)", [secondExecutionAttemptId])).rejects.toMatchObject({
        code: "23505", constraint: "execution_publications_idempotency_key_key",
      });
      await expect(client.query("UPDATE execution_publications SET status=$q$invalid$q$ WHERE id=$1", [publicationId])).rejects.toThrow();
      await client.query("DELETE FROM jobs WHERE id=$1", [publicationJobId]);
      await client.query("DELETE FROM pull_requests WHERE id=$1", [pullRequestId]);
      expect((await client.query("SELECT last_job_id,pull_request_id FROM execution_publications WHERE id=$1", [publicationId])).rows[0]).toEqual({ last_job_id: null, pull_request_id: null });
      await expect(client.query("DELETE FROM execution_attempts WHERE id=$1", [executionAttemptId])).rejects.toThrow();
    } finally {
      await client.end();
    }
  });

  it("makes live pre-migration jobs and deliveries immediately recoverable", async () => {
    await cp(new URL("../migrations/", import.meta.url), migrationDirectory, { recursive: true });
    await Promise.all((await readdir(migrationDirectory))
      .filter((name) => Number(name.slice(0, 3)) >= 37)
      .map((name) => rm(join(migrationDirectory, name))));
    await migrate({ connectionString: testDatabaseUrl!, directory: migrationDirectory });
    const client = new pg.Client({ connectionString: testDatabaseUrl });
    await client.connect();
    try {
      const providerId = (await client.query("INSERT INTO notification_providers (name,type) VALUES ($q$legacy-live$q$,$q$test$q$) RETURNING id")).rows[0].id;
      await client.query("INSERT INTO jobs (type,status,idempotency_key) VALUES ($q$workflow$q$,$q$running$q$,$q$legacy-running$q$)");
      await client.query("INSERT INTO notification_deliveries (provider_id,status) VALUES ($1,$q$sending$q$)", [providerId]);
    } finally {
      await client.end();
    }

    await cp(new URL("../migrations/037_workflow_state.sql", import.meta.url), join(migrationDirectory, "037_workflow_state.sql"));
    await migrate({ connectionString: testDatabaseUrl!, directory: migrationDirectory });
    const verify = new pg.Client({ connectionString: testDatabaseUrl });
    await verify.connect();
    try {
      expect((await verify.query("SELECT lease_expires_at <= now() AS recoverable FROM jobs WHERE idempotency_key=$q$legacy-running$q$")).rows[0]).toEqual({ recoverable: true });
      expect((await verify.query("SELECT lease_expires_at <= now() AS recoverable FROM notification_deliveries WHERE status=$q$sending$q$")).rows[0]).toEqual({ recoverable: true });
    } finally {
      await verify.end();
    }
  });
});
