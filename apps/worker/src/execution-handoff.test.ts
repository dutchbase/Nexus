import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { runPrivateExecution } from "./execution-handoff.ts";

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

it("runs Claude in a private clone and imports its final tree from the saved attempt base", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "worker-execution-handoff-"));
  try {
    const { baseCommit, worktreePath } = await createWorkerWorktree(root);
    await writeFile(path.join(worktreePath, "result.txt"), "repair seed\n");
    let privateDirectory = "";

    const result = await runPrivateExecution({
      worktreePath,
      baseCommit,
      readOnlyPaths: ["/prompt.md", "/skills"],
      invocation: { task: "execute" },
      invoke: async (input) => {
        privateDirectory = input.workingDirectory;
        expect(privateDirectory).not.toBe(worktreePath);
        expect(input.executionDirectory).toBe(privateDirectory);
        expect(input.readOnlyPaths).toEqual(["/prompt.md", "/skills"]);
        expect(await readFile(path.join(privateDirectory, "result.txt"), "utf8")).toBe("repair seed\n");
        await writeFile(path.join(privateDirectory, "result.txt"), "final output\n");
        expect(await readFile(path.join(worktreePath, "result.txt"), "utf8")).toBe("repair seed\n");
        return { exitCode: 0 };
      },
    });

    expect(result).toEqual({ exitCode: 0 });
    expect(await readFile(path.join(worktreePath, "result.txt"), "utf8")).toBe("final output\n");
    await expect(access(privateDirectory)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("leaves the worker worktree unchanged and removes the private clone when Claude fails", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "worker-execution-handoff-failure-"));
  try {
    const { baseCommit, worktreePath } = await createWorkerWorktree(root);
    let privateDirectory = "";

    await expect(runPrivateExecution({
      worktreePath,
      baseCommit,
      readOnlyPaths: [],
      invocation: { task: "execute" },
      invoke: async (input) => {
        privateDirectory = input.workingDirectory;
        await writeFile(path.join(privateDirectory, "result.txt"), "must not import\n");
        throw new Error("Claude failed");
      },
    })).rejects.toThrow("Claude failed");

    expect(await readFile(path.join(worktreePath, "result.txt"), "utf8")).toBe("base\n");
    await expect(access(privateDirectory)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
