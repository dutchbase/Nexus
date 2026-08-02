import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  createPrivateExecutionClone, importPrivateExecutionClone,
} from "../../../packages/git-runner/src/index.ts";

export function resultCommitAfterSuccessfulExecution(repairing: boolean, resultCommit: string | null) {
  return repairing ? null : resultCommit;
}

export async function runPrivateExecution<T extends Record<string, unknown>, R>(input: {
  worktreePath: string;
  baseCommit: string;
  promptFile: string;
  skillBundleDir: string;
  invocation: T;
  invoke: (input: T & {
    workingDirectory: string;
    executionDirectory: string;
    promptFile: string;
    skillBundleDir: string;
  }) => Promise<R>;
}) {
  const clone = await createPrivateExecutionClone({ worktreePath: input.worktreePath });
  try {
    const supportRoot = path.join(clone.clonePath, ".git", "dcc-support");
    const promptFile = path.join(supportRoot, "execution-prompt.md");
    const skillBundleDir = path.join(supportRoot, "skills");
    await mkdir(supportRoot, { recursive: true });
    await cp(input.promptFile, promptFile);
    await cp(input.skillBundleDir, skillBundleDir, { recursive: true, dereference: false });
    const result = await input.invoke({
      ...input.invocation,
      workingDirectory: clone.clonePath,
      executionDirectory: clone.clonePath,
      promptFile: path.relative(clone.clonePath, promptFile),
      skillBundleDir: path.relative(clone.clonePath, skillBundleDir),
    });
    await importPrivateExecutionClone({
      clonePath: clone.clonePath,
      worktreePath: input.worktreePath,
      baseCommit: input.baseCommit,
      originWorktreePath: clone.originWorktreePath,
    });
    return result;
  } finally {
    await clone.cleanup();
  }
}
