import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { createExecutionWorktree, removeManagedWorktree } from "./index.ts";

const exec = promisify(execFile);

it("unregisters and removes a managed worktree", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "git-runner-cleanup-"));
  try {
    const repository = path.join(temporary, "repo");
    await mkdir(repository);
    await exec("git", ["init", "-b", "main"], { cwd: repository });
    await exec("git", ["config", "core.hooksPath", "/dev/null"], { cwd: repository });
    await exec("git", ["config", "user.email", "git-runner-test@example.com"], { cwd: repository });
    await exec("git", ["config", "user.name", "git-runner test"], { cwd: repository });
    await writeFile(path.join(repository, "README.md"), "test\n");
    await exec("git", ["add", "README.md"], { cwd: repository });
    await exec("git", ["commit", "-m", "initial"], { cwd: repository });
    const worktree = await createExecutionWorktree({
      repositoryPath: repository, defaultBranch: "main", dataRoot: path.join(temporary, "data"),
      projectSlug: "acme", ticketNumber: "DCC-1", title: "Cleanup", attemptNumber: 1,
    });

    await removeManagedWorktree(repository, worktree.worktreePath);

    await expect(access(worktree.worktreePath)).rejects.toThrow();
    await expect(exec("git", ["worktree", "list", "--porcelain"], { cwd: repository })).resolves.not.toMatchObject({ stdout: expect.stringContaining(worktree.worktreePath) });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
