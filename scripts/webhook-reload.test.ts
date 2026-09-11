import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const directories: string[] = [];

async function runReloader({ failStart = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "dcc-webhook-reload-"));
  directories.push(directory);
  const bin = join(directory, "bin");
  const log = join(directory, "commands.log");
  const marker = join(directory, "completion.json");
  const current = join(directory, "current");
  await mkdir(bin);
  await mkdir(current);
  await writeFile(marker, '{"attemptId":"a","sha":"b"}');

  const pm2Script = `#!/bin/sh
echo "pm2 $*" >> "${log}"
case "$*" in
  *"--only dcc-webhook --update-env"*)
    ${failStart ? "exit 74" : ": ok"} ;;
esac
`;
  await writeFile(join(bin, "pm2"), pm2Script);
  await chmod(join(bin, "pm2"), 0o755);

  const result = spawnSync("bash", [join(root, "scripts/webhook-reload.sh")], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      DCC_SWAP_INLINE: "1",
      DCC_SWAP_MARKER: marker,
      DCC_SWAP_ATTEMPT_ID: "11111111-1111-4111-8111-111111111111",
      DCC_SWAP_SHA: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      DCC_SWAP_CURRENT: current,
      DCC_SWAP_DELAY: "0",
    },
  });
  return { commands: await readFile(log, "utf8").catch(() => ""), status: result.status };
}

afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe("webhook-reload.sh", () => {
  it("persists the pm2 snapshot after successfully reloading the webhook", async () => {
    const result = await runReloader();

    expect(result.status).toBe(0);
    const started = result.commands.indexOf("pm2 start");
    const saved = result.commands.indexOf("pm2 save", started);
    expect(started).toBeGreaterThanOrEqual(0);
    expect(saved).toBeGreaterThan(started);
  });

  it("does not attempt to save when the webhook fails to start", async () => {
    const result = await runReloader({ failStart: true });

    expect(result.status).toBe(75);
    expect(result.commands).not.toContain("pm2 save");
  });
});
