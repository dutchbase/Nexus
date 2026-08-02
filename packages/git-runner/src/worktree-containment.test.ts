import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { createExecutionWorktree, removeContainedWorktreePath, removeManagedWorktree } from "./index.ts";

const exec = promisify(execFile);

it("rejects symlinked managed-worktree paths and never cleans outside the data root", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "git-runner-containment-"));
  try {
    const repository = path.join(temporary, "repo");
    const dataRoot = path.join(temporary, "data");
    const outside = path.join(temporary, "outside");
    await mkdir(repository);
    await mkdir(outside);
    await exec("git", ["init", "-b", "main"], { cwd: repository });
    await exec("git", ["config", "core.hooksPath", "/dev/null"], { cwd: repository });
    await exec("git", ["config", "user.email", "test@example.com"], { cwd: repository });
    await exec("git", ["config", "user.name", "test"], { cwd: repository });
    await writeFile(path.join(repository, "README.md"), "test\n");
    await exec("git", ["add", "README.md"], { cwd: repository });
    await exec("git", ["commit", "-m", "initial"], { cwd: repository });
    await mkdir(path.join(dataRoot, "worktrees"), { recursive: true });
    await symlink(outside, path.join(dataRoot, "worktrees", "acme"));

    await expect(createExecutionWorktree({
      repositoryPath: repository, defaultBranch: "main", dataRoot, projectSlug: "acme",
      ticketNumber: "DCC-1", title: "Containment", attemptNumber: 1,
    })).rejects.toThrow("managed worktree path escapes controlled root");
    await expect(access(path.join(outside, "DCC-1", "1"))).rejects.toThrow();
    await expect(removeContainedWorktreePath(dataRoot, path.join(dataRoot, "worktrees", "acme", "DCC-1", "1"))).rejects.toThrow("managed worktree path escapes controlled root");
    await expect(access(outside)).resolves.toBeUndefined();
    await expect(removeManagedWorktree(repository, dataRoot, outside)).rejects.toThrow("managed worktree path escapes controlled root");
    await expect(access(outside)).resolves.toBeUndefined();
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
