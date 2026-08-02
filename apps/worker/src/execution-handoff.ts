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
    const legacySupportRoot = path.join(".git", "dcc-support");
    const supportRoot = path.join(path.dirname(clone.clonePath), "support");
    const promptFile = path.join(supportRoot, "execution-prompt.md");
    const skillBundleDir = path.join(supportRoot, "skills");
    await mkdir(supportRoot, { recursive: true });
    await cp(input.promptFile, promptFile);
    await cp(input.skillBundleDir, skillBundleDir, { recursive: true, dereference: false });
    const invocation = { ...input.invocation } as Record<string, unknown>;
    if (typeof invocation.task === "string") invocation.task = invocation.task.replaceAll(legacySupportRoot, supportRoot);
    if (Array.isArray(invocation.pluginDirectories)) {
      invocation.pluginDirectories = invocation.pluginDirectories.map((directory) => {
        if (typeof directory !== "string") return directory;
        const relative = path.relative(path.join(legacySupportRoot, "skills"), directory);
        return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
          ? path.join(skillBundleDir, relative)
          : directory;
      });
    }
    const result = await input.invoke({
      ...input.invocation,
      ...invocation,
      workingDirectory: clone.clonePath,
      executionDirectory: clone.clonePath,
      promptFile,
      skillBundleDir,
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
