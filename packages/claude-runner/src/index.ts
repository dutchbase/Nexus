import { spawn } from "node:child_process";
import { appendFile, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertSubscriptionOnlyEnvironment, ClaudeAuthError } from "./auth-guard.ts";
export { assertSubscriptionOnlyEnvironment, ClaudeAuthError, forbiddenClaudeAuthVariables } from "./auth-guard.ts";

async function runClaude(args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "dcc-claude-output-"));
  const stdoutPath = path.join(directory, "stdout");
  const stderrPath = path.join(directory, "stderr");
  const stdoutFile = await open(stdoutPath, "wx");
  const stderrFile = await open(stderrPath, "wx");
  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const child = spawn("claude", args, {
        cwd: options.cwd, env: options.env, stdio: ["ignore", stdoutFile.fd, stderrFile.fd],
      });
      child.on("error", reject);
      child.on("close", resolve);
    });
    await stdoutFile.close();
    await stderrFile.close();
    return {
      stdout: await readFile(stdoutPath, "utf8"),
      stderr: await readFile(stderrPath, "utf8"),
      exitCode,
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

export async function preflightClaudeAuthentication(env: NodeJS.ProcessEnv = process.env) {
  assertSubscriptionOnlyEnvironment(env);
  const result = await runClaude(["auth", "status"], { env });
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
  skillBundleDir: string; workingDirectory: string; maxTurns: number; oauthToken: string; scenarioPath?: string; tools?: string[];
};

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
    "--permission-mode", "dontAsk", "--tools", input.tools?.join(",") ?? "Read,Glob,Grep,Bash",
    "--append-system-prompt-file", input.promptFile, "--add-dir", input.skillBundleDir,
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

export async function invokePlanningClaude(input: PlanningInvocation) {
  assertSubscriptionOnlyEnvironment();
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: input.oauthToken, AGENT_CONTROL_DISABLE: "1" };
  if (input.scenarioPath && process.env.NODE_ENV !== "production") env.MOCK_CLAUDE_SCENARIO = input.scenarioPath;
  const result = await runClaude(buildPlanningArguments(input), { cwd: input.workingDirectory, env });
  if (result.exitCode !== 0) {
    throw Object.assign(new Error(summarizeClaudeFailure(result.stdout, result.stderr)), { exitCode: result.exitCode });
  }
  let response: any;
  try { response = JSON.parse(result.stdout.trim()); } catch { throw new Error("Claude planning returned invalid JSON"); }
  if (response?.type !== "result" || response?.subtype !== "success" || typeof response?.result !== "string") {
    throw new Error("Claude planning response did not contain a successful Markdown result");
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
};

export async function createExecutionSandboxSettings(input: ExecutionInvocation, directory: string) {
  const settingsFile = path.join(directory, "settings.json");
  const executionDirectory = input.executionDirectory;
  await writeFile(settingsFile, JSON.stringify({
    disableAllHooks: true,
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      filesystem: {
        allowWrite: [executionDirectory],
        denyRead: ["/"],
        allowRead: [executionDirectory],
      },
      credentials: {
        envVars: [
          { name: "GITHUB_TOKEN", mode: "deny" },
          { name: "GH_TOKEN", mode: "deny" },
          { name: "DATABASE_URL", mode: "deny" },
          { name: "CLAUDE_CODE_OAUTH_TOKEN", mode: "deny" },
        ],
      },
      network: { allowedDomains: ["api.anthropic.com"], strictAllowlist: true },
    },
  }), { encoding: "utf8", flag: "wx" });
  return { settingsFile };
}

export function buildExecutionArguments(input: ExecutionInvocation, settingsFile: string) {
  return [
    "-p", input.task, "--session-id", input.sessionId, "--model", input.model, "--effort", input.effort,
    "--permission-mode", "auto", "--tools", "Bash,Agent,Skill",
    "--disallowedTools", "Read,Glob,Grep,Edit,Write,Bash(git push *),Bash(git merge *),Bash(git reset *),Bash(git commit --amend *),Bash(git rebase *),Bash(git checkout *),Bash(git switch *),Bash(gh *),Bash(sudo *),Bash(rm -rf /),Bash(rm -rf ~)",
    "--setting-sources", "", "--strict-mcp-config",
    "--append-system-prompt-file", input.promptFile, "--add-dir", input.skillBundleDir,
    "--settings", settingsFile,
    "--output-format", "stream-json", "--verbose", "--max-turns", String(input.maxTurns),
  ];
}

