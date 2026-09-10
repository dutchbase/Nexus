import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrate } from "./migrate.ts";

const testDatabaseUrl = process.env.DCC_TEST_DATABASE_URL;
process.env.DATABASE_URL = testDatabaseUrl ?? "postgres://unused:unused@127.0.0.1:1/unused";
const integration = testDatabaseUrl ? describe : describe.skip;
const { pool } = await import("@dcc/database");
const migrationDirectory = new URL("../migrations/", import.meta.url);
let legacyMigrationDirectory = "";

async function reset() {
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
}

integration("project reporters migration", () => {
  beforeAll(async () => {
    legacyMigrationDirectory = await mkdtemp(join(tmpdir(), "dcc-project-reporters-"));
    for (const name of await readdir(migrationDirectory)) {
      if (name.endsWith(".sql") && name < "064_project_reporters.sql") await cp(new URL(name, migrationDirectory), join(legacyMigrationDirectory, name));
    }
  });

  beforeEach(async () => {
    await reset();
    await migrate({ connectionString: testDatabaseUrl! });
  });

  afterAll(async () => {
    await rm(legacyMigrationDirectory, { recursive: true, force: true });
    await pool.end();
  });

  test("new accounts default to reporter and project membership is unique", async () => {
    const user = (await pool.query(
      "INSERT INTO users(username,password_hash) VALUES ('reporter-default','test-hash') RETURNING id,role",
    )).rows[0];
    expect(user.role).toBe("reporter");
    const project = (await pool.query(
      "INSERT INTO projects(slug,name,repository_path) VALUES ('reporter-project','Reporter project','/tmp/reporter-project') RETURNING id",
    )).rows[0];
    await pool.query("INSERT INTO project_memberships(user_id,project_id) VALUES ($1,$2)", [user.id, project.id]);
    await expect(pool.query("INSERT INTO project_memberships(user_id,project_id) VALUES ($1,$2)", [user.id, project.id]))
      .rejects.toMatchObject({ code: "23505" });

    const columns = (await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name='tickets'",
    )).rows.map((row) => row.column_name);
    expect(columns).toEqual(expect.arrayContaining([
      "created_by_user_id", "submission_revision", "submission_updated_at",
      "submitter_deleted_at", "submitter_deleted_by",
    ]));
    await expect(pool.query(
      "INSERT INTO users(username,password_hash,role) VALUES ('bad-role','hash','owner')",
    )).rejects.toMatchObject({ code: "23514" });
  });

  test("preserves explicit admins and legacy ticket submission metadata during upgrade", async () => {
    await reset();
    await migrate({ connectionString: testDatabaseUrl!, directory: legacyMigrationDirectory });
    const admin = (await pool.query(
      "INSERT INTO users(username,password_hash,role) VALUES ('legacy-admin','hash','admin') RETURNING id,role",
    )).rows[0];
    const project = (await pool.query(
      "INSERT INTO projects(slug,name,repository_path) VALUES ('legacy-project','Legacy project','/tmp/legacy-project') RETURNING id",
    )).rows[0];
    const ticket = (await pool.query(
      "INSERT INTO tickets(ticket_number,project_id,title,status,created_at,updated_at) VALUES ('DCC-legacy',$1,'Legacy ticket','Submitted','2020-01-02T03:04:05Z','2020-01-03T04:05:06Z') RETURNING id,title,project_id,status,created_at,updated_at",
      [project.id],
    )).rows[0];

    await migrate({ connectionString: testDatabaseUrl! });

    expect((await pool.query("SELECT username,password_hash,role,is_active FROM users WHERE id=$1", [admin.id])).rows)
      .toEqual([{ username: "legacy-admin", password_hash: "hash", role: "admin", is_active: true }]);
    expect((await pool.query(
      "SELECT title,project_id,status,created_at,updated_at,created_by_user_id,submission_revision,submission_updated_at,submitter_deleted_at,submitter_deleted_by FROM tickets WHERE id=$1",
      [ticket.id],
    )).rows).toEqual([{
      title: ticket.title,
      project_id: ticket.project_id,
      status: ticket.status,
      created_at: ticket.created_at,
      updated_at: ticket.updated_at,
      created_by_user_id: null,
      submission_revision: 1,
      submission_updated_at: ticket.created_at,
      submitter_deleted_at: null,
      submitter_deleted_by: null,
    }]);
  });

  test("refuses an upgrade with existing roles outside admin and reporter", async () => {
    await reset();
    await migrate({ connectionString: testDatabaseUrl!, directory: legacyMigrationDirectory });
    await pool.query("INSERT INTO users(username,password_hash,role) VALUES ('legacy-owner','hash','owner')");
    await expect(migrate({ connectionString: testDatabaseUrl! }))
      .rejects.toThrow("cannot apply 064: users contain roles other than admin or reporter");
  });
});
