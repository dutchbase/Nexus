import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  abortMerge,
  commitExecutionChanges,
  conflictedFiles,
  countCredentialShapes,
  createConflictResolutionWorktree,
  createPrivateExecutionClone,
  executionBranchName,
  importPrivateExecutionClone,
  matchesProtectedPath,
  mergeBaseIntoWorktree,
  sanitizeValidationOutput,
  worktreeDiff,
} from "./index.ts";

const exec = promisify(execFile);

async function git(cwd: string, args: string[]) {
  return exec("git", args, { cwd });
}

async function initRepo(dir: string) {
  await mkdir(dir, { recursive: true });
  await git(dir, ["init", "-b", "main"]);
  // The global hooksPath on this machine blocks commits on a branch named
  // main/master; these are throwaway tmp repos, not the guarded project repo.
  await git(dir, ["config", "core.hooksPath", "/dev/null"]);
  await git(dir, ["config", "user.email", "git-runner-test@example.com"]);
  await git(dir, ["config", "user.name", "git-runner test"]);
}

async function writeAndCommit(dir: string, file: string, content: string, message: string) {
  await writeFile(path.join(dir, file), content);
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-m", message]);
}

async function cloneRepo(originDir: string, repoDir: string) {
  await git(path.dirname(repoDir), ["clone", originDir, repoDir]);
  await git(repoDir, ["config", "core.hooksPath", "/dev/null"]);
  await git(repoDir, ["config", "user.email", "git-runner-test@example.com"]);
  await git(repoDir, ["config", "user.name", "git-runner test"]);
}

