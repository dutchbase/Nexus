import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const sha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const attemptId = "11111111-1111-4111-8111-111111111111";
const directories: string[] = [];

async function deploy({ fetchHead = sha, failVerification = false, failMigration = false, failHealth = false, failWorker = false, failWebhook = false, failBranch = false, extraArg = false, prior = true, launchAllowed = true } = {}) {
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
echo "pnpm $* test_db=\${DCC_TEST_DATABASE_URL-unset} restore_db=\${DCC_TEST_RESTORE_DATABASE_URL-unset}" >> "$DCC_LOG"
if [ "$DCC_FAIL_VERIFICATION" = 1 ] && [ "$1" = exec ] && [ "$2" = vitest ]; then exit 73; fi
if [ "$DCC_FAIL_MIGRATION" = 1 ] && [ "$*" = '--filter database migrate' ]; then exit 72; fi
`,
    curl: `#!/bin/sh
echo "curl $*" >> "$DCC_LOG"
if [ "$DCC_FAIL_HEALTH" = 1 ] && [ ! -f "$DCC_HEALTH_FAILED" ]; then touch "$DCC_HEALTH_FAILED"; exit 76; fi
`,
    psql: `#!/bin/sh
echo "psql $*" >> "$DCC_LOG"
cat >> "$DCC_LOG"
`,
    mv: `#!/bin/sh
echo "mv $*" >> "$DCC_LOG"
exec /bin/mv "$@"
`,
    pm2: `#!/bin/sh
echo "pm2 $* current=$(readlink "$DCC_ROOT/.deploy-current" 2>/dev/null || true)" >> "$DCC_LOG"
if [ "$DCC_FAIL_WORKER" = 1 ] && [ "$*" = "startOrReload $DCC_ROOT/.deploy-current/ecosystem.config.cjs --only dcc-worker --update-env" ] && [ ! -f "$DCC_WORKER_FAILED" ]; then touch "$DCC_WORKER_FAILED"; exit 75; fi
if [ "$DCC_FAIL_WEBHOOK" = 1 ] && [ "$*" = "startOrReload $DCC_ROOT/.deploy-current/ecosystem.config.cjs --only dcc-webhook --update-env" ] && [ ! -f "$DCC_WEBHOOK_FAILED" ]; then touch "$DCC_WEBHOOK_FAILED"; exit 74; fi
if [ "$*" = "startOrReload $DCC_ROOT/.deploy-current/ecosystem.config.cjs --only dcc-webhook --update-env" ] && [ ! -f "$DCC_MARKER" ]; then exit 79; fi
`,
  };
  await Promise.all(Object.entries(scripts).map(async ([command, script]) => {
    const file = join(bin, command);
    await writeFile(file, script);
    await chmod(file, 0o755);
  }));
  const launchGate = join(directory, "launch-gate");
  await writeFile(launchGate, launchAllowed ? "1" : "");
  const gate = await open(launchGate, "r");
  const result = spawnSync(join(root, "deploy.sh"), [sha, marker, attemptId, "master", ...(extraArg ? ["unexpected"] : [])], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe", gate.fd],
    env: {
      ...process.env,
      DATABASE_URL: "postgresql://deploy-test/dbc",
      DCC_DEPLOY_HEALTH_URL: "http://127.0.0.1/health",
      DCC_DEPLOY_LAUNCH_FD: "3",
      DCC_ROOT: directory,
      DCC_LOG: log,
      DCC_MARKER: marker,
      DCC_FETCH_HEAD: fetchHead,
      DCC_TEST_DATABASE_URL: "must-be-unset",
      DCC_TEST_RESTORE_DATABASE_URL: "must-be-unset",
      DCC_FAIL_VERIFICATION: failVerification ? "1" : "0",
      DCC_FAIL_MIGRATION: failMigration ? "1" : "0",
      DCC_FAIL_HEALTH: failHealth ? "1" : "0",
      DCC_FAIL_WORKER: failWorker ? "1" : "0",
      DCC_FAIL_WEBHOOK: failWebhook ? "1" : "0",
      DCC_FAIL_BRANCH: failBranch ? "1" : "0",
      DCC_HEALTH_FAILED: join(directory, "health-failed"),
      DCC_WORKER_FAILED: join(directory, "worker-failed"),
      DCC_WEBHOOK_FAILED: join(directory, "webhook-failed"),
      PATH: `${bin}:${process.env.PATH}`,
    },
  });
  await gate.close();
  return {
    commands: await readFile(log, "utf8").catch(() => ""),
    current,
    directory,
    marker: await readFile(marker, "utf8").then(JSON.parse).catch(() => null),
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

  it("verifies the staged release locally before migration without test databases", async () => {
    const result = await deploy();

    const installed = result.commands.indexOf("pnpm install --frozen-lockfile");
    const verified = result.commands.indexOf("pnpm exec vitest run --config vitest.config.ts --reporter=verbose --no-file-parallelism --testTimeout=15000 test_db=unset restore_db=unset");
    const verificationEvent = result.commands.indexOf("--set=stage=local_verification_passed");
    const migrated = result.commands.indexOf("pnpm --filter database migrate");
    expect(verified).toBeGreaterThan(installed);
    expect(verificationEvent).toBeGreaterThan(verified);
    expect(migrated).toBeGreaterThan(verificationEvent);
  });

  it("keeps the prior release when local verification fails", async () => {
    const result = await deploy({ failVerification: true });

    expect(result.status).toBe(73);
    expect(await readlink(result.current)).toBe(result.previous);
    expect(result.commands).not.toContain("pnpm --filter database migrate");
    expect(result.commands).not.toContain("--set=stage=local_verification_passed");
    expect(result.commands).not.toContain("pm2 startOrReload");
    expect(result.marker).toEqual({ attemptId, sha, exitCode: 73 });
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
    expect(result.commands.match(/pm2 startOrReload .*dcc-webhook /g)).toHaveLength(1);
  });

  it("rolls back after a partial process restart", async () => {
    const result = await deploy({ failWorker: true });

    expect(result.status).toBe(75);
    expect(await readlink(result.current)).toBe(result.previous);
    expect(result.commands.match(/pm2 startOrReload .*dcc-web /g)).toHaveLength(2);
    expect(result.commands.match(/pm2 startOrReload .*dcc-worker /g)).toHaveLength(2);
    expect(result.commands.match(/pm2 startOrReload .*dcc-webhook /g)).toHaveLength(1);
    expect(result.marker).toEqual({ attemptId, sha, exitCode: 75 });
  });

  it("keeps the bootstrap webhook alive to consume a failed marker", async () => {
    const result = await deploy({ prior: false, failHealth: true });

    expect(result.status).toBe(76);
    expect(result.commands).toContain("pm2 delete dcc-web");
    expect(result.commands).toContain("pm2 delete dcc-worker");
    expect(result.commands).not.toContain("dcc-webhook");
    expect(result.marker).toEqual({ attemptId, sha, exitCode: 76 });
  });

  it("writes the atomic JSON completion marker before restarting the webhook", async () => {
    const result = await deploy();

    expect(result.marker).toEqual({ attemptId, sha, exitCode: 0, reloadPending: true });
    expect(result.commands).toContain("psql");
    expect(result.commands.indexOf("pm2 startOrReload " + join(result.directory, ".deploy-current", "ecosystem.config.cjs") + " --only dcc-webhook"))
      .toBeGreaterThan(result.commands.indexOf("curl "));
  });

  it("does not enter deployment stages until the inherited launch gate is released", async () => {
    const result = await deploy({ launchAllowed: false });

    expect(result.status).not.toBe(0);
    expect(result.commands).not.toContain("git fetch");
    expect(result.commands).not.toContain("pnpm ");
    expect(result.marker).toEqual({ attemptId, sha, exitCode: 1 });
  });

  it("persists rollback target evidence before atomically switching current", async () => {
    const result = await deploy();
    const evidence = result.commands.indexOf("--set=event_type=cutover_prepared");
    const cutover = result.commands.indexOf(`mv -Tf ${result.current}.next ${result.current}`);

    expect(evidence).toBeGreaterThanOrEqual(0);
    expect(cutover).toBeGreaterThan(evidence);
    expect(result.commands).toContain("prior_release_path");
    expect(result.commands).toContain("target_release_path");
  });

  it("replaces pending success with failure and restores the webhook when webhook reload fails", async () => {
    const result = await deploy({ failWebhook: true });

    expect(result.status).toBe(74);
    expect(await readlink(result.current)).toBe(result.previous);
    expect(result.commands.match(/pm2 startOrReload .*dcc-webhook /g)).toHaveLength(2);
    expect(result.marker).toEqual({ attemptId, sha, exitCode: 74 });
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

  it("rejects extra deploy arguments", async () => {
    const result = await deploy({ extraArg: true });

    expect(result.status).toBe(1);
    expect(result.marker).toBeNull();
    expect(result.commands).toBe("");
  });

  it("stages all imported artifacts before detecting Superpowers updates", async () => {
    const workflow = await readFile(join(root, ".github/workflows/superpowers-update.yml"), "utf8");
    const readme = await readFile(join(root, "README.md"), "utf8");

    expect(workflow).toContain('cron: "17 4 * * *"');
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("gh release view");
    expect(workflow).toContain("automation/superpowers-${TAG}");
    expect(workflow).toContain("pnpm exec tsx scripts/update-superpowers.ts --checkout");
    expect(workflow).toContain("pnpm test:unit");
    expect(workflow.indexOf("git add config/agent-content.json prompts/global/code-reviewer.md skills/vendor/superpowers"))
      .toBeLessThan(workflow.indexOf("git diff --cached --quiet"));
    expect(workflow).toContain("gh pr create");
    expect(readme).toContain("signed protected-branch push");
    expect(readme).toContain("pnpm verify locally before migrations");
    expect(readme).toContain("GitHub Actions are not a deployment prerequisite");
    expect(readme).toContain("A fetched SHA mismatch fails before staging, writes a nonzero marker, and the webhook finalizes the attempt as failed.");
  });
});
