import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, rm } from "node:fs/promises";
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

export function executionBranchName(ticketNumber: string, title: string, attemptNumber: number) {
  return `feedback/${safeSegment(ticketNumber, "ticket")}-${attemptNumber}-${safeSegment(title.toLowerCase(), "change")}`;
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
  const branchName = executionBranchName(input.ticketNumber, input.title, input.attemptNumber);
  const baseRef = `refs/heads/${input.defaultBranch}`;
  await exec("git", ["-C", repository, "show-ref", "--verify", baseRef]);
  const baseCommit = (await exec("git", ["-C", repository, "rev-parse", baseRef])).stdout.trim();
  await exec("git", ["-C", repository, "worktree", "add", "-b", branchName, worktreePath, baseRef]);
  return { worktreePath, branchName, baseCommit };
}

export async function worktreeDiff(worktreePath: string) {
  return (await exec("git", ["-C", worktreePath, "diff", "--no-ext-diff", "--binary"])).stdout;
}

export const DEFAULT_PROTECTED_PATHS = [".env", ".env.*", "secrets/**", "production-data/**", ".git/**"];
const SECRET_PATTERNS = [
  /AKIA[0-9A-Z]{16}/g,
  /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/g,
];

export type ValidationResult = {
  check: string;
  status: "passed" | "skipped";
  detail?: string;
};

export class WorktreeValidationError extends Error {
  check: string;
  results: ValidationResult[];
  output?: string;

  constructor(
    check: string,
    message: string,
    results: ValidationResult[],
    output?: string,
  ) {
    super(message);
    this.name = "WorktreeValidationError";
    this.check = check;
    this.results = results;
    this.output = output;
  }
}

