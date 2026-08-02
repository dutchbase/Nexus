import { chmod, mkdtemp, mkdir, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = new URL("..", import.meta.url).pathname;
const temporaryRoots: string[] = [];

async function shellTool(directory: string, name: string, source: string) {
  const path = join(directory, name);
  await writeFile(path, source);
  await chmod(path, 0o755);
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dcc-backup-"));
  temporaryRoots.push(root);
  const bin = join(root, "bin");
  const data = join(root, "data");
  const config = join(root, "config");
  const backups = join(root, "backups");
  const commandLog = join(root, "commands.log");
  await Promise.all([
    mkdir(join(data, "secrets"), { recursive: true }),
    mkdir(join(config, "secrets"), { recursive: true }),
    mkdir(bin, { recursive: true }),
    mkdir(backups, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(data, "artifact.txt"), "artifact"),
    writeFile(join(data, ".env"), "DATABASE_URL=do-not-back-up"),
    writeFile(join(data, "secrets", "token"), "do-not-back-up"),
    writeFile(join(config, "projects.yaml"), "projects: []\n"),
    writeFile(join(config, ".env.production"), "SECRET=do-not-back-up"),
    writeFile(join(config, "secrets", "token"), "do-not-back-up"),
  ]);
  await shellTool(bin, "pg_dump", `#!/usr/bin/env bash
set -euo pipefail
printf 'pg_dump %s\\n' "$*" >> "$DCC_TEST_COMMAND_LOG"
for argument in "$@"; do case "$argument" in --file=*) printf 'custom dump\\n' > "\${argument#--file=}";; esac; done
`);
  await shellTool(bin, "pg_restore", `#!/usr/bin/env bash
set -euo pipefail
printf 'pg_restore %s\\n' "$*" >> "$DCC_TEST_COMMAND_LOG"
`);
  await shellTool(bin, "curl", `#!/usr/bin/env bash
set -euo pipefail
printf 'curl %s\\n' "$*" >> "$DCC_TEST_COMMAND_LOG"
`);
  await shellTool(bin, "psql", `#!/usr/bin/env bash
set -euo pipefail
printf 'psql %s\\n' "$*" >> "$DCC_TEST_COMMAND_LOG"
if [[ "$*" == *"SELECT current_database()"* ]]; then
  if [ "$1" = "$DATABASE_URL" ]; then
    printf '%s\\n' "\${DCC_TEST_PRIMARY_DATABASE_IDENTITY:-dcc_primary|127.0.0.1|5432}"
  else
    printf '%s\\n' "\${DCC_TEST_RESTORE_DATABASE_IDENTITY:-dcc_restore|127.0.0.1|5433}"
  fi
fi
`);
  return {
    root, backups, commandLog,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      DATABASE_URL: "postgresql://primary:primary@127.0.0.1:5432/dcc_primary",
      DCC_RESTORE_DATABASE_URL: "postgresql://restore:restore@127.0.0.1:5433/dcc_restore_test",
      DCC_RESTORE_HEALTH_URL: "http://127.0.0.1:39153/api/health",
      DCC_BACKUP_DIRECTORY: backups,
      DCC_BACKUP_RETENTION_DAYS: "2",
      DCC_DATA_DIR: data,
      DCC_CONFIG_DIR: config,
      DCC_TEST_COMMAND_LOG: commandLog,
    },
  };
}

function run(script: string, args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync("bash", [script, ...args], { cwd: repoRoot, env, encoding: "utf8" });
}

