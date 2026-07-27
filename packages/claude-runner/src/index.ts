import { spawn } from "node:child_process";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
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

export async function preflightClaudeAuthentication(env: NodeJS.ProcessEnv = process.env) {
  assertSubscriptionOnlyEnvironment(env);
  const result = await runClaude(["auth", "status"], { env });
  let status: any = null;
  try { status = JSON.parse(result.stdout.trim()); } catch { /* handled below */ }
  if (result.exitCode !== 0 || status?.authenticated !== true || status?.method !== "subscription") {
    throw new ClaudeAuthError("blocked_auth", "blocked_auth: Claude is unauthenticated or is not using subscription authentication");
  }
  return status as { authenticated: true; method: "subscription"; account?: string };
}

export type PlanningInvocation = {
  task: string; sessionId: string; model: string; effort: string; promptFile: string;
  skillBundleDir: string; workingDirectory: string; maxTurns: number; oauthToken: string; scenarioPath?: string;
};

export function buildPlanningArguments(input: PlanningInvocation) {
  return [
    "-p", input.task, "--session-id", input.sessionId, "--model", input.model, "--effort", input.effort,
    "--permission-mode", "plan", "--tools", "Read,Glob,Grep,Bash",
    "--append-system-prompt-file", input.promptFile, "--add-dir", input.skillBundleDir,
    "--output-format", "json", "--max-turns", String(input.maxTurns),
  ];
}

export async function invokePlanningClaude(input: PlanningInvocation) {
  assertSubscriptionOnlyEnvironment();
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: input.oauthToken };
  if (input.scenarioPath && process.env.NODE_ENV !== "production") env.MOCK_CLAUDE_SCENARIO = input.scenarioPath;
  const result = await runClaude(buildPlanningArguments(input), { cwd: input.workingDirectory, env });
  if (result.exitCode !== 0) {
    throw Object.assign(new Error(`Claude planning exited ${result.exitCode}: ${result.stderr.trim() || "no error output"}`), { exitCode: result.exitCode });
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
  if (headings.length !== requiredPlanHeadings.length ||
      requiredPlanHeadings.some((heading, index) => headings[index] !== heading)) {
    throw new Error("invalid_plan_structure: expected the complete ordered 17-section implementation plan");
  }
  return markdown.endsWith("\n") ? markdown : `${markdown}\n`;
}
