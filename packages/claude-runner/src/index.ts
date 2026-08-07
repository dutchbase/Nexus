import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { appendFile, chmod, copyFile, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertSubscriptionOnlyEnvironment, ClaudeAuthError } from "./auth-guard.ts";
export { assertSubscriptionOnlyEnvironment, ClaudeAuthError, forbiddenClaudeAuthVariables } from "./auth-guard.ts";

async function runClaude(args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; executable?: string; signal?: AbortSignal; timeoutMs?: number } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "dcc-claude-output-"));
  const stdoutPath = path.join(directory, "stdout");
  const stderrPath = path.join(directory, "stderr");
  const stdoutFile = await open(stdoutPath, "wx");
  const stderrFile = await open(stderrPath, "wx");
  try {
    const outcome = await new Promise<{ exitCode: number | null; timedOut: boolean }>((resolve, reject) => {
      const child = spawn(options.executable ?? "claude", args, {
        cwd: options.cwd, env: options.env, stdio: ["ignore", stdoutFile.fd, stderrFile.fd], signal: options.signal,
        detached: process.platform !== "win32",
      });
      let timedOut = false;
      let killTimer: NodeJS.Timeout | undefined;
      const terminate = (signal: NodeJS.Signals) => {
        if (!child.pid) return child.kill(signal);
        if (process.platform === "win32") {
          const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
          killer.on("error", () => child.kill(signal));
          killer.unref();
          return true;
        }
        try { return process.kill(-child.pid, signal); }
        catch { return child.kill(signal); }
      };
      const timeout = options.timeoutMs === undefined ? undefined : setTimeout(() => {
        timedOut = true;
        terminate("SIGTERM");
        killTimer = setTimeout(() => terminate("SIGKILL"), 5_000);
      }, options.timeoutMs);
      child.on("error", (error) => {
        if (timeout) clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        reject(error);
      });
      child.on("close", (exitCode) => {
        if (timeout) clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        resolve({ exitCode, timedOut });
      });
    });
    await stdoutFile.close();
    await stderrFile.close();
    return {
      stdout: await readFile(stdoutPath, "utf8"),
      stderr: await readFile(stderrPath, "utf8"),
      ...outcome,
    };
  } finally {
    await stdoutFile.close().catch(() => undefined);
    await stderrFile.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
}

export class ClaudeExecutionError extends Error {
  constructor(
    message: string,
    public exitCode: number,
    public code: "execution_failed" | "execution_timeout" | "execution_cancelled",
  ) {
    super(message);
  }
}

export class ClaudePlanningError extends Error {
  constructor(
    message: string,
    public exitCode: number,
    public code: "planning_timeout",
  ) {
    super(message);
  }
}

function minimalClaudeEnvironment(env: NodeJS.ProcessEnv, oauthToken: string): NodeJS.ProcessEnv {
  return {
    PATH: env.PATH,
    LANG: env.LANG,
    LC_ALL: env.LC_ALL,
    CLAUDE_CODE_OAUTH_TOKEN: oauthToken,
    AGENT_CONTROL_DISABLE: "1",
  };
}

export async function preflightClaudeAuthentication(env: NodeJS.ProcessEnv = process.env) {
  assertSubscriptionOnlyEnvironment(env);
  const result = await runClaude(["auth", "status"], {
    env: minimalClaudeEnvironment(env, env.CLAUDE_CODE_OAUTH_TOKEN ?? ""),
  });
  let status: any = null;
  try { status = JSON.parse(result.stdout.trim()); } catch { /* handled below */ }
  // ponytail: `claude auth status` reports loggedIn/authMethod, not the
  // authenticated/method fields this code originally expected — that
  // mismatch made every subscription-token login fail preflight.
  const isSubscriptionAuth = status?.authMethod === "subscription" || status?.authMethod === "oauth_token";
  if (result.exitCode !== 0 || status?.loggedIn !== true || !isSubscriptionAuth) {
    throw new ClaudeAuthError("blocked_auth", "blocked_auth: Claude is unauthenticated or is not using subscription authentication");
  }
  return status as { loggedIn: true; authMethod: "subscription" | "oauth_token"; apiProvider?: string };
}

