import { execFile, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const privateCloneOrigins = new Map<string, string>();

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

export async function worktreeDiff(worktreePath: string, baseCommit?: string) {
  return (await exec("git", ["-C", worktreePath, "diff", "--no-ext-diff", "--binary", ...(baseCommit ? [baseCommit] : [])])).stdout;
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

const SAFE_GIT_ARGS = [
  "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "diff.external=",
  "-c", "core.attributesFile=/dev/null",
];

async function git(worktreePath: string, args: string[], input?: string, safe = false) {
  const commandArgs = [...(safe ? SAFE_GIT_ARGS : []), "-C", worktreePath, ...args];
  const env = safe ? {
    PATH: process.env.PATH, LANG: process.env.LANG, LC_ALL: process.env.LC_ALL,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
  } : undefined;
  if (input === undefined) return exec("git", commandArgs, { maxBuffer: 16 * 1024 * 1024, env });
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const process = spawn("git", commandArgs, { env });
    let stdout = "";
    let stderr = "";
    process.stdout.on("data", (chunk) => { stdout += chunk; });
    process.stderr.on("data", (chunk) => { stderr += chunk; });
    process.stdin.on("error", (error: NodeJS.ErrnoException) => { if (error.code !== "EPIPE") reject(error); });
    process.once("error", reject);
    process.once("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(Object.assign(new Error("git command failed"), { stdout, stderr }));
    });
    process.stdin.end(input);
  });
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
  const sandbox = process.env.DCC_VALIDATION_BWRAP_PATH ?? "bwrap";
  const nodeRoot = path.dirname(path.dirname(await realpath(process.execPath)));
  const args = [
    "--die-with-parent", "--new-session", "--unshare-net", "--unshare-pid", "--unshare-ipc", "--unshare-uts",
    "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin",
    "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
    "--dir", "/opt", "--dir", "/opt/node", "--ro-bind", nodeRoot, "/opt/node", "--tmpfs", "/tmp",
    "--dir", "/workspace", "--bind", worktreePath, "/workspace", "--proc", "/proc", "--dev", "/dev", "--chdir", "/workspace", "--clearenv",
    "--setenv", "PATH", "/opt/node/bin:/usr/bin:/bin", "--setenv", "HOME", "/tmp",
    "--setenv", "LANG", process.env.LANG ?? "C.UTF-8", "sh", "-lc", command,
  ];
  try {
    const result = await exec(sandbox, args, { maxBuffer: 16 * 1024 * 1024 });
    return (result.stdout + result.stderr).trim();
  } catch (error: any) {
    const output = sanitizeValidationOutput(((error?.stdout ?? "") + (error?.stderr ?? "")).trim());
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

async function scanExecutionFiles(
  worktreePath: string, baseCommit: string, protectedPaths: string[] | undefined,
  results: ValidationResult[], check = "secret scan",
) {
  const files = await changedWorktreeFiles(worktreePath, baseCommit);
  const protectedMatches = files.filter((file) =>
    matchesProtectedPath(file, protectedPaths?.length ? protectedPaths : DEFAULT_PROTECTED_PATHS));
  let secretCount = 0;
  for (const file of files) {
    try {
      secretCount += countCredentialShapes(await readFile(path.join(worktreePath, file), "utf8"));
    } catch (error: any) {
      if (error?.code !== "ENOENT") {
        throw new WorktreeValidationError(check, check + " could not inspect a changed file", results);
      }
    }
  }
  return { files, protectedMatches, secretCount };
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
  let scan = await scanExecutionFiles(input.worktreePath, input.baseCommit, input.protectedPaths, results);
  if (!scan.files.length) {
    throw new WorktreeValidationError(
      "changed-file inspection",
      "no files were modified by the Claude agent execution",
      results,
    );
  }
  results.push({ check: "changed-file inspection", status: "passed", detail: scan.files.length + " changed file(s)" });

  if (scan.protectedMatches.length) {
    throw new WorktreeValidationError(
      "protected-path inspection",
      "protected-path inspection found " + scan.protectedMatches.length + " disallowed changed path(s)",
      results,
    );
  }
  results.push({ check: "protected-path inspection", status: "passed" });

  if (scan.secretCount) {
    throw new WorktreeValidationError(
      "secret scan", "secret scan found " + scan.secretCount + " credential-shaped pattern(s)", results,
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
  scan = await scanExecutionFiles(input.worktreePath, input.baseCommit, input.protectedPaths, results, "final tree scan");
  if (scan.protectedMatches.length || scan.secretCount) {
    throw new WorktreeValidationError(
      "final tree scan",
      scan.protectedMatches.length
        ? "final tree scan found " + scan.protectedMatches.length + " disallowed changed path(s)"
        : "final tree scan found " + scan.secretCount + " credential-shaped pattern(s)",
      results,
    );
  }
  results.push({ check: "final tree scan", status: "passed", detail: scan.files.length + " changed file(s)" });
  return { files: scan.files, results };
}

export async function commitExecutionChanges(input: {
  worktreePath: string;
  message: string;
  protectedPaths?: string[];
  baseCommit?: string;
}) {
  if (input.baseCommit) await git(input.worktreePath, ["reset", "--soft", input.baseCommit]);
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
function requireGitRoot(worktreePath: string) {
  return git(worktreePath, ["rev-parse", "--show-toplevel"])
    .then(({ stdout }) => realpath(stdout.trim()));
}

function requireContainedPath(root: string, candidate: string, label: string) {
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`${label} escapes its root`);
  return candidate;
}

export async function createPrivateExecutionClone(input: { worktreePath: string }) {
  const sourcePath = await realpath(input.worktreePath);
  const sourceRoot = await requireGitRoot(sourcePath);
  requireContainedPath(sourceRoot, sourcePath, "worktree path");
  const privateRoot = await mkdtemp(path.join(tmpdir(), "dcc-execution-clone-"));
  const clonePath = path.join(privateRoot, "worktree");
  try {
    await exec("git", ["clone", "--no-local", sourceRoot, clonePath]);
    const sourceHead = (await git(sourceRoot, ["rev-parse", "HEAD"])).stdout.trim();
    await git(clonePath, ["checkout", "--detach", sourceHead]);
    await git(clonePath, ["remote", "remove", "origin"]);
    const dirtyPatch = (await git(sourceRoot, ["diff", "--binary", "HEAD"])).stdout;
    if (dirtyPatch) {
      const patchPath = path.join(privateRoot, "source.patch");
      await writeFile(patchPath, dirtyPatch);
      await git(clonePath, ["apply", "--binary", patchPath]);
      await rm(patchPath, { force: true });
    }
    const untracked = (await git(sourceRoot, ["ls-files", "--others", "--exclude-standard", "-z"])).stdout.split("\0").filter(Boolean);
    for (const file of untracked) {
      const sourceFile = requireContainedPath(sourceRoot, path.resolve(sourceRoot, file), "source file");
      const cloneFile = requireContainedPath(clonePath, path.resolve(clonePath, file), "clone file");
      await mkdir(path.dirname(cloneFile), { recursive: true });
      await cp(sourceFile, cloneFile, { recursive: true, dereference: false });
    }
    privateCloneOrigins.set(clonePath, sourceRoot);
    return {
      clonePath,
      originWorktreePath: sourceRoot,
      cleanup: async () => {
        privateCloneOrigins.delete(clonePath);
        await rm(privateRoot, { recursive: true, force: true });
      },
    };
  } catch (error) {
    privateCloneOrigins.delete(clonePath);
    await rm(privateRoot, { recursive: true, force: true });
    throw error;
  }
}

async function replaceWorkingTree(source: string, destination: string, excludeNestedGit = false) {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(destination)) {
    if (entry !== ".git") await rm(path.join(destination, entry), { recursive: true, force: true });
  }
  for (const entry of await readdir(source)) {
    if (entry === ".git") continue;
    const sourceEntry = path.join(source, entry);
    await cp(sourceEntry, path.join(destination, entry), {
      recursive: true, dereference: false,
      filter: excludeNestedGit ? (candidate) => !path.relative(source, candidate).split(path.sep).includes(".git") : undefined,
    });
  }
}

export async function importPrivateExecutionClone(input: {
  clonePath: string;
  worktreePath: string;
  baseCommit: string;
  originWorktreePath: string;
}) {
  const clonePath = await realpath(input.clonePath);
  const worktreePath = await realpath(input.worktreePath);
  const originWorktreePath = await realpath(input.originWorktreePath);
  if (originWorktreePath !== worktreePath || privateCloneOrigins.get(clonePath) !== worktreePath) {
    throw new Error("clone did not originate from this worktree");
  }
  if (await requireGitRoot(worktreePath) !== worktreePath) throw new Error("worktree path must be its Git root");

  const importRoot = await mkdtemp(path.join(tmpdir(), "dcc-execution-import-"));
  const stagingPath = path.join(importRoot, "staging");
  const backupPath = path.join(importRoot, "backup");
  try {
    await exec("git", ["clone", "--no-local", worktreePath, stagingPath]);
    await git(stagingPath, ["remote", "remove", "origin"], undefined, true);
    await git(stagingPath, ["checkout", "--detach", input.baseCommit], undefined, true);
    await replaceWorkingTree(clonePath, stagingPath, true);
    await git(stagingPath, ["add", "--intent-to-add", "--all"], undefined, true);
    const patch = (await git(stagingPath, ["diff", "--binary", "--no-ext-diff", "--no-textconv", input.baseCommit], undefined, true)).stdout;

    await git(stagingPath, ["reset", "--hard", input.baseCommit], undefined, true);
    await git(stagingPath, ["clean", "-fdx"], undefined, true);
    if (patch) await git(stagingPath, ["apply", "--check", "--binary"], patch, true);

    const priorHead = (await git(worktreePath, ["rev-parse", "HEAD"])).stdout.trim();
    await replaceWorkingTree(worktreePath, backupPath);
    try {
      await git(worktreePath, ["reset", "--hard", input.baseCommit]);
      await git(worktreePath, ["clean", "-fdx"]);
      if (patch) await git(worktreePath, ["apply", "--binary"], patch);
    } catch (error) {
      await git(worktreePath, ["reset", "--hard", priorHead]);
      await git(worktreePath, ["clean", "-fdx"]);
      await replaceWorkingTree(backupPath, worktreePath);
      throw error;
    }
  } finally {
    await rm(importRoot, { recursive: true, force: true });
  }
}
