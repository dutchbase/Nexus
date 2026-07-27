import { execFile } from "node:child_process";
import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

function safeSegment(value: string, fallback: string) {
  const segment = value
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-")
    .slice(0, 64);
  return segment || fallback;
}

export function executionBranchName(ticketNumber: string, title: string) {
  return `feedback/${safeSegment(ticketNumber, "ticket")}-${safeSegment(title.toLowerCase(), "change")}`;
}

export async function createExecutionWorktree(input: {
  repositoryPath: string;
  defaultBranch: string;
  dataRoot: string;
  projectSlug: string;
  ticketNumber: string;
  title: string;
  attemptNumber: number;
}) {
  const repository = await realpath(input.repositoryPath);
  const root = path.resolve(input.dataRoot, "data", "worktrees");
  const worktreePath = path.resolve(
    root,
    safeSegment(input.projectSlug, "project"),
    safeSegment(input.ticketNumber, "ticket"),
    String(input.attemptNumber),
  );
  const relative = path.relative(root, worktreePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("invalid worktree path");
  }
  await mkdir(path.dirname(worktreePath), { recursive: true });
  const branchName = executionBranchName(input.ticketNumber, input.title);
  const baseRef = `refs/heads/${input.defaultBranch}`;
  await exec("git", ["-C", repository, "show-ref", "--verify", baseRef]);
  const baseCommit = (await exec("git", ["-C", repository, "rev-parse", baseRef])).stdout.trim();
  await exec("git", ["-C", repository, "worktree", "add", "-b", branchName, worktreePath, baseRef]);
  return { worktreePath, branchName, baseCommit };
}

export async function worktreeDiff(worktreePath: string) {
  return (await exec("git", ["-C", worktreePath, "diff", "--no-ext-diff", "--binary"])).stdout;
}
