import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  createPullRequestReviewWorktree,
  executionBranchName,
  matchesProtectedPath,
  mergeBaseIntoWorktree,
  sanitizeValidationOutput,
  validateExecutionWorktree,
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

describe("execution effective diff", () => {
  it("keeps committed and working task changes relative to the recorded base", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "git-runner-effective-diff-"));
    try {
      const repo = path.join(tmp, "repo");
      await initRepo(repo);
      await writeAndCommit(repo, "base.txt", "base\n", "initial commit");
      const baseCommit = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
      await writeAndCommit(repo, "committed.txt", "committed\n", "agent commit");
      await writeFile(path.join(repo, "working.txt"), "working\n");

      const validation = await validateExecutionWorktree({ worktreePath: repo, baseCommit });

      expect(validation.files).toEqual(["committed.txt", "working.txt"]);
      expect(await worktreeDiff(repo, baseCommit)).toContain("committed.txt");
      expect(await worktreeDiff(repo, baseCommit)).toContain("working.txt");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("accepts a legitimate agent commit without requiring a second empty commit", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "git-runner-committed-task-"));
    try {
      const repo = path.join(tmp, "repo");
      await initRepo(repo);
      await writeAndCommit(repo, "base.txt", "base\n", "initial commit");
      const baseCommit = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
      await writeAndCommit(repo, "task.txt", "finished\n", "agent commit");
      const expectedCommit = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();

      await expect(commitExecutionChanges({
        worktreePath: repo,
        baseCommit,
        message: "worker commit",
      })).resolves.toBe(expectedCommit);
      expect((await git(repo, ["rev-list", "--count", `${baseCommit}..HEAD`])).stdout.trim()).toBe("1");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("rejects a merge commit in an agent execution history", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "git-runner-nonlinear-history-"));
    try {
      const repo = path.join(tmp, "repo");
      await initRepo(repo);
      await writeAndCommit(repo, "base.txt", "base\n", "initial commit");
      const baseCommit = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
      await git(repo, ["checkout", "-b", "side"]);
      await writeAndCommit(repo, "side.txt", "side\n", "side commit");
      await git(repo, ["checkout", "-b", "agent", baseCommit]);
      await writeAndCommit(repo, "agent.txt", "agent\n", "agent commit");
      await git(repo, ["merge", "--no-ff", "side", "-m", "merge side"]);

      await expect(validateExecutionWorktree({ worktreePath: repo, baseCommit }))
        .rejects.toMatchObject({ check: "history inspection" });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("createPullRequestReviewWorktree", () => {
  it("checks out the PR ref detached and removes the disposable worktree", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "git-runner-pr-review-"));
    try {
      const origin = path.join(tmp, "origin");
      await initRepo(origin);
      await writeAndCommit(origin, "reviewed.txt", "review me\n", "PR head");
      const expectedCommit = (await git(origin, ["rev-parse", "HEAD"])).stdout.trim();
      await git(origin, ["update-ref", "refs/pull/42/head", "HEAD"]);
      const repo = path.join(tmp, "repo");
      await cloneRepo(origin, repo);

      const worktree = await createPullRequestReviewWorktree({
        repositoryPath: repo,
        dataRoot: path.join(tmp, "data-root"),
        projectSlug: "acme",
        pullRequestNumber: 42,
      });
      try {
        expect((await git(worktree.worktreePath, ["rev-parse", "HEAD"])).stdout.trim()).toBe(expectedCommit);
        await expect(git(worktree.worktreePath, ["symbolic-ref", "--quiet", "HEAD"])).rejects.toMatchObject({ code: 1 });
      } finally {
        await worktree.cleanup();
      }
      await expect(readFile(path.join(worktree.worktreePath, "reviewed.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