export function isClaudeSandboxVersionSupported(output: string) {
  const match = output.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return major > 2 || (major === 2 && (minor > 1 || (minor === 1 && patch >= 219)));
}

async function requireClaudeSandboxVersion(env: NodeJS.ProcessEnv, cwd: string) {
  const result = await runClaude(["--version", "--setting-sources", ""], { cwd, env });
  if (result.exitCode !== 0 || !isClaudeSandboxVersionSupported(result.stdout)) {
    throw new Error("Claude Code 2.1.219 or newer is required for strict sandbox execution");
  }
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
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    CLAUDE_CONFIG_DIR: settingsDirectory,
    AGENT_CONTROL_DISABLE: "1",
  };
  if (input.scenarioPath && process.env.NODE_ENV !== "production") env.MOCK_CLAUDE_SCENARIO = input.scenarioPath;
  try {
    await requireClaudeSandboxVersion(env, input.workingDirectory);
    const { settingsFile } = await createExecutionSandboxSettings(input, settingsDirectory);
    await appendFile(input.logPath, "");
    return await new Promise<{ exitCode: number; stderr: string }>((resolve, reject) => {
    const child = spawn("claude", buildExecutionArguments(input, settingsFile), {
      cwd: input.workingDirectory,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let pending = "";
    let stderr = "";
    let eventWrites = Promise.resolve();
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
      void appendFile(input.logPath, text);
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
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr += text;
      void appendFile(input.logPath, text);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (terminationTimer) clearTimeout(terminationTimer);
      input.signal?.removeEventListener("abort", abort);
      eventWrites.then(() => {
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
    await rm(settingsDirectory, { recursive: true, force: true });
  }
}

const requiredPlanHeadings = [
  "# Implementation Plan", "## 1. Summary", "## 2. Problem Definition", "## 3. Current Behaviour",
  "## 4. Expected Behaviour", "## 5. Relevant Architecture", "## 6. Relevant Files",
  "## 7. Proposed Changes", "## 8. Implementation Steps", "## 9. Database or Migration Changes",
  "## 10. Testing Strategy", "## 11. Security Considerations", "## 12. Performance Considerations",
  "## 13. Risks and Edge Cases", "## 14. Rollback Strategy", "## 15. Acceptance Criteria Mapping",
  "## 16. Out of Scope", "## 17. Open Questions",
] as const;

export function parsePlanMarkdown(markdown: string) {
  const headings = markdown.split(/\r?\n/).filter((line) => /^#{1,2} /.test(line.trim())).map((line) => line.trim());
  const mismatchIndex = headings.length !== requiredPlanHeadings.length
    ? Math.min(headings.length, requiredPlanHeadings.length)
    // ponytail: startsWith, not ===, so a heading like "# Implementation
    // Plan — DCC-1001: ..." (model adds a descriptive suffix) still counts —
    // only order/count/prefix are structural, trailing text is harmless.
    : requiredPlanHeadings.findIndex((heading, index) => !headings[index]?.startsWith(heading));
  if (mismatchIndex !== -1) {
    // ponytail: name the actual mismatch instead of a generic message, so a
    // failed run is diagnosable without re-running the (costly) CLI call.
    throw new Error(
      `invalid_plan_structure: expected the complete ordered 17-section implementation plan ` +
      `(got ${headings.length} headings, expected ${requiredPlanHeadings.length}; ` +
      `first mismatch at position ${mismatchIndex + 1}: expected "${requiredPlanHeadings[mismatchIndex] ?? "<end>"}", ` +
      `got "${headings[mismatchIndex] ?? "<end>"}")`,
    );
  }
  return markdown.endsWith("\n") ? markdown : `${markdown}\n`;
}