describe("createConflictResolutionWorktree / mergeBaseIntoWorktree", () => {
  it("checks out the head branch, detects a real conflict, lists conflicted files, then clears them on abort", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "git-runner-conflict-"));
    try {
      const originDir = path.join(tmp, "origin");
      await initRepo(originDir);
      await writeAndCommit(originDir, "shared.txt", "main line\n", "initial commit");
      await git(originDir, ["checkout", "-b", "feature"]);
      await writeAndCommit(originDir, "shared.txt", "feature line\n", "feature edit");
      await git(originDir, ["checkout", "main"]);
      await writeAndCommit(originDir, "shared.txt", "main edit\n", "main edit");

      const repoDir = path.join(tmp, "repo");
      await cloneRepo(originDir, repoDir);

      const dataRoot = path.join(tmp, "data-root");
      const { worktreePath, branchName, headCommit } = await createConflictResolutionWorktree({
        repositoryPath: repoDir,
        headBranch: "feature",
        baseBranch: "main",
        dataRoot,
        projectSlug: "acme corp",
        pullRequestNumber: 42,
      });

      expect(branchName).toBe("feature");
      expect(headCommit).toMatch(/^[0-9a-f]{40}$/);
      expect((await git(worktreePath, ["branch", "--show-current"])).stdout.trim()).toBe("feature");

      const merge = await mergeBaseIntoWorktree(worktreePath, "main");
      expect(merge.conflicted).toBe(true);

      const conflicts = await conflictedFiles(worktreePath);
      expect(conflicts).toEqual(["shared.txt"]);

      await abortMerge(worktreePath);
      expect(await conflictedFiles(worktreePath)).toEqual([]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("reuses/clears the same worktree path when called twice for the same PR", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "git-runner-reuse-"));
    try {
      const originDir = path.join(tmp, "origin");
      await initRepo(originDir);
      await writeAndCommit(originDir, "shared.txt", "main line\n", "initial commit");
      await git(originDir, ["checkout", "-b", "feature"]);
      await writeAndCommit(originDir, "shared.txt", "feature line\n", "feature edit");
      await git(originDir, ["checkout", "main"]);
      await writeAndCommit(originDir, "shared.txt", "main edit\n", "main edit");

      const repoDir = path.join(tmp, "repo");
      await cloneRepo(originDir, repoDir);

      const dataRoot = path.join(tmp, "data-root");
      const input = {
        repositoryPath: repoDir,
        headBranch: "feature",
        baseBranch: "main",
        dataRoot,
        projectSlug: "acme",
        pullRequestNumber: 7,
      };

      const first = await createConflictResolutionWorktree(input);
      const second = await createConflictResolutionWorktree(input);

      expect(second.worktreePath).toBe(first.worktreePath);
      expect((await git(second.worktreePath, ["branch", "--show-current"])).stdout.trim()).toBe("feature");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("reports conflicted: false for a clean fast-forwardable merge", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "git-runner-clean-merge-"));
    try {
      const originDir = path.join(tmp, "origin");
      await initRepo(originDir);
      await writeAndCommit(originDir, "base.txt", "base\n", "initial commit");
      await git(originDir, ["checkout", "-b", "feature"]);
      await git(originDir, ["checkout", "main"]);
      await writeAndCommit(originDir, "main-only.txt", "main advances\n", "main advances");

      const repoDir = path.join(tmp, "repo");
      await cloneRepo(originDir, repoDir);

      const dataRoot = path.join(tmp, "data-root");
      const { worktreePath } = await createConflictResolutionWorktree({
        repositoryPath: repoDir,
        headBranch: "feature",
        baseBranch: "main",
        dataRoot,
        projectSlug: "acme",
        pullRequestNumber: 99,
      });

      const merge = await mergeBaseIntoWorktree(worktreePath, "main");
      expect(merge.conflicted).toBe(false);
      expect(await conflictedFiles(worktreePath)).toEqual([]);
      expect((await git(worktreePath, ["log", "-1", "--pretty=%s"])).stdout.trim()).toBe("main advances");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("worker validation primitives", () => {
  it("detects credential shapes without returning their values", () => {
    expect(countCredentialShapes("x=AKIAIOSFODNN7EXAMPLE\n-----BEGIN PRIVATE KEY-----")).toBe(2);
    expect(countCredentialShapes("ordinary content")).toBe(0);
    expect(sanitizeValidationOutput("failed for AKIAIOSFODNN7EXAMPLE")).toBe("failed for [REDACTED_CREDENTIAL]");
  });

  it("matches protected paths as globs", () => {
    expect(matchesProtectedPath(".env")).toBe(true);
    expect(matchesProtectedPath(".env.local")).toBe(true);
    expect(matchesProtectedPath("secrets/nested/key.txt")).toBe(true);
    expect(matchesProtectedPath("src/environment.ts")).toBe(false);
  });

  it("generates distinct branch names for different attempts on the same ticket", () => {
    const first = executionBranchName("DCC-1001", "Update the logo to my png image", 1);
    const second = executionBranchName("DCC-1001", "Update the logo to my png image", 2);
    expect(first).not.toBe(second);
    expect(second).toContain("-2-");
  });
});

describe("execution commit containment", () => {
  it("imports an agent clone's final tree without importing its history", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "git-runner-private-clone-"));
    try {
      const repository = path.join(tmp, "repository");
      await initRepo(repository);
      await writeAndCommit(repository, "base.txt", "base\n", "base commit");
      const baseCommit = (await git(repository, ["rev-parse", "HEAD"])).stdout.trim();
      const worker = path.join(tmp, "worker");
      await git(repository, ["worktree", "add", "-b", "worker", worker, baseCommit]);

      const clone = await createPrivateExecutionClone({ worktreePath: worker });
      await git(clone.clonePath, ["config", "user.email", "git-runner-test@example.com"]);
      await git(clone.clonePath, ["config", "user.name", "git-runner test"]);
      await writeAndCommit(clone.clonePath, "committed.txt", "clone-only commit\n", "agent task commit");
      await writeFile(path.join(clone.clonePath, "base.txt"), "clone-only uncommitted\n");
      await writeFile(path.join(clone.clonePath, "untracked.txt"), "clone-only untracked\n");

      expect((await git(worker, ["rev-parse", "HEAD"])).stdout.trim()).toBe(baseCommit);
      const workerCommonDir = await realpath(path.resolve(worker, (await git(worker, ["rev-parse", "--git-common-dir"])).stdout.trim()));
      const cloneCommonDir = await realpath(path.resolve(clone.clonePath, (await git(clone.clonePath, ["rev-parse", "--git-common-dir"])).stdout.trim()));
      const workerObjects = await realpath(path.resolve(worker, (await git(worker, ["rev-parse", "--git-path", "objects"])).stdout.trim()));
      const cloneObjects = await realpath(path.resolve(clone.clonePath, (await git(clone.clonePath, ["rev-parse", "--git-path", "objects"])).stdout.trim()));
      expect(cloneCommonDir).not.toBe(workerCommonDir);
      expect(cloneObjects).not.toBe(workerObjects);

      const otherWorker = path.join(tmp, "other-worker");
      await git(repository, ["worktree", "add", "-b", "other-worker", otherWorker, baseCommit]);
      await writeFile(path.join(otherWorker, "must-survive.txt"), "do not reset me\n");
      await expect(importPrivateExecutionClone({
        clonePath: clone.clonePath,
        worktreePath: otherWorker,
        baseCommit,
        originWorktreePath: clone.originWorktreePath,
      })).rejects.toThrow("clone did not originate from this worktree");
      expect(await readFile(path.join(otherWorker, "must-survive.txt"), "utf8")).toBe("do not reset me\n");

      const symlinkTarget = path.join(tmp, "agent-controlled-patch-target");
      await writeFile(symlinkTarget, "must stay untouched\n");
      await symlink(symlinkTarget, path.join(clone.clonePath, ".git", "execution.patch"));

      await importPrivateExecutionClone({ clonePath: clone.clonePath, worktreePath: worker, baseCommit, originWorktreePath: clone.originWorktreePath });
      expect(await readFile(symlinkTarget, "utf8")).toBe("must stay untouched\n");

      expect(await readFile(path.join(worker, "committed.txt"), "utf8")).toBe("clone-only commit\n");
      expect(await readFile(path.join(worker, "base.txt"), "utf8")).toBe("clone-only uncommitted\n");
      expect(await readFile(path.join(worker, "untracked.txt"), "utf8")).toBe("clone-only untracked\n");
      expect((await git(worker, ["rev-list", "--count", `${baseCommit}..HEAD`])).stdout.trim()).toBe("0");
      expect((await git(worker, ["log", "--format=%s", "-1"])).stdout.trim()).toBe("base commit");

      await git(worker, ["add", "--all"]);
      await git(worker, ["commit", "-m", "worker final commit"]);
      expect((await git(worker, ["rev-list", "--count", `${baseCommit}..HEAD`])).stdout.trim()).toBe("1");
      await clone.cleanup();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("squashes executor commits and uncommitted changes into one commit from the attempt base", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "git-runner-execution-"));
    try {
      await initRepo(tmp);
      await writeAndCommit(tmp, "base.txt", "base\n", "base commit");
      const baseCommit = (await git(tmp, ["rev-parse", "HEAD"])).stdout.trim();
      await writeAndCommit(tmp, "executor.txt", "committed task output\n", "executor task commit");
      await writeFile(path.join(tmp, "base.txt"), "uncommitted final output\n");

      const diff = await worktreeDiff(tmp, baseCommit);
      expect(diff).toContain("committed task output");
      expect(diff).toContain("uncommitted final output");

      await commitExecutionChanges({ worktreePath: tmp, message: "worker final commit", baseCommit });

      expect((await git(tmp, ["rev-list", "--count", `${baseCommit}..HEAD`])).stdout.trim()).toBe("1");
      expect((await git(tmp, ["show", "--format=", "--name-only", "HEAD"])).stdout.split("\n").filter(Boolean))
        .toEqual(["base.txt", "executor.txt"]);
      expect((await git(tmp, ["show", "HEAD:base.txt"])).stdout).toBe("uncommitted final output\n");
      expect((await git(tmp, ["show", "HEAD:executor.txt"])).stdout).toBe("committed task output\n");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
