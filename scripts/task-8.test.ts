import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const directories: string[] = [];

async function deploy({ failSync = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "dcc-deploy-"));
  directories.push(directory);
  const bin = join(directory, "bin");
  const log = join(directory, "commands.log");
  const marker = join(directory, "marker");
  await mkdir(bin);
  await Promise.all(["git", "pnpm", "pm2"].map(async (command) => {
    const script = `#!/bin/sh\necho '${command}' \"$*\" >> \"$DCC_LOG\"\n${command === "pnpm" ? "if [ \"$DCC_FAIL_SYNC\" = 1 ] && [ \"$*\" = 'exec tsx scripts/sync-agent-content.ts' ]; then exit 78; fi\n" : ""}${command === "pm2" ? "if [ \"$*\" = 'restart dcc-webhook' ] && [ ! -f \"$DCC_MARKER\" ]; then exit 79; fi\n" : ""}`;
    const file = join(bin, command);
    await writeFile(file, script);
    await chmod(file, 0o755);
  }));
  const result = spawnSync(join(root, "deploy.sh"), ["deadbeef", marker], {
    encoding: "utf8",
    env: { ...process.env, DCC_ROOT: directory, DCC_LOG: log, DCC_MARKER: marker, DCC_FAIL_SYNC: failSync ? "1" : "0", PATH: `${bin}:${process.env.PATH}` },
  });
  return { commands: await readFile(log, "utf8"), marker: await readFile(marker, "utf8"), status: result.status };
}

afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe("Task 8 automation", () => {
  it("writes the success marker before restarting the webhook", async () => {
    expect(await readFile(join(root, "deploy.sh"), "utf8")).toContain("DCC_ROOT");
    const result = await deploy();

    expect(result.commands).toBe([
      "git fetch origin master",
      "git checkout master",
      "git reset --hard deadbeef",
      "pnpm install --frozen-lockfile",
      "pnpm --filter database migrate",
      "pnpm exec tsx scripts/sync-agent-content.ts",
      "pm2 restart dcc-web dcc-worker",
      "pm2 restart dcc-webhook",
      "",
    ].join("\n"));
    expect(result.marker).toBe("0");
    expect(result.status).toBe(0);
  });

  it("does not restart processes when content sync fails", async () => {
    expect(await readFile(join(root, "deploy.sh"), "utf8")).toContain("DCC_ROOT");
    const result = await deploy({ failSync: true });
    expect(result.status).toBe(78);
    expect(result.commands).not.toContain("pm2 restart");
    expect(result.marker).toBe("78");
  });

  it("stages all imported artifacts before detecting updates and runs the scoped fail-closed suite", async () => {
    const workflow = await readFile(join(root, ".github/workflows/superpowers-update.yml"), "utf8");
    const ci = await readFile(join(root, ".github/workflows/ci.yml"), "utf8");

    expect(workflow).toContain('cron: "17 4 * * *"');
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("gh release view");
    expect(workflow).toContain("automation/superpowers-${TAG}");
    expect(workflow).toContain("pnpm exec tsx scripts/update-superpowers.ts --checkout");
    expect(workflow).toContain("pnpm test:unit");
    expect(workflow.indexOf("git add config/agent-content.json prompts/global/code-reviewer.md skills/vendor/superpowers"))
      .toBeLessThan(workflow.indexOf("git diff --cached --quiet"));
    expect(workflow).toContain("gh pr create");
    expect(ci).toContain("pnpm test:unit");
    expect(ci).not.toContain("|| echo");
  });
});
