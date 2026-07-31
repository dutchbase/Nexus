import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const exec = promisify(execFile);

test("creates main-branch fixture commits under the global hook policy", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dcc-fixtures-"));
  try {
    const script = path.resolve(".lfd/dcc-build/harness/git-fixtures/create-fixtures.sh");
    const { stdout } = await exec("bash", [script, "--root", root]);
    const repo = path.join(root, "repos", "billing-api");

    expect(stdout).toContain(`FIXTURE_REPO_BILLING_API=${repo}`);
    expect((await exec("git", ["-C", repo, "rev-parse", "--verify", "HEAD"])).stdout.trim()).toMatch(/^[0-9a-f]{40}$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
