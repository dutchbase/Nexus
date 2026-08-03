import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { artifactDataRoot } from "../../database/src/artifacts.ts";
import { createExecutionWorktree } from "./index.ts";

const exec = promisify(execFile);

async function git(cwd: string, args: string[]) {
  return exec("git", args, { cwd });
}

describe("execution worktree artifact root", () => {
  it("creates a worktree below DCC_DATA_DIR rather than appending a second data directory", async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), "git-runner-artifact-root-"));
    try {
      const repository = path.join(temporary, "repo");
      await mkdir(repository);
      await git(repository, ["init", "-b", "main"]);
      await git(repository, ["config", "core.hooksPath", "/dev/null"]);
      await git(repository, ["config", "user.email", "git-runner-test@example.com"]);
      await git(repository, ["config", "user.name", "git-runner test"]);
      await writeFile(path.join(repository, "README.md"), "test\n");
      await git(repository, ["add", "README.md"]);
      await git(repository, ["commit", "-m", "initial"]);

      const dataRoot = artifactDataRoot(path.join(temporary, "fallback"), {
        DCC_DATA_DIR: path.join(temporary, "shared-artifacts"),
      });
      const worktree = await createExecutionWorktree({
        repositoryPath: repository,
        defaultBranch: "main",
        dataRoot,
        projectSlug: "acme",
        ticketNumber: "DCC-1",
        title: "Fix artifact root",
        attemptNumber: 1,
      });

      expect(worktree.worktreePath).toBe(path.join(dataRoot, "worktrees", "acme", "DCC-1", "1"));
      expect(path.relative(dataRoot, worktree.worktreePath).startsWith("..")).toBe(false);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
