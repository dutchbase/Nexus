import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmod, cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { once } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";

const primaryDatabaseUrl = process.env.DCC_TEST_DATABASE_URL;
const restoreDatabaseUrl = process.env.DCC_TEST_RESTORE_DATABASE_URL;
const integration = primaryDatabaseUrl && restoreDatabaseUrl ? describe : describe.skip;
const { migrate } = await import("../packages/database/src/migrate.ts");
const repoRoot = new URL("..", import.meta.url).pathname;

async function resetDatabase(connectionString: string) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  } finally {
    await client.end();
  }
}

async function query(connectionString: string, statement: string, values: unknown[] = []) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    return await client.query(statement, values);
  } finally {
    await client.end();
  }
}

async function targetIdentity(connectionString: string) {
  const row = (await query(connectionString, "SELECT current_database() AS name, (pg_control_system()).system_identifier AS system_identifier")).rows[0];
  return [row.name, row.system_identifier].join("|");
}

async function targetIsDisposable(connectionString: string) {
  return (await query(connectionString, "SELECT EXISTS (SELECT 1 FROM pg_db_role_setting settings WHERE settings.setdatabase = (SELECT oid FROM pg_database WHERE datname=current_database()) AND settings.setrole=0 AND $$dcc.restore_disposable=true$$ = ANY(settings.setconfig)) AS value")).rows[0].value === true;
}

async function freePort() {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("health port unavailable"));
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitForHealth(url: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).status === 200) return;
    } catch {}
    await delay(100);
  }
  throw new Error("restore health endpoint did not become ready");
}

function run(script: string, args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync("bash", [script, ...args], { cwd: repoRoot, env, encoding: "utf8" });
}

function git(cwd: string, args: string[]) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "NexusTest",
      GIT_AUTHOR_EMAIL: "nexus@example.invalid",
      GIT_COMMITTER_NAME: "NexusTest",
      GIT_COMMITTER_EMAIL: "nexus@example.invalid",
    },
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

