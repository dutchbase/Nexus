import { createHash } from "node:crypto";
import { changedWorktreeFiles, worktreeDiff } from "@dcc/git-runner";

export class ExecutionNoChangesError extends Error {
  readonly code = "execution_no_changes" as const;

  constructor(message: string) {
    super(message);
    this.name = "ExecutionNoChangesError";
  }
}

export async function fingerprintExecutionWorktree(
  worktreePath: string,
  baseCommit: string,
): Promise<string> {
  return createHash("sha256").update(await worktreeDiff(worktreePath, baseCommit)).digest("hex");
}

export async function assertExecutionProducedChanges(input: {
  worktreePath: string;
  baseCommit: string;
  repairing: boolean;
  fingerprintBefore: string;
  detail?: string;
}): Promise<{ changedFiles: string[] }> {
  const changedFiles = await changedWorktreeFiles(input.worktreePath, input.baseCommit);
  const fingerprintAfter = await fingerprintExecutionWorktree(input.worktreePath, input.baseCommit);

  if (changedFiles.length && fingerprintAfter !== input.fingerprintBefore) {
    return { changedFiles };
  }

  throw new ExecutionNoChangesError(
    `execution_no_changes: the ${input.repairing ? "repair" : "execution"} agent reported success but left the worktree ` +
      (changedFiles.length
        ? "byte-identical to the tree it started from"
        : `identical to base commit ${input.baseCommit.slice(0, 12)}`) +
      " — no file was created, modified, or deleted, so the approved plan was not executed." +
      (input.detail ? ` ${input.detail}` : ""),
  );
}
