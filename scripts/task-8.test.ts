import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const sha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const attemptId = "11111111-1111-4111-8111-111111111111";
const directories: string[] = [];

async function deploy({ fetchHead = sha, failMigration = false, failHealth = false, failWorker = false, failBranch = false, prior = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "dcc-deploy-"));
  directories.push(directory);
  const bin = join(directory, "bin");
  const log = join(directory, "commands.log");
  const marker = join(directory, "completion.json");
  const releases = join(directory, ".deploy-releases");
  const current = join(directory, ".deploy-current");
  const previous = join(directory, "previous-release");
  await mkdir(bin);
  await Promise.all([".env", ".env.worker"].map((file) => writeFile(join(directory, file), "# stable\n")));
  await mkdir(join(directory, "data"));
  if (prior) {
    await mkdir(previous);
    await writeFile(join(previous, "ecosystem.config.cjs"), "module.exports = {};\n");
    await symlink(previous, current);
  }
  const scripts: Record<string, string> = {
    git: `#!/bin/sh
echo "git $*" >> "$DCC_LOG"
case "$1" in
  check-ref-format) if [ "$DCC_FAIL_BRANCH" = 1 ]; then exit 1; fi ;;
  rev-parse) printf '%s\n' "$DCC_FETCH_HEAD" ;;
  worktree) mkdir -p "$4" ;;
esac
`,
    pnpm: `#!/bin/sh
echo "pnpm $*" >> "$DCC_LOG"
if [ "$DCC_FAIL_MIGRATION" = 1 ] && [ "$*" = '--filter database migrate' ]; then exit 72; fi
`,
    curl: `#!/bin/sh
echo "curl $*" >> "$DCC_LOG"
if [ "$DCC_FAIL_HEALTH" = 1 ] && [ ! -f "$DCC_HEALTH_FAILED" ]; then touch "$DCC_HEALTH_FAILED"; exit 76; fi
`,
    psql: `#!/bin/sh
echo "psql $*" >> "$DCC_LOG"
`,
    pm2: `#!/bin/sh
echo "pm2 $* current=$(readlink "$DCC_ROOT/.deploy-current" 2>/dev/null || true)" >> "$DCC_LOG"
if [ "$DCC_FAIL_WORKER" = 1 ] && [ "$*" = "startOrReload $DCC_ROOT/.deploy-current/ecosystem.config.cjs --only dcc-worker --update-env" ] && [ ! -f "$DCC_WORKER_FAILED" ]; then touch "$DCC_WORKER_FAILED"; exit 75; fi
if [ "$*" = "startOrReload $DCC_ROOT/.deploy-current/ecosystem.config.cjs --only dcc-webhook --update-env" ] && [ ! -f "$DCC_MARKER" ]; then exit 79; fi
`,
  };
  await Promise.all(Object.entries(scripts).map(async ([command, script]) => {
    const file = join(bin, command);
    await writeFile(file, script);
    await chmod(file, 0o755);
  }));
  const result = spawnSync(join(root, "deploy.sh"), [sha, marker, attemptId, "master"], {
    encoding: "utf8",
    env: {
      ...process.env,
      DATABASE_URL: "postgresql://deploy-test/dbc",
      DCC_DEPLOY_HEALTH_URL: "http://127.0.0.1/health",
      DCC_ROOT: directory,
      DCC_LOG: log,
      DCC_MARKER: marker,
      DCC_FETCH_HEAD: fetchHead,
      DCC_FAIL_MIGRATION: failMigration ? "1" : "0",
      DCC_FAIL_HEALTH: failHealth ? "1" : "0",
      DCC_FAIL_WORKER: failWorker ? "1" : "0",
      DCC_FAIL_BRANCH: failBranch ? "1" : "0",
      DCC_HEALTH_FAILED: join(directory, "health-failed"),
      DCC_WORKER_FAILED: join(directory, "worker-failed"),
      PATH: `${bin}:${process.env.PATH}`,
    },
  });
  return {
    commands: await readFile(log, "utf8"),
    current,
    directory,
    marker: JSON.parse(await readFile(marker, "utf8")),
    previous,
    releases,
    status: result.status,
  };
}

afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe("health-gated release deployment", () => {
  it("stages a detached release with frozen dependencies and atomically publishes its stable links", async () => {
    const result = await deploy();
    const release = join(result.releases, sha);

    expect(result.status).toBe(0);
    expect(result.commands).toContain("git fetch --no-tags origin master");
    expect(result.commands).toContain(`git worktree add --detach ${release} ${sha}`);
    expect(result.commands).toContain("pnpm install --frozen-lockfile");
    expect(await readlink(result.current)).toBe(release);
    expect((await lstat(result.current)).isSymbolicLink()).toBe(true);
    expect(await readlink(join(release, ".env"))).toBe(join(result.directory, ".env"));
    expect(await readlink(join(release, "data"))).toBe(join(result.directory, "data"));
  });

  it("fails before cutover when migration fails and preserves the prior release", async () => {
    const result = await deploy({ failMigration: true });

    expect(result.status).toBe(72);
    expect(await readlink(result.current)).toBe(result.previous);
    expect(result.commands).not.toContain("pm2 startOrReload");
    expect(result.marker).toEqual({ attemptId, sha, exitCode: 72 });
  });

  it("rolls back the prior release and processes when its health check fails", async () => {
    const result = await deploy({ failHealth: true });

    expect(result.status).toBe(76);
    expect(await readlink(result.current)).toBe(result.previous);
    expect(result.commands.match(/pm2 startOrReload .*dcc-web /g)).toHaveLength(2);
    expect(result.commands.match(/pm2 startOrReload .*dcc-worker /g)).toHaveLength(2);
    expect(result.commands.match(/curl /g)).toHaveLength(2);
    expect(result.marker).toEqual({ attemptId, sha, exitCode: 76 });
    expect(result.commands).not.toContain("dcc-webhook");
  });

  it("rolls back after a partial process restart", async () => {
    const result = await deploy({ failWorker: true });

    expect(result.status).toBe(75);
    expect(await readlink(result.current)).toBe(result.previous);
    expect(result.commands.match(/pm2 startOrReload .*dcc-web /g)).toHaveLength(2);
    expect(result.commands.match(/pm2 startOrReload .*dcc-worker /g)).toHaveLength(2);
    expect(result.marker).toEqual({ attemptId, sha, exitCode: 75 });
  });

  it("writes the atomic JSON completion marker before restarting the webhook", async () => {
    const result = await deploy();

    expect(result.marker).toEqual({ attemptId, sha, exitCode: 0 });
    expect(result.commands).toContain("psql");
    expect(result.commands.indexOf("pm2 startOrReload " + join(result.directory, ".deploy-current", "ecosystem.config.cjs") + " --only dcc-webhook"))
      .toBeGreaterThan(result.commands.indexOf("curl "));
  });

  it("refuses a fetched head that no longer matches the protected target", async () => {
    const result = await deploy({ fetchHead: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" });

    expect(result.status).not.toBe(0);
    expect(result.commands).not.toContain("git worktree add");
    expect(result.marker).toEqual({ attemptId, sha, exitCode: 1 });
  });

  it("writes a failure marker when protected-branch validation fails", async () => {
    const result = await deploy({ failBranch: true });

    expect(result.status).toBe(1);
    expect(result.marker).toEqual({ attemptId, sha, exitCode: 1 });
    expect(result.commands).not.toContain("git fetch");
  });
});
