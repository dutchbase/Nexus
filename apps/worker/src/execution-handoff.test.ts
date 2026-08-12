import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { invokeExecutionClaude } from "../../../packages/claude-runner/src/index.ts";
import { assertAttemptResultCommit, commitExecutionChanges } from "../../../packages/git-runner/src/index.ts";
import { resultCommitAfterSuccessfulExecution, runPrivateExecution } from "./execution-handoff.ts";

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

async function createSupportFiles(root: string) {
  const promptFile = path.join(root, "execution-prompt.md");
  const skillBundleDir = path.join(root, "host-skills");
  await writeFile(promptFile, "host prompt\n");
  await mkdir(path.join(skillBundleDir, "ponytail"), { recursive: true });
  await writeFile(path.join(skillBundleDir, "execution-plan.md"), "host plan\n");
  await writeFile(path.join(skillBundleDir, "ponytail", "SKILL.md"), "host skill\n");
  return { promptFile, skillBundleDir };
}

it("runs Claude in a private clone and imports its final tree from the saved attempt base", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "worker-execution-handoff-"));
  try {
    const { baseCommit, worktreePath } = await createWorkerWorktree(root);
    const support = await createSupportFiles(root);
    await writeFile(path.join(worktreePath, "result.txt"), "repair seed\n");
    let privateDirectory = "";

    const result = await runPrivateExecution({
      worktreePath,
      baseCommit,
      ...support,
      invocation: { task: "execute with PLAN_FILE=.git/dcc-support/skills/execution-plan.md" },
      invoke: async (input) => {
        privateDirectory = input.workingDirectory;
        expect(privateDirectory).not.toBe(worktreePath);
        expect(input.executionDirectory).toBe(privateDirectory);
        expect(path.isAbsolute(input.promptFile)).toBe(true);
        expect(path.isAbsolute(input.skillBundleDir)).toBe(true);
        expect(path.relative(privateDirectory, input.skillBundleDir)).toMatch(/^\.\./);
        expect(JSON.stringify(input)).not.toContain(root);
        expect(await readFile(input.promptFile, "utf8")).toBe("host prompt\n");
        expect(await readFile(path.join(input.skillBundleDir, "execution-plan.md"), "utf8")).toBe("host plan\n");
        expect(await readFile(path.join(input.skillBundleDir, "ponytail", "SKILL.md"), "utf8")).toBe("host skill\n");
        expect((await git(privateDirectory, ["remote"])).stdout.trim()).toBe("");
        await writeFile(path.join(input.skillBundleDir, "ponytail", "SKILL.md"), "clone edit\n");
        expect(await readFile(path.join(privateDirectory, "result.txt"), "utf8")).toBe("repair seed\n");
        await writeFile(path.join(privateDirectory, "result.txt"), "final output\n");
        expect(await readFile(path.join(worktreePath, "result.txt"), "utf8")).toBe("repair seed\n");
        return { exitCode: 0 };
      },
    });

    expect(result).toEqual({ exitCode: 0 });
    expect(await readFile(path.join(worktreePath, "result.txt"), "utf8")).toBe("final output\n");
    expect(await readFile(path.join(support.skillBundleDir, "ponytail", "SKILL.md"), "utf8")).toBe("host skill\n");
    await expect(access(privateDirectory)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("keeps copied prompt, skills, and plugins readable while the runner hides Git metadata", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "worker-runner-handoff-"));
  try {
    const { baseCommit, worktreePath } = await createWorkerWorktree(root);
    const support = await createSupportFiles(root);
    const plugin = path.join(support.skillBundleDir, "plugins", "dcc-local");
    await mkdir(path.join(plugin, ".claude-plugin"), { recursive: true });
    await writeFile(path.join(plugin, ".claude-plugin", "plugin.json"), '{"name":"dcc-local"}\n');
    const executable = path.join(root, "claude");
    await writeFile(executable, `#!/bin/sh
if [ "$1" = "--version" ]; then printf '%s\n' '2.1.220 (Claude Code)'; exit 0; fi
for arg in "$@"; do
  if [ "$previous" = "--append-system-prompt-file" ]; then prompt="$arg"; fi
  if [ "$previous" = "--add-dir" ]; then skills="$arg"; fi
  if [ "$previous" = "--plugin-dir" ]; then plugin="$arg"; fi
  previous="$arg"
done
test ! -e "$PWD/.git" || exit 6
test -f "$prompt" || exit 7
test -f "$skills/execution-plan.md" || exit 8
test -f "$plugin/.claude-plugin/plugin.json" || exit 9
printf '%s\n' 'runner output' > result.txt
printf '%s\n' '{"type":"result","subtype":"success"}'
`);
    await chmod(executable, 0o755);

    await runPrivateExecution({
      worktreePath,
      baseCommit,
      ...support,
      invocation: {
        task: "Use PLAN_FILE=.git/dcc-support/skills/execution-plan.md.",
        sessionId: "00000000-0000-0000-0000-000000000001",
        model: "test", effort: "low", maxTurns: 5, oauthToken: "token",
        pluginDirectories: [".git/dcc-support/skills/plugins/dcc-local"],
        logPath: path.join(root, "execution.log"), timeoutMs: 1_000,
        claudeExecutable: executable, onEvent: async () => undefined,
      },
      invoke: invokeExecutionClaude,
    });

    expect(await readFile(path.join(worktreePath, "result.txt"), "utf8")).toBe("runner output\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("leaves the worker worktree unchanged and removes the private clone when Claude fails", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "worker-execution-handoff-failure-"));
  try {
    const { baseCommit, worktreePath } = await createWorkerWorktree(root);
    const support = await createSupportFiles(root);
    let privateDirectory = "";

    await expect(runPrivateExecution({
      worktreePath,
      baseCommit,
      ...support,
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

it("replaces a prior repair commit with the imported result squashed from the saved base", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "worker-repair-publication-"));
  try {
    const { baseCommit, worktreePath } = await createWorkerWorktree(root);
    const support = await createSupportFiles(root);
    await writeFile(path.join(worktreePath, "result.txt"), "prior result\n");
    await git(worktreePath, ["add", "."]);
    await git(worktreePath, ["commit", "-m", "prior result"]);
    const priorResultCommit = (await git(worktreePath, ["rev-parse", "HEAD"])).stdout.trim();

    await runPrivateExecution({
      worktreePath,
      baseCommit,
      ...support,
      invocation: { task: "repair" },
      invoke: async (input) => {
        expect(await readFile(path.join(input.workingDirectory, "result.txt"), "utf8")).toBe("prior result\n");
        await writeFile(path.join(input.workingDirectory, "result.txt"), "repaired result\n");
        return { exitCode: 0 };
      },
    });

    expect(resultCommitAfterSuccessfulExecution(false, priorResultCommit)).toBe(priorResultCommit);
    let resultCommit = resultCommitAfterSuccessfulExecution(true, priorResultCommit);
    if (!resultCommit) {
      resultCommit = await commitExecutionChanges({
        worktreePath,
        baseCommit,
        message: "final repaired result",
      });
    }

    expect(resultCommit).not.toBe(priorResultCommit);
    expect((await git(worktreePath, ["rev-list", "--count", `${baseCommit}..HEAD`])).stdout.trim()).toBe("1");
    expect((await git(worktreePath, ["show", "HEAD:result.txt"])).stdout).toBe("repaired result\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("rejects a stored result that is no longer the attempt worktree head", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "worker-stale-result-"));
  try {
    const { baseCommit, worktreePath } = await createWorkerWorktree(root);
    await writeFile(path.join(worktreePath, "result.txt"), "first result\n");
    const resultCommit = await commitExecutionChanges({ worktreePath, baseCommit, message: "first" });
    await writeFile(path.join(worktreePath, "result.txt"), "different result\n");
    await commitExecutionChanges({ worktreePath, baseCommit, message: "second" });

    await expect(assertAttemptResultCommit({ worktreePath, baseCommit, resultCommit }))
      .rejects.toThrow("attempt result commit is not the current worktree HEAD");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
