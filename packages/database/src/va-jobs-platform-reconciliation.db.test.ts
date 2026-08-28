import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pg from "pg";
import { migrate } from "./migrate.ts";

const testDatabaseUrl = process.env.DCC_TEST_DATABASE_URL;
const integration = testDatabaseUrl ? describe : describe.skip;
const PLACEHOLDER = "/PLACEHOLDER/set-a-real-local-clone-path-for-va-jobs-platform";
let migrationDirectory = "";

async function migrateUpTo(name: string) {
  const client = new pg.Client({ connectionString: testDatabaseUrl });
  await client.connect();
  try { await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;"); } finally { await client.end(); }
  const all = (await (await import("node:fs/promises")).readdir(migrationDirectory)).filter((f) => f.endsWith(".sql")).sort();
  const upTo = all.filter((f) => f <= name);
  const rest = all.filter((f) => f > name);
  const { rm: rmFile } = await import("node:fs/promises");
  for (const file of rest) await rmFile(join(migrationDirectory, file));
  await migrate({ connectionString: testDatabaseUrl!, directory: migrationDirectory });
  return { restore: rest };
}

integration("va-jobs-platform placeholder path reconciliation (061)", () => {
  beforeAll(async () => {
    migrationDirectory = await mkdtemp(join(tmpdir(), "dcc-va-jobs-reconcile-"));
    await cp(new URL("../migrations/", import.meta.url), migrationDirectory, { recursive: true });
  });
  afterAll(async () => { if (migrationDirectory) await rm(migrationDirectory, { recursive: true, force: true }); });

  it("copies the real path from a pre-existing duplicate project row onto the migration-seeded row", async () => {
    // Fresh copy of migrations so this test can insert a pre-existing row
    // between migration 059 (seeds the placeholder) and 061 (this plan's fix).
    const scratch = await mkdtemp(join(tmpdir(), "dcc-va-jobs-reconcile-scratch-"));
    await cp(new URL("../migrations/", import.meta.url), scratch, { recursive: true });
    const { readdir, rm: rmFile } = await import("node:fs/promises");
    const all = (await readdir(scratch)).filter((f) => f.endsWith(".sql")).sort();
    const migration061 = all.find((f) => f.startsWith("061_"))!;
    // Remove every migration after 059, including 061 itself, so the first
    // migrate() call below only runs through 059 (seeding the placeholder
    // row) -- 061 is deliberately NOT present yet, otherwise it would run
    // before the duplicate row exists below, get recorded as already
    // applied in schema_migrations, and then be silently skipped by the
    // second migrate() call once the duplicate row is actually in place.
    const after059 = all.filter((f) => f > "059_va_jobs_platform_project.sql");
    for (const file of after059) await rmFile(join(scratch, file));

    const client = new pg.Client({ connectionString: testDatabaseUrl });
    await client.connect();
    try {
      await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    } finally { await client.end(); }

    // Migrate through 059 (seeds the placeholder row), then hand-insert the
    // pre-existing "Jobs-platform" row with a real path, then run 061.
    const beforeDuplicate = new pg.Client({ connectionString: testDatabaseUrl });
    await beforeDuplicate.connect();
    await beforeDuplicate.end();
    await migrate({ connectionString: testDatabaseUrl!, directory: scratch });

    const client2 = new pg.Client({ connectionString: testDatabaseUrl });
    await client2.connect();
    try {
      await client2.query(
        `INSERT INTO projects (slug, name, github_owner, github_repository, default_branch, repository_path)
         VALUES ('jobs-platform', 'Jobs-platform', 'dutchbase', 'va-jobs-platform', 'master', '/home/deploy/projects/va-jobs-platform')`,
      );
    } finally { await client2.end(); }

    // Now copy in migration 061 and re-run.
    await cp(join(migrationDirectory, migration061), join(scratch, migration061));
    await migrate({ connectionString: testDatabaseUrl!, directory: scratch });

    const check = new pg.Client({ connectionString: testDatabaseUrl });
    await check.connect();
    try {
      const rows = (await check.query(
        "SELECT slug, repository_path FROM projects WHERE github_owner='dutchbase' AND github_repository='va-jobs-platform' ORDER BY slug",
      )).rows;
      expect(rows).toEqual([
        { slug: "jobs-platform", repository_path: "/home/deploy/projects/va-jobs-platform" },
        { slug: "va-jobs-platform", repository_path: "/home/deploy/projects/va-jobs-platform" },
      ]);
    } finally { await check.end(); }
    await rm(scratch, { recursive: true, force: true });
  });

  it("is a no-op when the va-jobs-platform row already has a real path", async () => {
    await migrateUpTo("999_never_matches.sql"); // runs every migration, including 061, once
    const client = new pg.Client({ connectionString: testDatabaseUrl });
    await client.connect();
    try {
      await client.query("UPDATE projects SET repository_path='/already/real/path' WHERE slug='va-jobs-platform'");
      // Re-running migrate() is a no-op (schema_migrations already records 061 as applied) --
      // this assertion instead directly re-runs the migration body to prove idempotency.
      const migrationSql = await (await import("node:fs/promises")).readFile(
        join(migrationDirectory, (await (await import("node:fs/promises")).readdir(migrationDirectory)).find((f) => f.startsWith("061_"))!),
        "utf8",
      );
      await client.query(migrationSql);
      const row = (await client.query("SELECT repository_path FROM projects WHERE slug='va-jobs-platform'")).rows[0];
      expect(row.repository_path).toBe("/already/real/path");
    } finally { await client.end(); }
  });

  it("leaves the placeholder in place and does not throw when no other candidate row exists", async () => {
    const client = new pg.Client({ connectionString: testDatabaseUrl });
    await client.connect();
    try {
      await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    } finally { await client.end(); }
    await migrate({ connectionString: testDatabaseUrl!, directory: migrationDirectory });
    const check = new pg.Client({ connectionString: testDatabaseUrl });
    await check.connect();
    try {
      const row = (await check.query("SELECT repository_path FROM projects WHERE slug='va-jobs-platform'")).rows[0];
      expect(row.repository_path).toBe(PLACEHOLDER);
    } finally { await check.end(); }
  });
});
