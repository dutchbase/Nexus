import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, test } from "vitest";

const root = resolve(import.meta.dirname, "../../..");

test.each([undefined, "web"])("worker startup fails closed for role %s", (role) => {
  const result = spawnSync("pnpm", ["exec", "tsx", "apps/worker/src/worker.ts"], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
    env: { ...process.env, DCC_PROCESS_ROLE: role },
  });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("worker requires DCC_PROCESS_ROLE=worker");
});
