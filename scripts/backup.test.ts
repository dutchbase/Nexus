import { chmod, mkdtemp, mkdir, readdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
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
  const legacyData = join(root, "legacy", "data");
  const config = join(root, "config");
  const backups = join(root, "backups");
  const recoveryRoot = join(root, "recovery");
  const restoreComplete = join(root, "restore-complete");
  const commandLog = join(root, "commands.log");
  await Promise.all([
    mkdir(join(data, "secrets"), { recursive: true }),
    mkdir(join(data, "nested"), { recursive: true }),
    mkdir(legacyData, { recursive: true }),
    mkdir(join(config, "secrets"), { recursive: true }),
    mkdir(bin, { recursive: true }),
    mkdir(backups, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(data, "nested", "manifest-v1.sha256"), "nested manifest"),
    writeFile(join(data, "artifact.txt"), "artifact"),
    writeFile(join(legacyData, "legacy-artifact.txt"), "legacy artifact"),
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
touch "$DCC_TEST_RESTORE_COMPLETE"
printf 'pg_restore %s\\n' "$*" >> "$DCC_TEST_COMMAND_LOG"
`);
  await shellTool(bin, "curl", `#!/usr/bin/env bash
set -euo pipefail
printf "curl %s\n" "$*" >> "$DCC_TEST_COMMAND_LOG"
if [ "$DCC_TEST_HEALTH_UNREACHABLE" = "true" ]; then exit 7; fi
identity="\${DCC_TEST_HEALTH_DATABASE_IDENTITY:-1639b9318a3b6e0d3c7ac28cc33e5cebd5adcf7919669ad672453e235f6f181a}"
if [ -f "\${DCC_TEST_RESTORE_COMPLETE:-}" ]; then identity="\${DCC_TEST_POST_RESTORE_HEALTH_DATABASE_IDENTITY:-\$identity}"; fi
data_identity="$(node -e 'const {createHash}=require("node:crypto"),{resolve}=require("node:path");process.stdout.write(createHash("sha256").update(resolve(process.argv[1])).digest("hex"))' "$DCC_RESTORE_ROOT/data")"
config_identity="$(node -e 'const {createHash}=require("node:crypto"),{resolve}=require("node:path");process.stdout.write(createHash("sha256").update(resolve(process.argv[1])).digest("hex"))' "$DCC_RESTORE_ROOT/config")"
printf "{\\"status\\":\\"ok\\",\\"database_identity\\":\\"%s\\",\\"data_root_identity\\":\\"%s\\",\\"config_root_identity\\":\\"%s\\"}\n" "$identity" "$data_identity" "$config_identity"
`);
  await shellTool(bin, "mv", `#!/usr/bin/env bash
target="$(printf "%s\n" "$@" | tail -n 1)"
if [ "$DCC_TEST_PUBLISH_RACE" = "true" ]; then mkdir -p "$target"; fi
if [ "$DCC_TEST_PUBLISH_RACE" = "true" ] && [[ "$*" == *".dcc-restore."* ]]; then mkdir -p "$target"; fi
exec /bin/mv "$@"
`);
  await shellTool(bin, "psql", `#!/usr/bin/env bash
set -euo pipefail
printf 'psql %s\\n' "$*" >> "$DCC_TEST_COMMAND_LOG"
query="$(cat)"
printf '%s\n' "$query" >> "$DCC_TEST_COMMAND_LOG"
input="$* $query"
if [[ "$input" == *"pg_control_system()"* ]]; then
  if [ "$1" = "$DATABASE_URL" ]; then
    printf "%s\n" "\${DCC_TEST_PRIMARY_DATABASE_IDENTITY:-dcc_primary|127.0.0.1|5432}"
  else
    printf "%s\n" "\${DCC_TEST_RESTORE_DATABASE_IDENTITY:-dcc_restore|127.0.0.1|5433}"
  fi
elif [[ "$input" == *"SELECT current_database()"* ]]; then
  if [ "$1" = "$DATABASE_URL" ]; then
    printf "%s\n" "legacy-primary"
  else
    printf "%s\n" "legacy-restore"
  fi
fi
if [[ "$input" == *"pg_db_role_setting"* ]]; then
  printf "%s\n" "\${DCC_TEST_RESTORE_DATABASE_MARKER:-true}"
fi
if [[ "$input" == *"current_setting"* ]]; then
  printf "%s\n" "\${DCC_TEST_SESSION_DISPOSABLE:-false}"
fi
if [[ "$input" == *"to_regclass"* ]]; then
  printf "%s\n" "\${DCC_TEST_RESTORED_PROJECTS_TABLE:-projects}"
fi
if [[ "$input" == *"SELECT encode(digest"* ]] && [[ "$input" == *"FROM artifacts WHERE status"* ]]; then
  if [ "\${DCC_TEST_INCONSISTENT_SNAPSHOT:-false}" = true ] && [ -f "$DCC_TEST_ARTIFACT_SNAPSHOT_SEEN" ]; then printf '%064d\n' 2; else printf '%064d\n' 1; fi
  touch "$DCC_TEST_ARTIFACT_SNAPSHOT_SEEN"
fi
if [[ "$input" == *"SELECT json_build_object"* ]]; then
  row="\${DCC_TEST_ARTIFACT_REGISTRY_ROW:-}"
  if [ "$1" != "$DATABASE_URL" ]; then row="\${DCC_TEST_RESTORED_ARTIFACT_REGISTRY_ROW:-\$row}"; fi
  if [ -n "$row" ]; then printf '%s\n' "$row"; fi
fi
`);
  return {
    root, backups, commandLog,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      DCC_TEST_PUBLISH_RACE: "false",
      DATABASE_URL: "postgresql://primary:primary@127.0.0.1:5432/dcc_primary",
      DCC_RESTORE_DATABASE_URL: "postgresql://restore:restore@127.0.0.1:5433/dcc_restore_test",
      DCC_RESTORE_HEALTH_URL: "http://127.0.0.1:39153/api/health",
      DCC_BACKUP_DIRECTORY: backups,
      DCC_BACKUP_RETENTION_DAYS: "2",
      DCC_RESTORE_ROOT: recoveryRoot,
      DCC_TEST_RESTORE_COMPLETE: restoreComplete,
      DCC_TEST_HEALTH_UNREACHABLE: "false",
      DCC_DATA_DIR: data,
      DCC_DATA_ROOT: join(root, "legacy"),
      DCC_CONFIG_DIR: config,
      DCC_TEST_COMMAND_LOG: commandLog,
      DCC_TEST_ARTIFACT_SNAPSHOT_SEEN: join(root, "artifact-snapshot-seen"),
    },
  };
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
    await expect(readFile(join(backup, "legacy-data", "legacy-artifact.txt"), "utf8")).resolves.toBe("legacy artifact");
    await expect(readFile(join(backup, "config", "projects.yaml"), "utf8")).resolves.toBe("projects: []\n");
    await expect(readFile(join(backup, "data", "nested", "manifest-v1.sha256"), "utf8")).resolves.toBe("nested manifest");
    await expect(readFile(join(backup, "data", ".env"))).rejects.toThrow();
    await expect(readFile(join(backup, "data", "secrets", "token"))).rejects.toThrow();
    await expect(readFile(join(backup, "config", ".env.production"))).rejects.toThrow();
    await expect(readFile(join(backup, "config", "secrets", "token"))).rejects.toThrow();
    expect(spawnSync("sha256sum", ["--check", "manifest-v1.sha256"], { cwd: backup, encoding: "utf8" }).status).toBe(0);
    await expect(readFile(test.commandLog, "utf8")).resolves.toContain("pg_dump postgresql://primary:primary@127.0.0.1:5432/dcc_primary --format=custom");
  });

  it("preserves symlinks in the backup manifest", async () => {
    const test = await fixture();
    await symlink(join(test.root, "outside"), join(test.env.DCC_DATA_DIR!, "linked"));
    expect(run("scripts/backup.sh", [], test.env).status).toBe(0);
    const [backup] = await readdir(test.backups);
    await expect(readFile(join(test.backups, backup, "manifest-v1.sha256"), "utf8")).resolves.toContain("symlink ./data/linked");
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
  it("fails before publication or retention when a required root is missing", async () => {
    const test = await fixture();
    const prior = join(test.backups, "dcc-prior");
    await mkdir(prior);
    const result = run("scripts/backup.sh", [], { ...test.env, DCC_CONFIG_DIR: join(test.root, "missing-config") });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("required backup root");
    expect(await readdir(test.backups)).toContain("dcc-prior");
    await expect(readFile(test.commandLog, "utf8")).rejects.toThrow();
  });

  it("fails before publication when artifact metadata changes during capture", async () => {
    const test = await fixture();
    const result = run("scripts/backup.sh", [], { ...test.env, DCC_TEST_INCONSISTENT_SNAPSHOT: "true" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("artifact metadata changed");
    expect((await readdir(test.backups)).filter((name) => name.startsWith("dcc-"))).toEqual([]);
  });

  it("fails before publication when copied finalized bytes disagree with the registry hash", async () => {
    const test = await fixture();
    const row = JSON.stringify({
      id: "11111111-1111-4111-8111-111111111111", storage_path: "artifact.txt",
      storage_root: "primary", artifact_type: "execution_log", status: "finalized", sha256: "0".repeat(64),
    });
    const result = run("scripts/backup.sh", [], { ...test.env, DCC_TEST_ARTIFACT_REGISTRY_ROW: row });
    expect(result.status).not.toBe(0);
    expect((await readdir(test.backups)).filter((name) => name.startsWith("dcc-"))).toEqual([]);
  });

  it("rejects a registered artifact reached through an intermediate symlink", async () => {
    const test = await fixture();
    const outside = join(test.root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "artifact.txt"), "outside artifact");
    await symlink(outside, join(test.env.DCC_DATA_DIR!, "escape"));
    const row = JSON.stringify({
      id: "11111111-1111-4111-8111-111111111111", storage_path: "escape/artifact.txt",
      storage_root: "primary", artifact_type: "execution_log", status: "finalized",
      sha256: createHash("sha256").update("outside artifact").digest("hex"),
    });

    const result = run("scripts/backup.sh", [], { ...test.env, DCC_TEST_ARTIFACT_REGISTRY_ROW: row });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("escapes backup root");
  });

  it("archives a finalized Git worktree without retaining its live checkout metadata", async () => {
    const test = await fixture();
    const repository = join(test.root, "repository");
    const worktree = join(test.env.DCC_DATA_DIR!, "worktrees", "acme", "T-1", "1");
    await mkdir(repository);
    git(repository, ["init", "--initial-branch=trunk"]);
    await writeFile(join(repository, "result.txt"), "committed result\n");
    git(repository, ["add", "result.txt"]);
    git(repository, ["commit", "-m", "result"]);
    await mkdir(join(worktree, ".."), { recursive: true });
    git(repository, ["worktree", "add", "--detach", worktree, "HEAD"]);
    const commit = git(worktree, ["rev-parse", "HEAD"]);
    const row = JSON.stringify({
      id: "11111111-1111-4111-8111-111111111111", storage_path: "worktrees/acme/T-1/1",
      storage_root: "primary", artifact_type: "worktree", status: "finalized",
      sha256: createHash("sha256").update(commit).digest("hex"),
    });

    const result = run("scripts/backup.sh", [], { ...test.env, DCC_TEST_ARTIFACT_REGISTRY_ROW: row });

    expect(result.status, result.stderr).toBe(0);
    const backup = await newestBackup(test.backups);
    await expect(readFile(join(backup, "data", "worktrees", "acme", "T-1", "1", "result.txt"), "utf8"))
      .resolves.toBe("committed result\n");
    await expect(readFile(join(backup, "data", "worktrees", "acme", "T-1", "1", ".git")))
      .rejects.toThrow();
  });

  it("rejects a restored database whose artifact registry is absent from the backup payload", async () => {
    const test = await fixture();
    expect(run("scripts/backup.sh", [], test.env).status).toBe(0);
    const missing = JSON.stringify({
      id: "11111111-1111-4111-8111-111111111111", storage_path: "missing.txt",
      storage_root: "primary", artifact_type: "execution_log", status: "finalized", sha256: "0".repeat(64),
    });

    const result = run("scripts/restore-drill.sh", [await newestBackup(test.backups)], {
      ...test.env,
      DCC_TEST_RESTORED_ARTIFACT_REGISTRY_ROW: missing,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("restored artifact registry");
  });


  it("uses only explicit restore targets and records a successful recovery verification", async () => {
    const test = await fixture();
    expect(run("scripts/backup.sh", [], test.env).status).toBe(0);
    const backup = await newestBackup(test.backups);

    const result = run("scripts/restore-drill.sh", [backup], test.env);

    expect(result.status).toBe(0);
    await expect(readFile(join(test.root, "recovery", "data", "artifact.txt"), "utf8")).resolves.toBe("artifact");
    await expect(readFile(join(test.root, "recovery", "legacy-data", "legacy-artifact.txt"), "utf8")).resolves.toBe("legacy artifact");
    await expect(readFile(join(test.root, "recovery", "config", "projects.yaml"), "utf8")).resolves.toBe("projects: []\n");
    const log = await readFile(test.commandLog, "utf8");
    expect(log).toContain("pg_restore --clean --if-exists --no-owner --dbname=postgresql://restore:restore@127.0.0.1:5433/dcc_restore_test");
    expect(log).toContain("curl --fail --silent --show-error http://127.0.0.1:39153/api/health");
    expect(log).toContain("psql postgresql://primary:primary@127.0.0.1:5432/dcc_primary");
    expect(log).toContain("pg_control_system()");
    expect(log).toContain("backup_recovery_verifications");
    expect(log).toContain("passed");
  });

  it("rejects a healthy endpoint connected to a different database", async () => {
    const test = await fixture();
    expect(run("scripts/backup.sh", [], test.env).status).toBe(0);
    const backup = await newestBackup(test.backups);

    const result = run("scripts/restore-drill.sh", [backup], {
      ...test.env,
      DCC_TEST_HEALTH_DATABASE_IDENTITY: "0000000000000000000000000000000000000000000000000000000000000000",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("health endpoint");
    expect(await readFile(test.commandLog, "utf8")).not.toContain("pg_restore");
    expect(await readFile(test.commandLog, "utf8")).toContain("backup_recovery_verifications");
    expect(await readFile(test.commandLog, "utf8")).toContain("failed");
  });

  it("does not restore when the required health endpoint is unreachable", async () => {
    const test = await fixture();
    expect(run("scripts/backup.sh", [], test.env).status).toBe(0);
    const backup = await newestBackup(test.backups);

    const result = run("scripts/restore-drill.sh", [backup], { ...test.env, DCC_TEST_HEALTH_UNREACHABLE: "true" });

    expect(result.status).not.toBe(0);
    expect(await readFile(test.commandLog, "utf8")).not.toContain("pg_restore");
  });

  it("fails when the restored application schema is absent", async () => {
    const test = await fixture();
    expect(run("scripts/backup.sh", [], test.env).status).toBe(0);
    const result = run("scripts/restore-drill.sh", [await newestBackup(test.backups)], { ...test.env, DCC_TEST_RESTORED_PROJECTS_TABLE: "missing" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("restored application schema is incomplete");
  });

  it("fails when the post-restore health endpoint changes database identity", async () => {
    const test = await fixture();
    expect(run("scripts/backup.sh", [], test.env).status).toBe(0);
    const backup = await newestBackup(test.backups);
    const result = run("scripts/restore-drill.sh", [backup], { ...test.env, DCC_TEST_POST_RESTORE_HEALTH_DATABASE_IDENTITY: "0000000000000000000000000000000000000000000000000000000000000000" });
    expect(result.status).not.toBe(0);
    expect(await readFile(test.commandLog, "utf8")).toContain("failed");
  });

  it("refuses an explicit restore target that is not marked disposable", async () => {
    const test = await fixture();
    expect(run("scripts/backup.sh", [], test.env).status).toBe(0);
    const backup = await newestBackup(test.backups);

    const result = run("scripts/restore-drill.sh", [backup], { ...test.env, DCC_TEST_RESTORE_DATABASE_MARKER: "false" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("marked disposable");
    expect(await readFile(test.commandLog, "utf8")).not.toContain("pg_restore");
  });

  it("refuses a session-supplied disposable marker without a database marker", async () => {
    const test = await fixture();
    expect(run("scripts/backup.sh", [], test.env).status).toBe(0);
    const backup = await newestBackup(test.backups);

    const result = run("scripts/restore-drill.sh", [backup], {
      ...test.env,
      DCC_RESTORE_DATABASE_URL: "postgresql://restore@127.0.0.1:5433/dcc_restore_test?options=-c%20dcc.restore_disposable%3Dtrue",
      DCC_TEST_RESTORE_DATABASE_MARKER: "false",
      DCC_TEST_SESSION_DISPOSABLE: "true",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("marked disposable");
    expect(await readFile(test.commandLog, "utf8")).not.toContain("pg_restore");
  });

  it("refuses a primary database reached through an alternate connection path", async () => {
    const test = await fixture();
    expect(run("scripts/backup.sh", [], test.env).status).toBe(0);
    const backup = await newestBackup(test.backups);
    const env = {
      ...test.env,
      DATABASE_URL: "postgresql:///primary?host=/var/run/postgresql",
      DCC_RESTORE_DATABASE_URL: "postgresql://restore@restore-alias:5432/restore",
      DCC_TEST_PRIMARY_DATABASE_IDENTITY: "primary|cluster-a",
      DCC_TEST_RESTORE_DATABASE_IDENTITY: "primary|cluster-a",
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

  it("rejects existing and live recovery roots before restore", async () => {
    const test = await fixture();
    expect(run("scripts/backup.sh", [], test.env).status).toBe(0);
    const backup = await newestBackup(test.backups);
    await mkdir(test.env.DCC_RESTORE_ROOT!);
    await writeFile(join(test.env.DCC_RESTORE_ROOT!, "stale.txt"), "keep me");

    const existing = run("scripts/restore-drill.sh", [backup], test.env);
    expect(existing.status).not.toBe(0);
    await expect(readFile(join(test.env.DCC_RESTORE_ROOT!, "stale.txt"), "utf8")).resolves.toBe("keep me");

    const live = run("scripts/restore-drill.sh", [backup], {
      ...test.env,
      DCC_RESTORE_ROOT: join(test.env.DCC_DATA_DIR!, "recovery"),
    });
    expect(live.status).not.toBe(0);
    expect(await readFile(test.commandLog, "utf8")).not.toContain("pg_restore");
  });

  it("rejects unmanifested backup payload files before restore", async () => {
    const test = await fixture();
    expect(run("scripts/backup.sh", [], test.env).status).toBe(0);
    const backup = await newestBackup(test.backups);
    await writeFile(join(backup, "data", "unmanifested.txt"), "unexpected");

    const result = run("scripts/restore-drill.sh", [backup], test.env);
    expect(result.status).not.toBe(0);
    await expect(readFile(join(test.env.DCC_RESTORE_ROOT!, "data", "artifact.txt"))).rejects.toThrow();
    expect(await readFile(test.commandLog, "utf8")).not.toContain("pg_restore");
  });
  it("fails the late recovery-root publish race without nesting payloads", async () => {
    const test = await fixture();
    expect(run("scripts/backup.sh", [], test.env).status).toBe(0);
    const backup = await newestBackup(test.backups);
    const result = run("scripts/restore-drill.sh", [backup], { ...test.env, DCC_TEST_PUBLISH_RACE: "true" });
    expect(result.status).not.toBe(0);
    expect(await readdir(test.env.DCC_RESTORE_ROOT!).catch(() => [])).toEqual([]);
    const log = await readFile(test.commandLog, "utf8");
    expect(log).toContain("failed");
    expect(log).not.toContain("passed");
  });


  it("rejects checksum-mismatched payloads before restore", async () => {
    const test = await fixture();
    expect(run("scripts/backup.sh", [], test.env).status).toBe(0);
    const backup = await newestBackup(test.backups);
    await writeFile(join(backup, "data", "artifact.txt"), "tampered");

    const result = run("scripts/restore-drill.sh", [backup], test.env);
    expect(result.status).not.toBe(0);
    await expect(readFile(join(test.env.DCC_RESTORE_ROOT!, "data", "artifact.txt"))).rejects.toThrow();
    expect(await readFile(test.commandLog, "utf8")).not.toContain("pg_restore");
  });

});
