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
      const remote = path.join(temporary, "remote.git");
      await git(temporary, ["init", "--bare", remote]);
      await git(repository, ["remote", "add", "origin", remote]);
      await git(repository, ["push", "origin", "main"]);

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

it("uses the fetched origin default branch and rejects a dirty repository", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "git-runner-fresh-base-"));
  try {
    const remote = path.join(temporary, "remote.git");
    const repository = path.join(temporary, "repo");
    const updater = path.join(temporary, "updater");
    await git(temporary, ["init", "--bare", remote]);
    await git(temporary, ["clone", remote, repository]);
    await git(repository, ["config", "core.hooksPath", "/dev/null"]);
    await git(repository, ["config", "user.email", "git-runner-test@example.com"]);
    await git(repository, ["config", "user.name", "git-runner test"]);
    await writeFile(path.join(repository, "README.md"), "initial\\n");
    await git(repository, ["add", "."]);
    await git(repository, ["commit", "-m", "initial"]);
    await git(repository, ["push", "origin", "HEAD:main"]);
    await git(repository, ["branch", "-M", "main"]);
    await git(temporary, ["clone", "-b", "main", remote, updater]);
    await git(updater, ["config", "core.hooksPath", "/dev/null"]);
    await git(updater, ["config", "user.email", "git-runner-test@example.com"]);
    await git(updater, ["config", "user.name", "git-runner test"]);
    await writeFile(path.join(updater, "README.md"), "origin update\\n");
    await git(updater, ["commit", "-am", "origin update"]);
    await git(updater, ["push"]);
    const originHead = (await git(updater, ["rev-parse", "HEAD"])).stdout.trim();

    const worktree = await createExecutionWorktree({
      repositoryPath: repository, defaultBranch: "main", dataRoot: path.join(temporary, "data"),
      projectSlug: "acme", ticketNumber: "DCC-2", title: "Fresh base", attemptNumber: 1,
    });
    expect(worktree.baseCommit).toBe(originHead);

    await writeFile(path.join(repository, "dirty.txt"), "dirty\\n");
    await expect(createExecutionWorktree({
      repositoryPath: repository, defaultBranch: "main", dataRoot: path.join(temporary, "data"),
      projectSlug: "acme", ticketNumber: "DCC-3", title: "Dirty", attemptNumber: 1,
    })).rejects.toThrow("repository has uncommitted changes");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
