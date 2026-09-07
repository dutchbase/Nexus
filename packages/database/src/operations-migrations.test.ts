import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pg from "pg";
import { migrate } from "./migrate.ts";

const databaseUrl = process.env.DCC_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
let directory = "";

async function reset() {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  await client.end();
}

async function copyThrough(last: string) {
  const source = new URL("../migrations/", import.meta.url);
  for (const name of (await readdir(source)).filter((name) => name.endsWith(".sql") && name <= last)) {
    await cp(new URL(name, source), join(directory, name));
  }
}

integration("repository identity migrations", () => {
  beforeEach(async () => { await reset(); directory = await mkdtemp(join(tmpdir(), "dcc-ops-migrations-")); });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it("does not register the production-specific external repository on a fresh install", async () => {
    await copyThrough("063_case_insensitive_github_repository_identity.sql");
    await migrate({ connectionString: databaseUrl!, directory });
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    expect((await client.query("SELECT count(*)::int count FROM projects")).rows[0].count).toBe(0);
    await client.end();
  });

  it("retains the configured survivor without overwriting its slug or config", async () => {
    await copyThrough("061_va_jobs_platform_placeholder_path_reconciliation.sql");
    await migrate({ connectionString: databaseUrl!, directory });
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    const configured = (await client.query(
      "INSERT INTO projects (slug,name,repository_path,github_owner,github_repository,config_json,enabled) VALUES ('alternate','Configured','/srv/real','DutchBase','VA-Jobs-Platform',$q${\"commands\":[\"keep\"]}$q$,false) RETURNING id",
    )).rows[0];
    await client.query("INSERT INTO projects (slug,name,repository_path,github_owner,github_repository,enabled) VALUES ('duplicate','Duplicate','/PLACEHOLDER/unconfigured','dutchbase','va-jobs-platform',true)");
    await client.end();
    await copyThrough("063_case_insensitive_github_repository_identity.sql");
    await migrate({ connectionString: databaseUrl!, directory });
    const verify = new pg.Client({ connectionString: databaseUrl });
    await verify.connect();
    expect((await verify.query("SELECT slug,github_owner,github_repository,config_json->'commands' commands FROM projects WHERE id=$1", [configured.id])).rows[0])
      .toEqual({ slug: "alternate", github_owner: "DutchBase", github_repository: "VA-Jobs-Platform", commands: ["keep"] });
    expect((await verify.query("SELECT enabled,github_owner,config_json ? '_migration_062_repository_deduplication' provenance FROM projects WHERE id<>$1", [configured.id])).rows)
      .toContainEqual({ enabled: false, github_owner: null, provenance: true });
    await verify.end();
  });

  it("repairs case-variant duplicates when legacy 062 is already recorded", async () => {
    await copyThrough("061_va_jobs_platform_placeholder_path_reconciliation.sql");
    await migrate({ connectionString: databaseUrl!, directory });
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query("UPDATE projects SET github_owner=NULL,github_repository=NULL WHERE slug='va-jobs-platform'");
    await client.query("INSERT INTO projects (slug,name,repository_path,github_owner,github_repository) VALUES ('one','One','/srv/one','Owner','Repo'),('two','Two','/srv/two','owner','repo')");
    await client.query("INSERT INTO schema_migrations (name) VALUES ('062_dedupe_va_jobs_platform_project.sql')");
    await client.end();
    await copyThrough("063_case_insensitive_github_repository_identity.sql");
    await migrate({ connectionString: databaseUrl!, directory });
    const verify = new pg.Client({ connectionString: databaseUrl });
    await verify.connect();
    expect((await verify.query("SELECT count(*)::int count FROM projects WHERE lower(github_owner)='owner' AND lower(github_repository)='repo'")).rows[0].count).toBe(1);
    await expect(verify.query("INSERT INTO projects (slug,name,repository_path,github_owner,github_repository) VALUES ('three','Three','/tmp','OWNER','REPO')")).rejects.toThrow("projects_github_repo_unique");
    await verify.end();
  });
});
