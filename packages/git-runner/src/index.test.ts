import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  abortMerge,
  assertNoConflictMarkers,
  assertRemoteBranchName,
  commitExecutionChanges,
  conflictedFiles,
  countCredentialShapes,
  createConflictResolutionWorktree,
  createPullRequestReviewWorktree,
  createPrivateExecutionClone,
  executionBranchName,
  importPrivateExecutionClone,
  matchesProtectedPath,
  mergeBaseIntoWorktree,
  previewRemoteBranchMerge,
  stageConflictResolutionPaths,
  sanitizeValidationOutput,
  validateEffectiveWorktree,
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

async function writeAndCommit(dir: string, file: string, content: string | Uint8Array, message: string) {
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

describe("assertRemoteBranchName", () => {
  it("rejects option-like, control-character and empty names before they reach git argv", async () => {
    await expect(assertRemoteBranchName("--upload-pack=/bin/sh")).rejects.toThrow(/unsafe branch name/);
    await expect(assertRemoteBranchName("main\n")).rejects.toThrow(/unsafe branch name/);
    await expect(assertRemoteBranchName("")).rejects.toThrow(/unsafe branch name/);
  });

  it("accepts ordinary feature branch names", async () => {
    await expect(assertRemoteBranchName("feature/fix-1.2.3")).resolves.toBeUndefined();
  });
});

describe("mergeBaseIntoWorktree failure classification", () => {
  it("propagates non-conflict failures instead of labelling them conflicted", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "git-runner-mergefail-"));
    try {
      const originDir = path.join(tmp, "origin");
      await initRepo(originDir);
      await writeAndCommit(originDir, "shared.txt", "main line\n", "initial commit");
      const repoDir = path.join(tmp, "repo");
      await cloneRepo(originDir, repoDir);
      // A ref that was never pushed is exit-code 128 noise, not a conflict:
      // the caller must see the throw, not an empty conflict set.
      await expect(mergeBaseIntoWorktree(repoDir, "never-pushed-branch")).rejects.toThrow();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("createConflictResolutionWorktree / mergeBaseIntoWorktree", () => {
  it("creates a detached head worktree, detects a real conflict, lists conflicted files, then clears them on abort", async () => {
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
        conflictResolutionId: "11111111-1111-4111-8111-111111111111",
      });

      expect(branchName).toBe("feature");
      expect(headCommit).toMatch(/^[0-9a-f]{40}$/);
      expect((await git(worktreePath, ["branch", "--show-current"])).stdout.trim()).toBe("");

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

  it("uses a separate detached worktree for each conflict resolution", async () => {
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
        conflictResolutionId: "22222222-2222-4222-8222-222222222222",
      };

      const first = await createConflictResolutionWorktree(input);
      const second = await createConflictResolutionWorktree({ ...input, conflictResolutionId: "44444444-4444-4444-8444-444444444444" });

      expect(second.worktreePath).not.toBe(first.worktreePath);
      expect((await git(first.worktreePath, ["branch", "--show-current"])).stdout.trim()).toBe("");
      expect((await git(second.worktreePath, ["branch", "--show-current"])).stdout.trim()).toBe("");
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
      const { worktreePath, headCommit } = await createConflictResolutionWorktree({
        repositoryPath: repoDir,
        headBranch: "feature",
        baseBranch: "main",
        dataRoot,
        projectSlug: "acme",
        pullRequestNumber: 99,
        conflictResolutionId: "33333333-3333-4333-8333-333333333333",
      });

      const merge = await mergeBaseIntoWorktree(worktreePath, "main");
      expect(merge.conflicted).toBe(false);
      expect(merge.headCommit).not.toBe(headCommit);
      expect(merge.headCommit).toBe((await git(worktreePath, ["rev-parse", "HEAD"])).stdout.trim());
      expect(await conflictedFiles(worktreePath)).toEqual([]);
      expect((await git(worktreePath, ["log", "-1", "--pretty=%s"])).stdout.trim()).toBe("main advances");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("conflict resolution staging", () => {
  it("stages only the original conflicted paths", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "git-runner-conflict-stage-"));
    try {
      await initRepo(tmp);
      await writeAndCommit(tmp, "conflicted.ts", "base\n", "initial commit");
      await writeAndCommit(tmp, "unrelated.ts", "base\n", "initial commit");
      await writeFile(path.join(tmp, "conflicted.ts"), "resolved\n");
      await writeFile(path.join(tmp, "unrelated.ts"), "unexpected\n");

      await stageConflictResolutionPaths(tmp, ["conflicted.ts"]);

      expect((await git(tmp, ["diff", "--cached", "--name-only"])).stdout.trim()).toBe("conflicted.ts");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("rejects textual conflict markers after staging", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "git-runner-conflict-markers-"));
    try {
      await initRepo(tmp);
      await writeAndCommit(tmp, "conflicted.ts", "base\n", "initial commit");
      await writeFile(path.join(tmp, "conflicted.ts"), "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> main\n");

      await stageConflictResolutionPaths(tmp, ["conflicted.ts"]);
      await expect(assertNoConflictMarkers(tmp, ["conflicted.ts"])).rejects.toThrow("textual conflict marker");
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

  it("runs agent-authored validation without worker secrets or network and re-scans its output", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "git-runner-validation-sandbox-"));
    const server = createServer((_request, response) => response.end("unexpected egress"));
    let hits = 0;
    server.on("request", () => { hits += 1; });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    try {
      await initRepo(tmp);
      await writeAndCommit(tmp, "base.txt", "base\n", "base commit");
      const baseCommit = (await git(tmp, ["rev-parse", "HEAD"])).stdout.trim();
      await writeFile(path.join(tmp, "result.txt"), "agent output\n");
      await writeFile(path.join(tmp, "malicious-validation.mjs"), [
        "import { writeFile } from \"node:fs/promises\";",
        "import http from \"node:http\";",
        "await writeFile(\"seen-secret.txt\", process.env.DCC_VALIDATION_TEST_SECRET ?? \"\");",
        "await writeFile(\"late-secret.txt\", \"AKIA\" + \"IOSFODNN7EXAMPLE\");",
        "await new Promise((resolve) => { const request = http.get(process.argv[2], resolve); request.on(\"error\", resolve); request.setTimeout(300, () => { request.destroy(); resolve(); }); });",
      ].join("\n"));
      const blocker = path.join(tmp, "block-network.cjs");
      await writeFile(blocker, [
        "const http = require(\"node:http\");",
        "const { EventEmitter } = require(\"node:events\");",
        "http.get = () => { const request = new EventEmitter(); request.setTimeout = () => request; request.destroy = () => {}; queueMicrotask(() => request.emit(\"error\", new Error(\"blocked\"))); return request; };",
      ].join("\n"));
      const fakeBwrap = path.join(tmp, "fake-bwrap.cjs");
      await writeFile(fakeBwrap, [
        "#!/usr/bin/env node",
        "const { spawnSync } = require(\"node:child_process\");",
        "const args = process.argv.slice(2);",
        "if (!args.includes(\"--unshare-net\") || !args.includes(\"--clearenv\")) process.exit(96);",
        "for (let index = 0; index < args.length - 2; index += 1) if (args[index] === \"--ro-bind\" && args[index + 1] === \"/\" && args[index + 2] === \"/\") process.exit(95);",
        "const bind = args.indexOf(\"--bind\");",
        "const command = args.lastIndexOf(\"sh\");",
        "const env = { PATH: process.env.PATH, HOME: \"/tmp\", LANG: \"C.UTF-8\", NODE_OPTIONS: \"--require=\" + " + JSON.stringify(blocker) + " };",
        "const result = spawnSync(args[command], args.slice(command + 1), { cwd: args[bind + 1], env, stdio: \"inherit\" });",
        "process.exit(result.status ?? 1);",
      ].join("\n"));
      await chmod(fakeBwrap, 0o755);
      process.env.DCC_VALIDATION_BWRAP_PATH = fakeBwrap;
      process.env.DCC_VALIDATION_TEST_SECRET = "worker-secret";
      const port = typeof address === "object" && address ? address.port : 0;

      await expect(validateExecutionWorktree({
        worktreePath: tmp, baseCommit, commands: { test: "node malicious-validation.mjs http://127.0.0.1:" + port },
      })).rejects.toMatchObject({ check: "final tree scan" });

      expect(await readFile(path.join(tmp, "seen-secret.txt"), "utf8")).toBe("");
      expect(hits).toBe(0);
    } finally {
      delete process.env.DCC_VALIDATION_TEST_SECRET;
      delete process.env.DCC_VALIDATION_BWRAP_PATH;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(tmp, { recursive: true, force: true });
    }
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
      expect((await git(clone.clonePath, ["remote"])).stdout.trim()).toBe("");
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

  it("ignores agent Git config while deriving the imported tree", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "git-runner-hostile-config-"));
    try {
      const repository = path.join(tmp, "repository");
      await initRepo(repository);
      await writeAndCommit(repository, "result.txt", "base\n", "base commit");
      const baseCommit = (await git(repository, ["rev-parse", "HEAD"])).stdout.trim();
      const worker = path.join(tmp, "worker");
      await git(repository, ["worktree", "add", "-b", "worker", worker, baseCommit]);
      const clone = await createPrivateExecutionClone({ worktreePath: worker });
      const sentinel = path.join(tmp, "agent-git-config-executed");
      const externalDiff = path.join(clone.clonePath, ".git", "external-diff.sh");
      await writeFile(externalDiff, "#!/bin/sh\ntouch " + JSON.stringify(sentinel) + "\nexit 0\n");
      await chmod(externalDiff, 0o755);
      await git(clone.clonePath, ["config", "diff.external", externalDiff]);
      await writeFile(path.join(clone.clonePath, "result.txt"), "safe imported output\n");

      await importPrivateExecutionClone({ clonePath: clone.clonePath, worktreePath: worker, baseCommit, originWorktreePath: clone.originWorktreePath });

      await expect(access(sentinel)).rejects.toThrow();
      expect(await readFile(path.join(worker, "result.txt"), "utf8")).toBe("safe imported output\n");
      await clone.cleanup();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("restores prior repair output when applying a verified import fails", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "git-runner-import-rollback-"));
    const originalPath = process.env.PATH;
    try {
      const repository = path.join(tmp, "repository");
      await initRepo(repository);
      await writeAndCommit(repository, "result.txt", "base\n", "base commit");
      const baseCommit = (await git(repository, ["rev-parse", "HEAD"])).stdout.trim();
      const worker = path.join(tmp, "worker");
      await git(repository, ["worktree", "add", "-b", "worker", worker, baseCommit]);
      await writeFile(path.join(worker, "result.txt"), "prior repair output\n");
      const clone = await createPrivateExecutionClone({ worktreePath: worker });
      await writeFile(path.join(clone.clonePath, "result.txt"), "new output\n");
      const bin = path.join(tmp, "bin");
      await mkdir(bin);
      const gitWrapper = path.join(bin, "git");
      const dollar = String.fromCharCode(36);
      await writeFile(gitWrapper, "#!/bin/sh\nif [ \"" + dollar + "1\" = \"-C\" ] && [ \"" + dollar + "2\" = \"" + dollar + "DCC_FAIL_WORKTREE\" ] && [ \"" + dollar + "3\" = \"apply\" ]; then exit 97; fi\nexec /usr/bin/git \"" + dollar + "@\"\n");
      await chmod(gitWrapper, 0o755);
      process.env.PATH = bin + ":" + (originalPath ?? "");
      process.env.DCC_FAIL_WORKTREE = worker;

      await expect(importPrivateExecutionClone({
        clonePath: clone.clonePath, worktreePath: worker, baseCommit, originWorktreePath: clone.originWorktreePath,
      })).rejects.toThrow();

      expect(await readFile(path.join(worker, "result.txt"), "utf8")).toBe("prior repair output\n");
      await clone.cleanup();
    } finally {
      process.env.PATH = originalPath;
      delete process.env.DCC_FAIL_WORKTREE;
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

describe("execution effective diff", () => {
  it("rejects only empty untracked files", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "git-runner-contentless-untracked-"));
    try {
      await initRepo(tmp);
      await writeAndCommit(tmp, "base.txt", "base\n", "initial commit");
      const baseCommit = (await git(tmp, ["rev-parse", "HEAD"])).stdout.trim();
      await writeFile(path.join(tmp, "empty.txt"), "");

      await expect(validateEffectiveWorktree({ worktreePath: tmp, baseCommit }))
        .rejects.toThrow("execution produced only contentless file changes");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("rejects empty tracked files", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "git-runner-contentless-tracked-"));
    try {
      await initRepo(tmp);
      await writeAndCommit(tmp, "base.txt", "base\n", "initial commit");
      const baseCommit = (await git(tmp, ["rev-parse", "HEAD"])).stdout.trim();
      await writeAndCommit(tmp, "empty.txt", "", "empty file");

      await expect(validateEffectiveWorktree({ worktreePath: tmp, baseCommit }))
        .rejects.toThrow("execution produced only contentless file changes");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("allows a non-empty untracked file", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "git-runner-contentful-untracked-"));
    try {
      await initRepo(tmp);
      await writeAndCommit(tmp, "base.txt", "base\n", "initial commit");
      const baseCommit = (await git(tmp, ["rev-parse", "HEAD"])).stdout.trim();
      await writeFile(path.join(tmp, "output.txt"), "output\n");

      await expect(validateEffectiveWorktree({ worktreePath: tmp, baseCommit })).resolves.toBeDefined();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("allows a whitespace-only text edit", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "git-runner-contentful-text-"));
    try {
      await initRepo(tmp);
      await writeAndCommit(tmp, "base.txt", "base\n", "initial commit");
      const baseCommit = (await git(tmp, ["rev-parse", "HEAD"])).stdout.trim();
      await writeFile(path.join(tmp, "base.txt"), "base \n");

      await expect(validateEffectiveWorktree({ worktreePath: tmp, baseCommit })).resolves.toBeDefined();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("allows a binary edit", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "git-runner-contentful-binary-"));
    try {
      await initRepo(tmp);
      await writeAndCommit(tmp, "image.bin", Buffer.from([0, 255]), "initial commit");
      const baseCommit = (await git(tmp, ["rev-parse", "HEAD"])).stdout.trim();
      await writeFile(path.join(tmp, "image.bin"), Buffer.from([0, 255, 1]));

      await expect(validateEffectiveWorktree({ worktreePath: tmp, baseCommit })).resolves.toBeDefined();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

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

  it("squashes two clean agent commits into one worker-owned commit from the recorded base", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "git-runner-committed-task-"));
    try {
      const repo = path.join(tmp, "repo");
      await initRepo(repo);
      await writeAndCommit(repo, "base.txt", "base\n", "initial commit");
      const baseCommit = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
      await writeAndCommit(repo, "first.txt", "first\n", "agent first commit");
      await writeAndCommit(repo, "second.txt", "second\n", "agent second commit");

      await commitExecutionChanges({
        worktreePath: repo,
        baseCommit,
        message: "worker commit",
      });

      expect((await git(repo, ["rev-list", "--count", `${baseCommit}..HEAD`])).stdout.trim()).toBe("1");
      expect((await git(repo, ["log", "-1", "--pretty=%s"])).stdout.trim()).toBe("worker commit");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("rescans base-aware committed blobs after staging worker changes", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "git-runner-staged-scan-"));
    try {
      const repo = path.join(tmp, "repo");
      await initRepo(repo);
      await writeAndCommit(repo, "base.txt", "base\n", "initial commit");
      const baseCommit = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
      await writeFile(path.join(repo, ".gitattributes"), "task.txt filter=inject\n");
      await git(repo, ["config", "filter.inject.clean", "sed 's/safe/AKIAIOSFODNN7EXAMPLE/'"]);
      await writeFile(path.join(repo, "task.txt"), "safe\n");
      await git(repo, ["add", "--all"]);
      await git(repo, ["commit", "-m", "agent commit"]);
      await writeFile(path.join(repo, "working.txt"), "working\n");

      await expect(commitExecutionChanges({
        worktreePath: repo,
        baseCommit,
        message: "worker commit",
      })).rejects.toMatchObject({ check: "secret scan" });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("does not inspect a deleted staged blob", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "git-runner-staged-delete-"));
    try {
      const repo = path.join(tmp, "repo");
      await initRepo(repo);
      await writeAndCommit(repo, "removed.txt", "AKIAIOSFODNN7EXAMPLE\n", "initial commit");
      const baseCommit = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
      await git(repo, ["rm", "removed.txt"]);

      await commitExecutionChanges({ worktreePath: repo, baseCommit, message: "worker commit" });

      expect((await git(repo, ["show", "--format=", "--name-status", "HEAD"])).stdout.trim()).toBe("D\tremoved.txt");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it.each(["added.txt", "modified.txt"])("rejects a secret in an %s staged blob", async (file) => {
    const tmp = await mkdtemp(path.join(tmpdir(), "git-runner-staged-secret-"));
    try {
      const repo = path.join(tmp, "repo");
      await initRepo(repo);
      await writeAndCommit(repo, "modified.txt", "safe\n", "initial commit");
      const baseCommit = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
      await writeFile(path.join(repo, ".gitattributes"), `${file} filter=inject\n`);
      await git(repo, ["config", "filter.inject.clean", "sed 's/safe/AKIAIOSFODNN7EXAMPLE/'"]);
      await writeFile(path.join(repo, file), "safe\n");

      await expect(commitExecutionChanges({ worktreePath: repo, baseCommit, message: "worker commit" }))
        .rejects.toMatchObject({ check: "secret scan" });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("scans only the destination of a staged rename", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "git-runner-staged-rename-"));
    try {
      const repo = path.join(tmp, "repo");
      await initRepo(repo);
      const safeContent = "safe\n".repeat(20);
      await writeAndCommit(repo, "before.txt", safeContent, "initial commit");
      const baseCommit = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
      await git(repo, ["mv", "before.txt", "after.txt"]);
      await writeFile(path.join(repo, "after.txt"), safeContent + "updated\n");

      await commitExecutionChanges({ worktreePath: repo, baseCommit, message: "worker commit" });

      expect((await git(repo, ["show", "--format=", "--name-status", "HEAD"])).stdout.trim())
        .toMatch(/^R\d+\tbefore\.txt\tafter\.txt$/);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("does not scan a secret from the source of a staged rename", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "git-runner-staged-rename-source-"));
    try {
      const repo = path.join(tmp, "repo");
      await initRepo(repo);
      const safeContent = "shared\n".repeat(20);
      await writeAndCommit(repo, "before.txt", "AKIAIOSFODNN7EXAMPLE\n" + safeContent, "initial commit");
      const baseCommit = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
      await git(repo, ["mv", "before.txt", "after.txt"]);
      await writeFile(path.join(repo, "after.txt"), safeContent);

      await commitExecutionChanges({ worktreePath: repo, baseCommit, message: "worker commit" });

      expect((await git(repo, ["show", "HEAD:after.txt"])).stdout).toBe(safeContent);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("rejects a staged rename from a protected path", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "git-runner-staged-protected-rename-"));
    try {
      const repo = path.join(tmp, "repo");
      await initRepo(repo);
      await mkdir(path.join(repo, "secrets"));
      await writeAndCommit(repo, "secrets/old.txt", "safe\n", "initial commit");
      const baseCommit = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
      await mkdir(path.join(repo, "public"));
      await git(repo, ["mv", "secrets/old.txt", "public/new.txt"]);
      await writeFile(path.join(repo, "public/new.txt"), "safe\nupdated\n");

      await expect(commitExecutionChanges({ worktreePath: repo, baseCommit, message: "worker commit" }))
        .rejects.toMatchObject({ check: "protected-path inspection" });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("allows a binary staged blob", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "git-runner-staged-binary-"));
    try {
      const repo = path.join(tmp, "repo");
      await initRepo(repo);
      await writeAndCommit(repo, "base.txt", "base\n", "initial commit");
      const baseCommit = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
      await writeFile(path.join(repo, "image.bin"), Buffer.from([0, 255, 1, 2]));

      await commitExecutionChanges({ worktreePath: repo, baseCommit, message: "worker commit" });

      expect((await git(repo, ["show", "HEAD:image.bin"])).stdout).toBe("\0�\u0001\u0002");
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
  it("checks out a fork PR ref detached and removes the disposable worktree", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "git-runner-pr-review-"));
    try {
      const origin = path.join(tmp, "origin");
      await initRepo(origin);
      await writeAndCommit(origin, "base.txt", "base\n", "initial commit");
      const baseCommit = (await git(origin, ["rev-parse", "HEAD"])).stdout.trim();
      await writeAndCommit(origin, "reviewed.txt", "review me\n", "PR head");
      const expectedCommit = (await git(origin, ["rev-parse", "HEAD"])).stdout.trim();
      await git(origin, ["update-ref", "refs/pull/42/head", "HEAD"]);
      await git(origin, ["reset", "--hard", baseCommit]);
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
        expect(worktree.headCommit).toBe(expectedCommit);
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

describe("previewRemoteBranchMerge", () => {
  async function setupTwoBranches(dirPrefix: string, diverge: boolean) {
    const tmp = await mkdtemp(path.join(tmpdir(), dirPrefix));
    const repoDir = path.join(tmp, "repo");
    await initRepo(repoDir);
    await writeAndCommit(repoDir, "shared.txt", "original\n", "initial");
    await git(repoDir, ["checkout", "-b", "staging"]);
    if (diverge) {
      await writeAndCommit(repoDir, "shared.txt", "staging line\n", "staging edit");
      await git(repoDir, ["checkout", "main"]);
      await writeAndCommit(repoDir, "shared.txt", "main line\n", "main edit");
    } else {
      await writeAndCommit(repoDir, "other.txt", "new file\n", "staging addition");
      await git(repoDir, ["checkout", "main"]);
    }
    // Bare mirror as the remote so ls-remote sees both branches without
    // pushing into a checked-out ref.
    const originDir = path.join(tmp, "origin.git");
    await git(tmp, ["clone", "--bare", repoDir, originDir]);
    await git(repoDir, ["remote", "add", "origin", originDir]);
    return { tmp, repoDir };
  }

  it("lists live remote branches without a pair", async () => {
    const { tmp, repoDir } = await setupTwoBranches("git-preview-list-", false);
    try {
      const preview = await previewRemoteBranchMerge({ repositoryPath: repoDir });
      expect(preview.outcome).toBe("branches_only");
      expect(preview.branches.map((b) => b.name).sort()).toEqual(["main", "staging"]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("verdicts a fast-forwardable pair as clean with a commit count", async () => {
    const { tmp, repoDir } = await setupTwoBranches("git-preview-clean-", false);
    try {
      const preview = await previewRemoteBranchMerge({ repositoryPath: repoDir, head: "staging", base: "main" });
      expect(preview.outcome).toBe("clean");
      expect(preview.commits_ahead).toBe(1);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("verdicts an already-contained pair as up_to_date", async () => {
    const { tmp, repoDir } = await setupTwoBranches("git-preview-utd-", false);
    try {
      // staging was pushed at the same commit as main → nothing to merge.
      await git(repoDir, ["branch", "same-as-main", "main"]);
      await exec("git", ["-C", tmp + "/origin.git", "update-ref", "refs/heads/same-as-main", "main"]);
      const preview = await previewRemoteBranchMerge({ repositoryPath: repoDir, head: "same-as-main", base: "main" });
      expect(preview.outcome).toBe("up_to_date");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("detects a conflicting pair and names the files", async () => {
    const { tmp, repoDir } = await setupTwoBranches("git-preview-conflict-", true);
    try {
      const preview = await previewRemoteBranchMerge({ repositoryPath: repoDir, head: "staging", base: "main" });
      expect(preview.outcome).toBe("conflict");
      expect(preview.conflicted_files).toContain("shared.txt");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("reports a missing target branch instead of attempting a merge", async () => {
    const { tmp, repoDir } = await setupTwoBranches("git-preview-missing-", false);
    try {
      const preview = await previewRemoteBranchMerge({ repositoryPath: repoDir, head: "staging", base: "production" });
      expect(preview.outcome).toBe("missing_base");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
