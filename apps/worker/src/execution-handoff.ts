import {
  createPrivateExecutionClone, importPrivateExecutionClone,
} from "../../../packages/git-runner/src/index.ts";

export function resultCommitAfterSuccessfulExecution(repairing: boolean, resultCommit: string | null) {
  return repairing ? null : resultCommit;
}

export async function runPrivateExecution<T extends Record<string, unknown>, R>(input: {
  worktreePath: string;
  baseCommit: string;
  readOnlyPaths: string[];
  invocation: T;
  invoke: (input: T & {
    workingDirectory: string;
    executionDirectory: string;
    readOnlyPaths: string[];
  }) => Promise<R>;
}) {
  const clone = await createPrivateExecutionClone({ worktreePath: input.worktreePath });
  try {
    const result = await input.invoke({
      ...input.invocation,
      workingDirectory: clone.clonePath,
      executionDirectory: clone.clonePath,
      readOnlyPaths: input.readOnlyPaths,
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