export type PlanningInvocation = {
  task: string; sessionId: string; model: string; effort: string; promptFile: string;
  skillBundleDir?: string; pluginDirectories?: readonly string[]; workingDirectory: string; maxTurns: number; oauthToken: string; scenarioPath?: string; tools?: string[]; claudeExecutable?: string; guardPath?: string;
  gitMetadataPaths?: string[]; sensitiveEnvironmentVariables?: string[]; signal?: AbortSignal; timeoutMs?: number;
};

const trustedBashGuard = fileURLToPath(new URL("./bash-guard.mjs", import.meta.url));

export async function materializeBashGuard(sourcePath = trustedBashGuard) {
  const directory = await mkdtemp(path.join(tmpdir(), "dcc-claude-guard-"));
  const guardPath = path.join(directory, "bash-guard.mjs");
  try {
    await copyFile(sourcePath, guardPath);
    await chmod(guardPath, 0o400);
    await chmod(directory, 0o500);
    return {
      directory,
      path: guardPath,
      cleanup: async () => {
        await chmod(directory, 0o700).catch(() => undefined);
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

function skillDirectoryArguments(input: PlanningInvocation) {
  return [
    ...(input.skillBundleDir ? ["--add-dir", input.skillBundleDir] : []),
    ...(input.pluginDirectories ?? []).flatMap((directory) => ["--plugin-dir", directory]),
  ];
}

function hookCommand(guardPath: string) {
  return `node ${JSON.stringify(guardPath)}`;
}

function fileHookCommand(guardPath: string, readRoots: string[], writeRoot: string, writePaths?: readonly string[]) {
  const policy = Buffer.from(JSON.stringify(writePaths ? { readRoots, writePaths } : { readRoots, writeRoot })).toString("base64url");
  return `${hookCommand(guardPath)} ${policy}`;
}

function sessionAgents(input: PlanningInvocation, guardPath = input.guardPath ?? trustedBashGuard) {
  const bashHooks = {
    PreToolUse: [{
      matcher: "Bash",
      hooks: [{ type: "command", command: hookCommand(guardPath) }],
    }],
  };
  return JSON.stringify({
    "dcc-mechanical": {
      description: "Handles small mechanical implementation tasks.",
      prompt: "Complete only the assigned mechanical task. Do not commit, push, merge, or create a pull request.",
      model: "haiku", effort: "low", tools: ["Read", "Glob", "Grep", "Edit", "Write", "Bash"], hooks: bashHooks,
    },
    "dcc-implementer": {
      description: "Implements an independently scoped plan task.",
      prompt: "Implement only the assigned task and report validation. Do not commit, push, merge, or create a pull request.",
      model: input.model, effort: input.effort, tools: ["Read", "Glob", "Grep", "Edit", "Write", "Bash"], hooks: bashHooks,
    },
    "dcc-repair": {
      description: "Traces and repairs a focused failure.",
      prompt: "Reproduce and repair only the assigned root cause. Do not commit, push, merge, or create a pull request.",
      model: input.model, effort: input.effort, tools: ["Read", "Glob", "Grep", "Edit", "Write", "Bash"], hooks: bashHooks,
    },
    "dcc-reviewer": {
      description: "Reviews assigned code without modifying it.",
      prompt: "Review the assigned change read-only. Do not edit files, run Bash, commit, push, merge, or create a pull request.",
      model: input.model, effort: input.effort, tools: ["Read", "Glob", "Grep"],
    },
  });
}

const defaultSensitiveEnvironmentVariables = [
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN",
  "GITHUB_TOKEN", "GH_TOKEN", "DATABASE_URL", "PGPASSWORD", "NPM_TOKEN",
  "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
];
const sensitiveHomePaths = [
  "~/.ssh", "~/.aws", "~/.config", "~/.docker", "~/.kube", "~/.gnupg", "~/.password-store",
  "~/.git-credentials", "~/.netrc", "~/.npmrc",
];

function permissionPath(target: string) {
  return `//${path.resolve(target).slice(1)}`;
}

function canonicalPath(target: string, cwd: string) {
  let current = path.resolve(cwd, target);
  const missing: string[] = [];
  while (true) {
    try { return path.join(realpathSync(current), ...missing); } catch {
      const parent = path.dirname(current);
      if (parent === current) throw new Error(`could not resolve execution path: ${target}`);
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

function isWithin(target: string, root: string) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function executablePath(command: string) {
  const candidates = path.isAbsolute(command)
    ? [command]
    : (process.env.PATH ?? "").split(path.delimiter).map((directory) => path.join(directory, command));
  for (const candidate of candidates) {
    try { return realpathSync(candidate); } catch { /* try the next PATH entry */ }
  }
  throw new Error(`could not resolve executable: ${command}`);
}

function bwrapParentDirectories(target: string) {
  const directories: string[] = [];
  for (let current = path.dirname(target); current !== path.dirname(current); current = path.dirname(current)) {
    directories.unshift(current);
  }
  return directories.filter((directory) => !["/tmp", "/opt", "/usr", "/proc", "/dev"].includes(directory))
    .flatMap((directory) => ["--dir", directory]);
}

function scopedWritePaths(input: ExecutionInvocation, worktree: string) {
  if (input.allowedWritePaths === undefined) return undefined;
  const paths = [...new Set(input.allowedWritePaths.map((target) => canonicalPath(target, worktree)))];
  if (!paths.length || paths.some((target) => !isWithin(target, worktree) || !statSync(target).isFile())) {
    throw new Error("allowed execution write paths must be existing regular files inside the worktree");
  }
  return paths;
}

function scopedBwrapLaunch(input: ExecutionInvocation, settingsDirectory: string, guardPath: string) {
  const worktree = canonicalPath(input.workingDirectory, input.workingDirectory);
  const writePaths = scopedWritePaths(input, worktree);
  if (!writePaths) throw new Error("scoped execution requires write paths");
  const bwrap = executablePath(process.env.DCC_CLAUDE_BWRAP_PATH ?? "/usr/bin/bwrap");
  const nodeRoot = realpathSync(path.dirname(path.dirname(process.execPath)));
  const executable = executablePath(input.claudeExecutable ?? "claude");
  const executableInNodeRoot = isWithin(executable, nodeRoot);
  const promptFile = canonicalPath(input.promptFile, worktree);
  const skillBundleDir = input.skillBundleDir ? canonicalPath(input.skillBundleDir, worktree) : undefined;
  const plugins = (input.pluginDirectories ?? []).map((directory) => canonicalPath(directory, worktree));
  const virtual = {
    settingsDirectory: "/opt/dcc-settings",
    settingsFile: "/opt/dcc-settings/settings.json",
    guardPath: "/opt/dcc-guard.mjs",
    promptFile: "/opt/dcc-prompt.md",
    skillBundleDir: "/opt/dcc-skills",
    pluginDirectories: plugins.map((_, index) => `/opt/dcc-plugin-${index}`),
    executable: executableInNodeRoot
      ? path.join("/opt/node", path.relative(nodeRoot, executable))
      : "/opt/dcc-claude",
  };
  const configuredInput: ExecutionInvocation = {
    ...input,
    promptFile: virtual.promptFile,
    skillBundleDir: skillBundleDir ? virtual.skillBundleDir : undefined,
    pluginDirectories: virtual.pluginDirectories,
    guardPath: virtual.guardPath,
    allowedWritePaths: writePaths,
  };
  const args = [
    "--die-with-parent", "--new-session", "--unshare-pid", "--unshare-ipc", "--unshare-uts",
    "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin",
    "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
    "--proc", "/proc", "--dev", "/dev", "--dir", "/opt", "--dir", "/opt/node",
    "--ro-bind", nodeRoot, "/opt/node", "--tmpfs", "/tmp", "--dir", "/tmp/claude",
    ...bwrapParentDirectories(worktree), "--ro-bind", worktree, worktree,
    ...writePaths.flatMap((target) => ["--bind", target, target]),
    "--ro-bind", settingsDirectory, virtual.settingsDirectory,
    "--ro-bind", guardPath, virtual.guardPath,
    "--ro-bind", promptFile, virtual.promptFile,
    ...(skillBundleDir ? ["--ro-bind", skillBundleDir, virtual.skillBundleDir] : []),
    ...plugins.flatMap((directory, index) => ["--ro-bind", directory, virtual.pluginDirectories[index]]),
    ...(executableInNodeRoot ? [] : ["--ro-bind", executable, virtual.executable]),
    "--setenv", "CLAUDE_CONFIG_DIR", "/tmp/claude", "--setenv", "PATH", "/opt/node/bin:/usr/bin:/bin",
    "--chdir", worktree, "--",
  ];
  return {
    bwrap, args, configuredInput, executable: virtual.executable, settingsFile: virtual.settingsFile,
    env: { PATH: process.env.PATH },
  };
}

async function gitMetadataPaths(workingDirectory: string) {
  const dotGit = path.join(workingDirectory, ".git");
  let gitDirectory = dotGit;
  const pointer = await readFile(dotGit, "utf8").catch(() => "");
  const match = pointer.match(/^gitdir:\s*(.+)\s*$/m);
  if (match) gitDirectory = path.resolve(workingDirectory, match[1]);
  const common = await readFile(path.join(gitDirectory, "commondir"), "utf8").catch(() => "");
  return [...new Set([dotGit, gitDirectory, ...(common.trim() ? [path.resolve(gitDirectory, common.trim())] : [])])];
}

async function hideWorktreeGitMetadata(workingDirectory: string) {
  const dotGit = path.join(workingDirectory, ".git");
  const hidden = path.join(path.dirname(workingDirectory), `.dcc-git-metadata-${randomUUID()}`);
  try {
    await rename(dotGit, hidden);
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  return {
    hidden,
    restore: async () => { await rename(hidden, dotGit); },
  };
}

function executionSettings(input: ExecutionInvocation, guardPath: string) {
  const gitMetadataPaths = [...new Set(input.gitMetadataPaths ?? [path.join(input.workingDirectory, ".git")])];
  const deniedGitPaths = gitMetadataPaths.flatMap((target) => {
    const rulePath = permissionPath(target);
    return [`Read(${rulePath})`, `Read(${rulePath}/**)`, `Edit(${rulePath})`, `Edit(${rulePath}/**)`];
  });
  const deniedCredentialReads = sensitiveHomePaths.flatMap((target) => [
    `Read(${target})`, `Read(${target}/**)`,
  ]);
  const hostHome = permissionPath(homedir());
  const deniedHostHome = [
    `Read(${hostHome})`, `Read(${hostHome}/**)`, `Edit(${hostHome})`, `Edit(${hostHome}/**)`,
  ];
  const nodeInstallRoot = path.dirname(path.dirname(process.execPath));
  const allowRead = [
    input.workingDirectory, input.skillBundleDir, ...(input.pluginDirectories ?? []), input.promptFile,
    guardPath, nodeInstallRoot, process.env.COREPACK_HOME, path.join(homedir(), ".cache", "node", "corepack"),
  ].filter((target): target is string => Boolean(target)).map((target) => path.resolve(input.workingDirectory, target));
  let worktree: string;
  try { worktree = realpathSync(input.workingDirectory); } catch { worktree = path.resolve(input.workingDirectory); }
  const homeRelative = path.relative(homedir(), worktree);
  if (homeRelative === "" || (!homeRelative.startsWith(`..${path.sep}`) && homeRelative !== ".." && !path.isAbsolute(homeRelative))) {
    throw new Error("execution worktree must be outside the host home so deny rules cannot override its edit allowlist");
  }
  const allowedPermissions = [...new Set(allowRead)].flatMap((target) => {
    const rulePath = permissionPath(target);
    return [`Read(${rulePath})`, `Read(${rulePath}/**)`];
  });
  const worktreeRule = permissionPath(worktree);
  const writePaths = scopedWritePaths(input, worktree);
  const writePermissions = writePaths
    ? [...new Set(writePaths)].map((target) => `Edit(${permissionPath(target)})`)
    : [`Edit(${worktreeRule})`, `Edit(${worktreeRule}/**)`];
  return JSON.stringify({
    permissions: {
      allow: [...allowedPermissions, ...writePermissions],
      deny: [...deniedHostHome, ...deniedGitPaths, ...deniedCredentialReads, "WebFetch"],
    },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      filesystem: {
        denyRead: [...new Set([homedir(), ...gitMetadataPaths])],
        allowRead: [...new Set(allowRead)],
        ...(writePaths ? { allowWrite: [...new Set(writePaths)] } : {}),
        denyWrite: gitMetadataPaths,
      },
      credentials: {
        files: sensitiveHomePaths.map((file) => ({ path: file, mode: "deny" })),
        envVars: [...new Set(input.sensitiveEnvironmentVariables ?? defaultSensitiveEnvironmentVariables)]
          .sort().map((name) => ({ name, mode: "deny" })),
      },
      network: {
        allowedDomains: [], deniedDomains: ["*"], strictAllowlist: true, allowAllUnixSockets: false,
      },
    },
    hooks: {
      PreToolUse: [
        {
          matcher: "Read|Glob|Grep|Edit|Write",
          hooks: [{ type: "command", command: fileHookCommand(guardPath, [...new Set(allowRead)], worktree, writePaths) }],
        },
        {
          matcher: "Agent",
          hooks: [{ type: "command", command: hookCommand(guardPath) }],
        },
      ],
    },
  });
}

export function buildPlanningArguments(input: PlanningInvocation) {
  return [
    "-p", input.task, "--session-id", input.sessionId, "--model", input.model, "--effort", input.effort,
    // ponytail: --permission-mode plan expects the agent to conclude by
    // calling ExitPlanMode, which isn't available in headless -p mode —
    // the agent then wrote a stray local file instead of the plan markdown.
    // "manual" denied every Bash call in headless -p (no interactive
    // approver), so planning burned its turns on denied read-only commands.
    // "dontAsk" auto-allows read-only Bash and denies everything else —
    // read-only planning whose tools actually work.
    // Bash itself is no longer in the default list at all: a denied Bash
    // call under dontAsk has no escalation path, so the agent just retries
    // until --max-turns is exhausted (see DCC-1014, three identical
    // failures on 2026-08-07). Read/Glob/Grep cover everything planning's
    // prompt actually asks for; PR review dropped Bash the same way in
    // docs/superpowers/plans/2026-07-31-pr-ai-review-reliability.md.
    "--permission-mode", "dontAsk", "--tools", input.tools?.join(",") ?? "Read,Glob,Grep,Skill",
    "--append-system-prompt-file", input.promptFile, ...skillDirectoryArguments(input),
    "--output-format", "json", "--max-turns", String(input.maxTurns),
  ];
}

export function summarizeClaudeFailure(stdout: string, stderr: string) {
  let detail = stderr.trim();
  let bashDenied = /bash.*(?:denied|not allowed|not permitted)|(?:denied|not allowed|not permitted).*bash/i.test(detail);
  if (!detail) {
    try {
      const response = JSON.parse(stdout.trim());
      const errors = response?.errors;
      detail = typeof errors === "string" ? errors : Array.isArray(errors) ? errors.filter((error) => typeof error === "string").join(" ") : "";
      bashDenied ||= Array.isArray(response?.permission_denials) && response.permission_denials.some((denial: any) => denial?.tool_name === "Bash");
    } catch { /* use the generic message below */ }
  }
  return `${detail || "Claude planning failed."}${bashDenied ? " Bash access was denied; the review did not complete." : ""}`;
}

// Truncated so a runaway/verbose CLI failure can't blow up
// agent_runs.metadata_json, while keeping both ends: real
// `--output-format json` payloads put the model's partial `result` text
// before `permission_denials`/`errors`, so a head-only truncation discards
// the exact diagnostic payload this capture exists to preserve.
export function truncateStdoutForCapture(stdout: string) {
  return stdout.length > 4000 ? `${stdout.slice(0, 1500)}\n…truncated…\n${stdout.slice(-2500)}` : stdout;
}

export async function invokePlanningClaude(input: PlanningInvocation) {
  assertSubscriptionOnlyEnvironment();
  // Planning receives only locale/PATH, its subscription token, and runner
  // switches. Worker credentials must never cross this process boundary.
  const env = minimalClaudeEnvironment(process.env, input.oauthToken);
  if (input.scenarioPath && process.env.NODE_ENV !== "production") env.MOCK_CLAUDE_SCENARIO = input.scenarioPath;
  const result = await runClaude(buildPlanningArguments(input), {
    cwd: input.workingDirectory, env, executable: input.claudeExecutable, signal: input.signal, timeoutMs: input.timeoutMs,
  });
  if (result.timedOut) throw new ClaudePlanningError("Claude planning timed out", 124, "planning_timeout");
  if (result.exitCode !== 0) {
    throw Object.assign(new Error(summarizeClaudeFailure(result.stdout, result.stderr)), {
      exitCode: result.exitCode,
      stdout: truncateStdoutForCapture(result.stdout),
    });
  }
  let response: any;
  try { response = JSON.parse(result.stdout.trim()); } catch {
    throw Object.assign(new Error("Claude planning returned invalid JSON"), { stdout: truncateStdoutForCapture(result.stdout) });
  }
  if (response?.type !== "result" || response?.subtype !== "success" || typeof response?.result !== "string") {
    throw Object.assign(new Error("Claude planning response did not contain a successful Markdown result"), { stdout: truncateStdoutForCapture(result.stdout) });
  }
  return {
    markdown: response.result as string,
    sessionId: typeof response.session_id === "string" ? response.session_id : input.sessionId,
    exitCode: Number(response.exit_code ?? result.exitCode ?? 0),
    raw: response,
  };
}

export type ExecutionInvocation = PlanningInvocation & {
  executionDirectory: string;
  logPath: string;
  timeoutMs: number;
  signal?: AbortSignal;
  onEvent: (event: { eventType: string; event: unknown; raw: string }) => Promise<void>;
  allowedWritePaths?: readonly string[];
};

export function assertExecutionSandboxVersion(value: string) {
  if (!isClaudeSandboxVersionSupported(value)) {
    throw new Error("execution requires Claude Code 2.1.219 or newer for fail-closed strict sandboxing");
  }
}

export async function createExecutionSandboxSettings(input: ExecutionInvocation, directory: string) {
  const settingsFile = path.join(directory, "settings.json");
  await writeFile(settingsFile, executionSettings(input, input.guardPath ?? trustedBashGuard), { encoding: "utf8", flag: "wx" });
  return { settingsFile };
}

export function buildExecutionArguments(input: ExecutionInvocation, settingsFile: string) {
  return [
    "-p", input.task, "--session-id", input.sessionId, "--model", input.model, "--effort", input.effort,
    "--permission-mode", "dontAsk", "--tools", "Read,Glob,Grep,Skill,Agent",
    "--append-system-prompt-file", input.promptFile, ...skillDirectoryArguments(input),
    "--setting-sources", "", "--strict-mcp-config", "--settings", settingsFile,
    "--agents", sessionAgents(input),
    "--output-format", "stream-json", "--verbose", "--max-turns", String(input.maxTurns),
  ];
}

export function isClaudeSandboxVersionSupported(output: string) {
  const match = output.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return major > 2 || (major === 2 && (minor > 1 || (minor === 1 && patch >= 219)));
}

async function requireClaudeSandboxVersion(
  env: NodeJS.ProcessEnv, cwd: string, executable?: string,
  launch?: { bwrap: string; args: string[]; executable: string },
) {
  const result = await runClaude(
    launch ? [...launch.args, launch.executable, "--version", "--setting-sources", ""] : ["--version", "--setting-sources", ""],
    { cwd, env, executable: launch?.bwrap ?? executable },
  );
  if (result.exitCode !== 0) throw new Error("could not verify Claude Code sandbox support");
  assertExecutionSandboxVersion(result.stdout);
}

export async function invokeExecutionClaude(input: ExecutionInvocation) {
  assertSubscriptionOnlyEnvironment();
  if (input.executionDirectory !== input.workingDirectory) {
    throw new Error("executionDirectory must match workingDirectory");
  }
  const settingsDirectory = await mkdtemp(path.join(tmpdir(), "dcc-claude-settings-"));
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    CLAUDE_CODE_OAUTH_TOKEN: input.oauthToken,
    CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    CLAUDE_CONFIG_DIR: settingsDirectory,
    AGENT_CONTROL_DISABLE: "1",
  };
  if (input.scenarioPath && process.env.NODE_ENV !== "production") env.MOCK_CLAUDE_SCENARIO = input.scenarioPath;
  const guard = await materializeBashGuard();
  let hiddenGitMetadata: Awaited<ReturnType<typeof hideWorktreeGitMetadata>> = null;
  try {
    await appendFile(input.logPath, "");
    const metadataPaths = input.gitMetadataPaths ?? await gitMetadataPaths(input.workingDirectory);
    hiddenGitMetadata = await hideWorktreeGitMetadata(input.workingDirectory);
    const configuredInput = {
      ...input,
      guardPath: guard.path,
      gitMetadataPaths: [...metadataPaths, ...(hiddenGitMetadata ? [hiddenGitMetadata.hidden] : [])],
    };
    const scoped = input.allowedWritePaths !== undefined;
    const launch = scoped ? scopedBwrapLaunch(configuredInput, settingsDirectory, guard.path) : null;
    const sandboxInput = launch?.configuredInput ?? configuredInput;
    const { settingsFile } = await createExecutionSandboxSettings(sandboxInput, settingsDirectory);
    const command = launch?.bwrap ?? (input.claudeExecutable ?? "claude");
    const commandArgs = launch
      ? [...launch.args, launch.executable, ...buildExecutionArguments(sandboxInput, launch.settingsFile)]
      : buildExecutionArguments(sandboxInput, settingsFile);
    const childEnv = launch ? { ...env, ...launch.env } : env;
    await requireClaudeSandboxVersion(childEnv, input.workingDirectory, input.claudeExecutable, launch ?? undefined);
    return await new Promise<{ exitCode: number; stderr: string }>((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: input.workingDirectory,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let pending = "";
    let stderr = "";
    let eventWrites = Promise.resolve();
    let logWrites = Promise.resolve();
    const appendLog = (text: string) => {
      logWrites = logWrites.then(() => appendFile(input.logPath, text));
    };
    let terminationTimer: NodeJS.Timeout | undefined;
    let outcome: "running" | "timeout" | "cancelled" = "running";
    const stop = (reason: "timeout" | "cancelled") => {
      if (outcome !== "running") return;
      outcome = reason;
      child.kill("SIGTERM");
      terminationTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
    };
    const timeout = setTimeout(() => stop("timeout"), input.timeoutMs);
    const abort = () => stop("cancelled");
    input.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      appendLog(text);
      pending += text;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const raw of lines) {
        if (!raw.trim()) continue;
        eventWrites = eventWrites.then(async () => {
          let event: any;
          try { event = JSON.parse(raw); } catch { event = { type: "unparsed", text: raw }; }
          await input.onEvent({ eventType: String(event?.type ?? "event"), event, raw });
        });
        void eventWrites.catch(() => undefined);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr += text;
      appendLog(text);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (terminationTimer) clearTimeout(terminationTimer);
      input.signal?.removeEventListener("abort", abort);
      Promise.all([eventWrites, logWrites]).then(() => {
        if (outcome === "cancelled") {
          reject(new ClaudeExecutionError("Claude execution was cancelled", code ?? 1, "execution_cancelled"));
        } else if (outcome === "timeout" || code === 124) {
          reject(new ClaudeExecutionError("Claude execution timed out", 124, "execution_timeout"));
        } else if (code !== 0) {
          reject(new ClaudeExecutionError(
            `Claude execution exited ${code}: ${stderr.trim() || "no error output"}`,
            code ?? 1,
            "execution_failed",
          ));
        } else {
          resolve({ exitCode: code ?? 0, stderr });
        }
      }, reject);
    });
  });
  } finally {
    try {
      await hiddenGitMetadata?.restore();
    } finally {
      try {
        await guard.cleanup();
      } finally {
        await rm(settingsDirectory, { recursive: true, force: true });
      }
    }
  }
}

const requiredPlanSections = [
  "Implementation Plan", "Summary", "Problem Definition", "Current Behaviour", "Expected Behaviour",
  "Relevant Architecture", "Relevant Files", "Proposed Changes", "Implementation Steps",
  "Database or Migration Changes", "Testing Strategy", "Security Considerations",
  "Performance Considerations", "Risks and Edge Cases", "Rollback Strategy",
  "Acceptance Criteria Mapping", "Out of Scope", "Open Questions",
] as const;

export function parsePlanMarkdown(markdown: string) {
  const normalize = (heading: string) => heading.toLowerCase()
    .replace(/^\s*\d+\s*(?:[^\p{L}\p{N}\s]+)?\s*/u, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const headings = markdown.split(/\r?\n/)
    .map((line) => line.trim().match(/^#{1,6}\s+(.+?)\s*#*\s*$/)?.[1])
    .filter((heading): heading is string => Boolean(heading))
    .map(normalize);
  const counts = requiredPlanSections.map((section) => headings.filter((heading) => {
    const normalized = normalize(section);
    return heading === normalized || heading.startsWith(`${normalized} `);
  }).length);
  const missing = requiredPlanSections.filter((_, index) => counts[index] === 0);
  const duplicates = requiredPlanSections.filter((_, index) => counts[index] > 1);
  if (missing.length || duplicates.length) {
    const problems = [
      missing.length && `missing sections: ${missing.join(", ")}`,
      duplicates.length && `duplicate sections: ${duplicates.join(", ")}`,
    ].filter(Boolean).join("; ");
    throw new Error(`invalid_plan_structure: ${problems}`);
  }
  return markdown.endsWith("\n") ? markdown : `${markdown}\n`;
}