async function newestBackup(backups: string) {
  const entries = await readdir(backups, { withFileTypes: true });
  const names = entries.filter((entry) => entry.isDirectory() && entry.name.startsWith("dcc-")).map((entry) => entry.name);
  expect(names).toHaveLength(1);
  return join(backups, names[0]);
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("backup and recovery drill", () => {
  it("creates a manifest backup without secrets and applies retention", async () => {
    const test = await fixture();
    const expired = join(test.backups, "dcc-expired");
    await mkdir(expired);
    await utimes(expired, new Date("2020-01-01T00:00:00Z"), new Date("2020-01-01T00:00:00Z"));
    const staleStage = join(test.backups, ".dcc-backup.interrupted");
    const freshStage = join(test.backups, ".dcc-backup.recent");
    await Promise.all([mkdir(staleStage), mkdir(freshStage)]);
    await utimes(staleStage, new Date("2020-01-01T00:00:00Z"), new Date("2020-01-01T00:00:00Z"));

    const result = run("scripts/backup.sh", [], test.env);

    expect(result.status).toBe(0);
    const backup = await newestBackup(test.backups);
    const retainedDirectories = await readdir(test.backups);
    expect(retainedDirectories).not.toContain(".dcc-backup.interrupted");
    expect(retainedDirectories).toContain(".dcc-backup.recent");
    await expect(readFile(join(backup, "database.dump"), "utf8")).resolves.toBe("custom dump\n");
    await expect(readFile(join(backup, "data", "artifact.txt"), "utf8")).resolves.toBe("artifact");
    await expect(readFile(join(backup, "config", "projects.yaml"), "utf8")).resolves.toBe("projects: []\n");
    await expect(readFile(join(backup, "data", ".env"))).rejects.toThrow();
    await expect(readFile(join(backup, "data", "secrets", "token"))).rejects.toThrow();
    await expect(readFile(join(backup, "config", ".env.production"))).rejects.toThrow();
    await expect(readFile(join(backup, "config", "secrets", "token"))).rejects.toThrow();
    expect(spawnSync("sha256sum", ["--check", "manifest-v1.sha256"], { cwd: backup, encoding: "utf8" }).status).toBe(0);
    await expect(readFile(test.commandLog, "utf8")).resolves.toContain("pg_dump postgresql://primary:primary@127.0.0.1:5432/dcc_primary --format=custom");
  });

  it("backs up the shared data directory from DCC_DATA_ROOT when DCC_DATA_DIR is unset", async () => {
    const test = await fixture();
    const dataRoot = join(test.root, "shared-state");
    const sharedData = join(dataRoot, "data");
    await mkdir(sharedData, { recursive: true });
    await writeFile(join(sharedData, "artifact-from-data-root.txt"), "shared artifact");
    const env = { ...test.env, DCC_DATA_DIR: undefined, DCC_DATA_ROOT: dataRoot };

    expect(run("scripts/backup.sh", [], env).status).toBe(0);

    const backup = await newestBackup(test.backups);
    await expect(readFile(join(backup, "data", "artifact-from-data-root.txt"), "utf8")).resolves.toBe("shared artifact");
  });

  it("uses only explicit restore targets and records a successful recovery verification", async () => {
    const test = await fixture();
    expect(run("scripts/backup.sh", [], test.env).status).toBe(0);
    const backup = await newestBackup(test.backups);

    const result = run("scripts/restore-drill.sh", [backup], test.env);

    expect(result.status).toBe(0);
    const log = await readFile(test.commandLog, "utf8");
    expect(log).toContain("pg_restore --clean --if-exists --no-owner --dbname=postgresql://restore:restore@127.0.0.1:5433/dcc_restore_test");
    expect(log).toContain("curl --fail --silent --show-error http://127.0.0.1:39153/api/health");
    expect(log).toContain("psql postgresql://primary:primary@127.0.0.1:5432/dcc_primary");
    expect(log).toContain("backup_recovery_verifications");
    expect(log).toContain("passed");
  });

  it("refuses a restore target that resolves to the primary database despite different URLs", async () => {
    const test = await fixture();
    expect(run("scripts/backup.sh", [], test.env).status).toBe(0);
    const backup = await newestBackup(test.backups);
    const env = {
      ...test.env,
      DATABASE_URL: "postgresql://primary@primary-alias:5432/primary",
      DCC_RESTORE_DATABASE_URL: "postgresql://restore@restore-alias:5432/restore",
      DCC_TEST_PRIMARY_DATABASE_IDENTITY: "primary|10.0.0.8|5432",
      DCC_TEST_RESTORE_DATABASE_IDENTITY: "primary|10.0.0.8|5432",
    };

    const result = run("scripts/restore-drill.sh", [backup], env);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("different disposable database");
    expect(await readFile(test.commandLog, "utf8")).not.toContain("pg_restore");
  });

  it("does not restore a corrupt backup and records the failed verification", async () => {
    const test = await fixture();
    expect(run("scripts/backup.sh", [], test.env).status).toBe(0);
    const backup = await newestBackup(test.backups);
    await writeFile(join(backup, "database.dump"), "corrupt");

    const result = run("scripts/restore-drill.sh", [backup], test.env);

    expect(result.status).not.toBe(0);
    const log = await readFile(test.commandLog, "utf8");
    expect(log).not.toContain("pg_restore");
    expect(log).toContain("backup_recovery_verifications");
    expect(log).toContain("failed");
  });
});
