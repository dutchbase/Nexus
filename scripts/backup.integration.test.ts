import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
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

function databaseIdentity(connectionString: string) {
  const url = new URL(connectionString);
  return [url.hostname, url.port || "5432", url.pathname].join("|");
}

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

integration("backup recovery drill integration", () => {
  let root = "";
  let healthProcess: ReturnType<typeof spawn> | undefined;

  beforeEach(async () => {
    if (databaseIdentity(primaryDatabaseUrl!) === databaseIdentity(restoreDatabaseUrl!)) {
      throw new Error("DCC_TEST_RESTORE_DATABASE_URL must identify a distinct disposable database");
    }
    await resetDatabase(primaryDatabaseUrl!);
    await resetDatabase(restoreDatabaseUrl!);
    await migrate({ connectionString: primaryDatabaseUrl! });
    await migrate({ connectionString: restoreDatabaseUrl! });
    root = await mkdtemp(join(tmpdir(), "dcc-backup-integration-"));
    await Promise.all([mkdir(join(root, "data")), mkdir(join(root, "config"))]);
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
    await query(
      primaryDatabaseUrl!,
      "INSERT INTO backup_recovery_verifications (backup_path,manifest_sha256,status) VALUES ($1,repeat($q$a$q$,64),$q$passed$q$)",
      [sourceMarker],
    );
    const backupRoot = join(root, "backups");
    const backupEnvironment = {
      ...process.env,
      DATABASE_URL: primaryDatabaseUrl!,
      DCC_BACKUP_DIRECTORY: backupRoot,
      DCC_BACKUP_RETENTION_DAYS: "2",
      DCC_DATA_DIR: join(root, "data"),
      DCC_CONFIG_DIR: join(root, "config"),
    };
    expect(run("scripts/backup.sh", [], backupEnvironment).status).toBe(0);
    const backups = (await readdir(backupRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("dcc-"));
    expect(backups).toHaveLength(1);
    const backupPath = join(backupRoot, backups[0].name);

    const port = await freePort();
    const healthUrl = "http://127.0.0.1:" + port + "/api/health";
    healthProcess = spawn("pnpm", ["exec", "tsx", "apps/web/src/server.ts"], {
      cwd: repoRoot,
      env: { ...process.env, DATABASE_URL: restoreDatabaseUrl!, PORT: String(port), HOST: "127.0.0.1", DCC_DATA_DIR: join(root, "restore-data") },
      stdio: "ignore",
    });
    await waitForHealth(healthUrl);

    const restoreResult = run("scripts/restore-drill.sh", [backupPath], {
      ...backupEnvironment,
      DCC_RESTORE_DATABASE_URL: restoreDatabaseUrl!,
      DCC_RESTORE_HEALTH_URL: healthUrl,
    });

    expect(restoreResult.status, restoreResult.stderr).toBe(0);
    expect((await query(
      restoreDatabaseUrl!,
      "SELECT status FROM backup_recovery_verifications WHERE backup_path=$1",
      [sourceMarker],
    )).rows).toEqual([{ status: "passed" }]);
    expect((await query(
      primaryDatabaseUrl!,
      "SELECT status FROM backup_recovery_verifications WHERE backup_path=$1 ORDER BY id DESC LIMIT 1",
      [backupPath],
    )).rows).toEqual([{ status: "passed" }]);
    expect((await fetch(healthUrl)).status).toBe(200);
  }, 30_000);
});
