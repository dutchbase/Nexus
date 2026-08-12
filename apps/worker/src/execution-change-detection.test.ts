import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  ExecutionNoChangesError,
  fingerprintExecutionWorktree,
  assertExecutionProducedChanges,
} from "./execution-change-detection.ts";

const exec = promisify(execFile);

async function git(directory: string, args: string[]) {
  return exec("git", ["-C", directory, ...args]);
}

async function createWorkerWorktree(root: string) {
  const repository = path.join(root, "repository");
  await mkdir(repository);
  await git(repository, ["init", "-b", "base"]);
  await git(repository, ["config", "user.email", "worker-test@example.com"]);
  await git(repository, ["config", "user.name", "worker test"]);
  await writeFile(path.join(repository, "result.txt"), "base\n");
  await git(repository, ["add", "."]);
  await git(repository, ["commit", "-m", "base"]);
  const baseCommit = (await git(repository, ["rev-parse", "HEAD"])).stdout.trim();
  const worktreePath = path.join(root, "worker");
  await git(repository, ["worktree", "add", "-b", "execution", worktreePath, baseCommit]);
  return { baseCommit, worktreePath };
}

describe("execution-change-detection", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), "execution-change-detection-"));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("rejects when worktree is untouched", async () => {
    const { baseCommit, worktreePath } = await createWorkerWorktree(tempRoot);
    const fingerprintBefore = await fingerprintExecutionWorktree(worktreePath, baseCommit);

    try {
      await assertExecutionProducedChanges({
        worktreePath,
        baseCommit,
        repairing: false,
        fingerprintBefore,
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ExecutionNoChangesError);
      const error = err as ExecutionNoChangesError;
      expect(error.code).toBe("execution_no_changes");
      expect(error.message).toContain("execution_no_changes");
      expect(error.message).toContain(baseCommit.slice(0, 12));
    }
  });

  it("resolves when new untracked file is created", async () => {
    const { baseCommit, worktreePath } = await createWorkerWorktree(tempRoot);
    const fingerprintBefore = await fingerprintExecutionWorktree(worktreePath, baseCommit);

    // Create an untracked file
    await writeFile(path.join(worktreePath, "new-file.txt"), "new content\n");

    const result = await assertExecutionProducedChanges({
      worktreePath,
      baseCommit,
      repairing: false,
      fingerprintBefore,
    });

    expect(result.changedFiles).toContain("new-file.txt");
  });

  it("resolves when tracked file is modified", async () => {
    const { baseCommit, worktreePath } = await createWorkerWorktree(tempRoot);
    const fingerprintBefore = await fingerprintExecutionWorktree(worktreePath, baseCommit);

    // Modify the tracked file
    await writeFile(path.join(worktreePath, "result.txt"), "modified\n");

    const result = await assertExecutionProducedChanges({
      worktreePath,
      baseCommit,
      repairing: false,
      fingerprintBefore,
    });

    expect(result.changedFiles).toContain("result.txt");
  });

  it("rejects when worktree carries prior changes but fingerprint is identical", async () => {
    const { baseCommit, worktreePath } = await createWorkerWorktree(tempRoot);

    // Create a prior change
    await writeFile(path.join(worktreePath, "prior-change.txt"), "something\n");

    // Get the fingerprint after prior change
    const fingerprintBefore = await fingerprintExecutionWorktree(worktreePath, baseCommit);

    // Simulate a "run" that doesn't change anything (byte-identical)
    // The worktree already has the prior change, but fingerprintAfter === fingerprintBefore

    try {
      await assertExecutionProducedChanges({
        worktreePath,
        baseCommit,
        repairing: false,
        fingerprintBefore,
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ExecutionNoChangesError);
      const error = err as ExecutionNoChangesError;
      expect(error.code).toBe("execution_no_changes");
      expect(error.message).toContain("byte-identical to the tree it started from");
    }
  });

  it("rejects when file created then deleted during run", async () => {
    const { baseCommit, worktreePath } = await createWorkerWorktree(tempRoot);
    const fingerprintBefore = await fingerprintExecutionWorktree(worktreePath, baseCommit);

    // Create a file
    const filePath = path.join(worktreePath, "temp-file.txt");
    await writeFile(filePath, "temporary\n");

    // Delete it (fingerprint back to identical, but some git operations might record it)
    await rm(filePath);

    // The fingerprint should be identical to before
    const fingerprintAfter = await fingerprintExecutionWorktree(worktreePath, baseCommit);
    expect(fingerprintAfter).toBe(fingerprintBefore);

    try {
      await assertExecutionProducedChanges({
        worktreePath,
        baseCommit,
        repairing: false,
        fingerprintBefore,
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ExecutionNoChangesError);
      const error = err as ExecutionNoChangesError;
      expect(error.code).toBe("execution_no_changes");
    }
  });
});