integration("backup recovery drill integration", () => {
  let root = "";
  let healthProcess: ReturnType<typeof spawn> | undefined;
  let clientPath = process.env.PATH;

  beforeEach(async () => {
    const [primaryIdentity, restoreIdentity, primaryDisposable, restoreDisposable] = await Promise.all([
      targetIdentity(primaryDatabaseUrl!),
      targetIdentity(restoreDatabaseUrl!),
      targetIsDisposable(primaryDatabaseUrl!),
      targetIsDisposable(restoreDatabaseUrl!),
    ]);
    if (primaryIdentity === restoreIdentity) throw new Error("DCC_TEST_RESTORE_DATABASE_URL must identify a distinct disposable database");
    if (!primaryDisposable || !restoreDisposable) throw new Error("DCC_TEST_DATABASE_URL and DCC_TEST_RESTORE_DATABASE_URL must be pre-marked dcc.restore_disposable=true");
    await resetDatabase(primaryDatabaseUrl!);
    await resetDatabase(restoreDatabaseUrl!);
    await migrate({ connectionString: primaryDatabaseUrl! });
    await migrate({ connectionString: restoreDatabaseUrl! });
    root = await mkdtemp(join(tmpdir(), "dcc-backup-integration-"));
    await Promise.all([mkdir(join(root, "data", "logs"), { recursive: true }), mkdir(join(root, "config"))]);
    await writeFile(join(root, "config", "projects.yaml"), "version: 1\nprojects: {}\n");
    if (process.env.DCC_TEST_POSTGRES_CONTAINER) {
      const bin = join(root, "postgres-bin");
      await mkdir(bin);
      await writeFile(join(bin, "pg_dump"), `#!/usr/bin/env bash
set -euo pipefail
for argument in "$@"; do case "$argument" in --file=*) file="\${argument#--file=}";; esac; done
database="\${1##*/}"
docker exec -e PGPASSWORD=nexus_test ${process.env.DCC_TEST_POSTGRES_CONTAINER} pg_dump --username=nexus_test --dbname="$database" --format=custom > "$file"
`);
      await writeFile(join(bin, "pg_restore"), `#!/usr/bin/env bash
set -euo pipefail
for argument in "$@"; do case "$argument" in --dbname=*) database="\${argument##*/}";; *) file="$argument";; esac; done
docker exec -i -e PGPASSWORD=nexus_test ${process.env.DCC_TEST_POSTGRES_CONTAINER} pg_restore --username=nexus_test --dbname="$database" --clean --if-exists --no-owner < "$file"
`);
      await Promise.all([chmod(join(bin, "pg_dump"), 0o755), chmod(join(bin, "pg_restore"), 0o755)]);
      clientPath = `${bin}:${process.env.PATH}`;
    }
  }, 30_000);

  afterEach(async () => {
    if (healthProcess && healthProcess.exitCode === null) {
      const exited = once(healthProcess, "exit");
      healthProcess.kill("SIGTERM");
      await Promise.race([exited, delay(5_000)]);
      if (healthProcess.exitCode === null) healthProcess.kill("SIGKILL");
    }
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("restores DCC_TEST_DATABASE_URL to the explicit disposable database and checks its real health endpoint", async () => {
    const sourceMarker = "/source-backup-marker";
    const artifactBytes = "restored artifact bytes\n";
    const artifactHash = createHash("sha256").update(artifactBytes).digest("hex");
    await writeFile(join(root, "data", "logs", "restore-test.log"), artifactBytes);
    const runId = (await query(primaryDatabaseUrl!, "INSERT INTO agent_runs (status) VALUES ('completed') RETURNING id")).rows[0].id;
    await query(primaryDatabaseUrl!, "INSERT INTO artifacts (id,storage_path,artifact_type,status,sha256,finalized_at,agent_run_id) VALUES (gen_random_uuid(),'logs/restore-test.log','execution_log','finalized',$1,now(),$2)", [artifactHash, runId]);
    const repository = join(root, "repository");
    const worktreeRelative = "worktrees/restore-project/T-1/1";
    const worktree = join(root, "data", worktreeRelative);
    await mkdir(repository);
    git(repository, ["init", "--initial-branch=main"]);
    await writeFile(join(repository, "result.txt"), "restored worktree bytes\n");
    git(repository, ["add", "result.txt"]);
    git(repository, ["commit", "-m", "result"]);
    await mkdir(join(root, "data", "worktrees", "restore-project", "T-1"), { recursive: true });
    git(repository, ["worktree", "add", "--detach", worktree, "HEAD"]);
    const worktreeCommit = git(worktree, ["rev-parse", "HEAD"]);
    const projectId = (await query(primaryDatabaseUrl!, "INSERT INTO projects (slug,name,repository_path) VALUES ('restore-project','Restore project',$1) RETURNING id", [repository])).rows[0].id;
    const ticketId = (await query(primaryDatabaseUrl!, "INSERT INTO tickets (ticket_number,project_id,title,status) VALUES ('T-1',$1,'Restore worktree','Executing') RETURNING id", [projectId])).rows[0].id;
    const planId = (await query(primaryDatabaseUrl!, "INSERT INTO plans (ticket_id) VALUES ($1) RETURNING id", [ticketId])).rows[0].id;
    const planVersionId = (await query(primaryDatabaseUrl!, "INSERT INTO plan_versions (plan_id,version,content_markdown,content_hash) VALUES ($1,1,'restore',encode(digest('restore','sha256'),'hex')) RETURNING id", [planId])).rows[0].id;
    const attemptId = (await query(primaryDatabaseUrl!, "INSERT INTO execution_attempts (ticket_id,plan_version_id,agent_run_id,attempt_number,worktree_path,base_commit,result_commit,validation_status) VALUES ($1,$2,$3,1,$4,$5,$5,'completed') RETURNING id", [ticketId, planVersionId, runId, worktree, worktreeCommit])).rows[0].id;
    await query(primaryDatabaseUrl!, "INSERT INTO artifacts (id,storage_path,artifact_type,status,sha256,finalized_at,agent_run_id,execution_attempt_id) VALUES (gen_random_uuid(),$1,'worktree','finalized',$2,now(),$3,$4)", [worktreeRelative, createHash("sha256").update(worktreeCommit).digest("hex"), runId, attemptId]);
    await query(
      primaryDatabaseUrl!,
      "INSERT INTO backup_recovery_verifications (backup_path,manifest_sha256,status) VALUES ($1,repeat($q$a$q$,64),$q$passed$q$)",
      [sourceMarker],
    );
    const backupRoot = join(root, "backups");
    const backupEnvironment = {
      ...process.env,
      PATH: clientPath,
      DATABASE_URL: primaryDatabaseUrl!,
      DCC_BACKUP_DIRECTORY: backupRoot,
      DCC_BACKUP_RETENTION_DAYS: "2",
      DCC_DATA_DIR: join(root, "data"),
      DCC_DATA_ROOT: root,
      DCC_CONFIG_DIR: join(root, "config"),
    };
    const backupResult = run("scripts/backup.sh", [], backupEnvironment);
    expect(backupResult.status, backupResult.stderr).toBe(0);
    const backups = (await readdir(backupRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("dcc-"));
    expect(backups).toHaveLength(1);
    const backupPath = join(backupRoot, backups[0].name);
    await rm(repository, { recursive: true, force: true });
    expect(spawnSync("git", ["-C", worktree, "rev-parse", "HEAD"], { encoding: "utf8" }).status).not.toBe(0);

    const port = await freePort();
    const healthUrl = "http://127.0.0.1:" + port + "/api/health";
    const recoveryRoot = join(root, "recovery");
    healthProcess = spawn(join(repoRoot, "node_modules", ".bin", "tsx"), ["apps/web/src/server.ts"], {
      cwd: repoRoot,
      env: {
        ...process.env, NODE_ENV: "development", DATABASE_URL: restoreDatabaseUrl!, PORT: String(port), HOST: "127.0.0.1",
        DCC_PROCESS_ROLE: "web", DCC_DATA_DIR: join(recoveryRoot, "data"), DCC_DATA_ROOT: recoveryRoot,
        DCC_CONFIG_DIR: join(recoveryRoot, "config"),
      },
      stdio: "ignore",
    });
    await waitForHealth(healthUrl);

    const corruptPath = join(root, "corrupt-backup");
    await cp(backupPath, corruptPath, { recursive: true });
    await writeFile(join(corruptPath, "database.dump"), "corrupt dump");
    const failedRestore = run("scripts/restore-drill.sh", [corruptPath], {
      ...backupEnvironment,
      DCC_RESTORE_DATABASE_URL: restoreDatabaseUrl!,
      DCC_RESTORE_HEALTH_URL: healthUrl,
      DCC_RESTORE_ROOT: recoveryRoot,
    });
    expect(failedRestore.status).not.toBe(0);
    expect((await query(primaryDatabaseUrl!, "SELECT status FROM backup_recovery_verifications WHERE backup_path=$1 ORDER BY id DESC LIMIT 1", [corruptPath])).rows)
      .toEqual([{ status: "failed" }]);

    const restoreResult = run("scripts/restore-drill.sh", [backupPath], {
      ...backupEnvironment,
      DCC_RESTORE_DATABASE_URL: restoreDatabaseUrl!,
      DCC_RESTORE_HEALTH_URL: healthUrl,
      DCC_RESTORE_ROOT: recoveryRoot,
    });

    expect(restoreResult.status, restoreResult.stderr).toBe(0);
    expect((await query(
      restoreDatabaseUrl!,
      "SELECT status FROM backup_recovery_verifications WHERE backup_path=$1",
      [sourceMarker],
    )).rows).toEqual([{ status: "passed" }]);
    expect((await query(restoreDatabaseUrl!, "SELECT sha256 FROM artifacts WHERE storage_path='logs/restore-test.log'")).rows)
      .toEqual([{ sha256: artifactHash }]);
    expect((await query(restoreDatabaseUrl!, "SELECT sha256 FROM artifacts WHERE storage_path=$1", [worktreeRelative])).rows)
      .toEqual([{ sha256: createHash("sha256").update(worktreeCommit).digest("hex") }]);
    await expect(readFile(join(recoveryRoot, "data", "logs", "restore-test.log"), "utf8")).resolves.toBe(artifactBytes);
    await expect(readFile(join(recoveryRoot, "data", worktreeRelative, "result.txt"), "utf8"))
      .resolves.toBe("restored worktree bytes\n");
    await expect(readFile(join(recoveryRoot, "data", worktreeRelative, ".git"))).rejects.toThrow();
    await expect(readFile(join(recoveryRoot, "config", "projects.yaml"), "utf8")).resolves.toBe("version: 1\nprojects: {}\n");
    expect((await query(
      primaryDatabaseUrl!,
      "SELECT status FROM backup_recovery_verifications WHERE backup_path=$1 ORDER BY id DESC LIMIT 1",
      [backupPath],
    )).rows).toEqual([{ status: "passed" }]);
    expect((await fetch(healthUrl)).status).toBe(200);
  }, 30_000);
});