function globRegex(glob: string) {
  let source = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    if (character === "*" && glob[index + 1] === "*") {
      source += ".*";
      index += 1;
    } else if (character === "*") {
      source += "[^/]*";
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += character.replace(/[\\^$+?.()|[\]{}]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`);
}

export function matchesProtectedPath(file: string, patterns = DEFAULT_PROTECTED_PATHS) {
  const normalized = file.replaceAll("\\", "/").replace(/^\.\//, "");
  return patterns.some((pattern) => globRegex(pattern.replaceAll("\\", "/")).test(normalized));
}

export function countCredentialShapes(content: string) {
  return SECRET_PATTERNS.reduce((total, pattern) => {
    pattern.lastIndex = 0;
    return total + Array.from(content.matchAll(pattern)).length;
  }, 0);
}

export function sanitizeValidationOutput(output: string) {
  return output
    .replace(/AKIA[0-9A-Z]{16}/g, "[REDACTED_CREDENTIAL]")
    .replace(
      /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC )?PRIVATE KEY-----/g,
      "[REDACTED_PRIVATE_KEY]",
    );
}

async function git(worktreePath: string, args: string[]) {
  return exec("git", ["-C", worktreePath, ...args], { maxBuffer: 16 * 1024 * 1024 });
}

export async function createConflictResolutionWorktree(input: {
  repositoryPath: string;
  headBranch: string;
  baseBranch: string;
  dataRoot: string;
  projectSlug: string;
  pullRequestNumber: number;
}) {
  const repository = await realpath(input.repositoryPath);
  const root = path.resolve(input.dataRoot, "data", "worktrees");
  const worktreePath = path.resolve(
    root, safeSegment(input.projectSlug, "project"), `pr-${input.pullRequestNumber}-conflict-resolution`,
  );
  const relative = path.relative(root, worktreePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("invalid worktree path");
  }
  await mkdir(path.dirname(worktreePath), { recursive: true });
  // ponytail: a prior attempt (validation failure, crash) can leave this same
  // path registered as a worktree. Force-clear it so retrying doesn't fail on
  // "branch already checked out" or "path already exists".
  await rm(worktreePath, { recursive: true, force: true });
  await exec("git", ["-C", repository, "worktree", "prune"]).catch(() => {});
  await exec("git", ["-C", repository, "fetch", "origin", input.headBranch, input.baseBranch]);
  await exec("git", [
    "-C", repository, "worktree", "add", "-B", input.headBranch, worktreePath, `origin/${input.headBranch}`,
  ]);
  const headCommit = (await exec("git", ["-C", worktreePath, "rev-parse", "HEAD"])).stdout.trim();
  return { worktreePath, branchName: input.headBranch, headCommit };
}

export async function mergeBaseIntoWorktree(worktreePath: string, baseBranch: string) {
  try {
    await git(worktreePath, ["merge", `origin/${baseBranch}`, "--no-edit"]);
    return { conflicted: false };
  } catch {
    return { conflicted: true };
  }
}

export async function conflictedFiles(worktreePath: string) {
  const result = await git(worktreePath, ["diff", "--name-only", "--diff-filter=U", "-z"]);
  return result.stdout.split("\0").filter(Boolean);
}

export async function abortMerge(worktreePath: string) {
  await git(worktreePath, ["merge", "--abort"]);
}

export async function changedWorktreeFiles(worktreePath: string, baseCommit: string) {
  const [baseDiff, working] = await Promise.all([
    git(worktreePath, ["diff", "--name-only", "-z", baseCommit]),
    git(worktreePath, ["ls-files", "-z", "--modified", "--others", "--exclude-standard", "--deleted"]),
  ]);
  return [...new Set(`${baseDiff.stdout}${working.stdout}`.split("\0").filter(Boolean))].sort();
}

async function runCommand(worktreePath: string, command: string) {
  try {
    const result = await exec("sh", ["-lc", command], {
      cwd: worktreePath,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env },
    });
    return `${result.stdout}${result.stderr}`.trim();
  } catch (error: any) {
    const output = sanitizeValidationOutput(`${error?.stdout ?? ""}${error?.stderr ?? ""}`.trim());
    throw Object.assign(new Error("command failed"), { output });
  }
}

async function packageScripts(worktreePath: string) {
  try {
    const parsed = JSON.parse(await readFile(path.join(worktreePath, "package.json"), "utf8"));
    return typeof parsed.scripts === "object" && parsed.scripts ? parsed.scripts as Record<string, string> : {};
  } catch {
    return {};
  }
}

export async function validateExecutionWorktree(input: {
  worktreePath: string;
  baseCommit: string;
  protectedPaths?: string[];
  commands?: Partial<Record<"install" | "lint" | "typecheck" | "test" | "build", string>>;
  projectValidationCommands?: string[];
  skillValidationCommands?: string[];
}) {
  const results: ValidationResult[] = [];
  const files = await changedWorktreeFiles(input.worktreePath, input.baseCommit);
  if (!files.length) {
    throw new WorktreeValidationError(
      "changed-file inspection",
      "no files were modified by the Claude agent execution",
      results,
    );
  }
  results.push({ check: "changed-file inspection", status: "passed", detail: `${files.length} changed file(s)` });

  const protectedMatches = files.filter((file) =>
    matchesProtectedPath(file, input.protectedPaths?.length ? input.protectedPaths : DEFAULT_PROTECTED_PATHS));
  if (protectedMatches.length) {
    throw new WorktreeValidationError(
      "protected-path inspection",
      `protected-path inspection found ${protectedMatches.length} disallowed changed path(s)`,
      results,
    );
  }
  results.push({ check: "protected-path inspection", status: "passed" });

  let secretCount = 0;
  for (const file of files) {
    try {
      const content = await readFile(path.join(input.worktreePath, file), "utf8");
      secretCount += countCredentialShapes(content);
    } catch (error: any) {
      if (error?.code !== "ENOENT") {
        throw new WorktreeValidationError("secret scan", "secret scan could not inspect a changed file", results);
      }
    }
  }
  if (secretCount) {
    throw new WorktreeValidationError(
      "secret scan", `secret scan found ${secretCount} credential-shaped pattern(s)`, results,
    );
  }
  results.push({ check: "secret scan", status: "passed" });

  const scripts = await packageScripts(input.worktreePath);
  results.push({
    check: "dependency validation",
    status: "passed",
    detail: Object.keys(scripts).length ? "project package scripts inspected" : "no package scripts configured",
  });

  const configured = input.commands ?? {};
  const ordered: Array<[string, string | undefined]> = [
    ["install", configured.install],
    ["lint", configured.lint ?? (scripts.lint ? "npm run --silent lint" : undefined)],
    ["typecheck", configured.typecheck ?? (scripts.typecheck ? "npm run --silent typecheck" : undefined)],
    ["tests", configured.test ?? (scripts.test ? "npm run --silent test" : undefined)],
    ["build", configured.build ?? (scripts.build ? "npm run --silent build" : undefined)],
  ];
  for (const [check, command] of ordered) {
    if (!command?.trim()) {
      results.push({ check, status: "skipped", detail: "not configured" });
      continue;
    }
    try {
      await runCommand(input.worktreePath, command);
      results.push({ check, status: "passed" });
    } catch (error: any) {
      throw new WorktreeValidationError(check, `${check} validation failed`, results, error?.output);
    }
  }

  try {
    await git(input.worktreePath, ["diff", "--check", input.baseCommit]);
    results.push({ check: "git diff --check", status: "passed" });
  } catch {
    throw new WorktreeValidationError("git diff --check", "git diff --check failed", results);
  }

  for (const [check, commands] of [
    ["project-specific validation", input.projectValidationCommands],
    ["selected-skill validation", input.skillValidationCommands],
  ] as const) {
    if (!commands?.length) {
      results.push({ check, status: "skipped", detail: "not configured" });
      continue;
    }
    for (const command of commands) {
      try {
        await runCommand(input.worktreePath, command);
      } catch (error: any) {
        throw new WorktreeValidationError(check, `${check} failed`, results, error?.output);
      }
    }
    results.push({ check, status: "passed", detail: `${commands.length} command(s)` });
  }
  return { files, results };
}

export async function commitExecutionChanges(input: {
  worktreePath: string;
  message: string;
  protectedPaths?: string[];
}) {
  await git(input.worktreePath, ["add", "--all"]);
  // validateExecutionWorktree() scanned the working tree at validation time,
  // but anything landing between then and here would otherwise be committed
  // unscanned. Re-scan exactly what is staged, so the secret/protected-path
  // gates hold against the content actually being committed.
  const staged = (await git(input.worktreePath, ["diff", "--cached", "--name-only", "-z"]))
    .stdout.split("\0").filter(Boolean);
  if (!staged.length) {
    throw new WorktreeValidationError(
      "commit verification",
      "no changes were staged for commit — Claude execution produced no file modifications",
      [],
    );
  }
  const protectedMatches = staged.filter((file) =>
    matchesProtectedPath(file, input.protectedPaths?.length ? input.protectedPaths : DEFAULT_PROTECTED_PATHS));
  if (protectedMatches.length) {
    throw new WorktreeValidationError(
      "protected-path inspection",
      `protected-path inspection found ${protectedMatches.length} disallowed staged path(s)`,
      [],
    );
  }
  let secretCount = 0;
  for (const file of staged) {
    const content = (await git(input.worktreePath, ["show", `:${file}`])).stdout;
    secretCount += countCredentialShapes(content);
  }
  if (secretCount) {
    throw new WorktreeValidationError(
      "secret scan", `secret scan found ${secretCount} credential-shaped pattern(s) in the staged commit`, [],
    );
  }
  await git(input.worktreePath, ["commit", "-m", input.message]);
  return (await git(input.worktreePath, ["rev-parse", "HEAD"])).stdout.trim();
}

export async function commitDiffIsEmpty(worktreePath: string, baseCommit: string) {
  const result = await git(worktreePath, ["diff", "--stat", `${baseCommit}..HEAD`]);
  return !result.stdout.trim();
}

export async function pushExecutionBranch(worktreePath: string, branchName: string) {
  await git(worktreePath, ["push", "--set-upstream", "origin", branchName]);
}
