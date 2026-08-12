// Must never reach the spawned `claude` CLI: any of these silently switches it
// off subscription auth onto metered/API or a cloud provider.
export const forbiddenClaudeAuthVariables = [
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
] as const;

// ANTHROPIC_API_KEY is a legitimate *worker* credential (metered Messages API
// for text-only jobs, see packages/anthropic-runner). It stays on the list
// above because the claude CLI must never see it.
export const forbiddenWorkerAuthVariables =
  forbiddenClaudeAuthVariables.filter((name) => name !== "ANTHROPIC_API_KEY");

export class ClaudeAuthError extends Error {
  code: "blocked_auth_configuration" | "blocked_auth";

  constructor(code: "blocked_auth_configuration" | "blocked_auth", message: string) {
    super(message);
    this.code = code;
  }
}

export function assertSubscriptionOnlyEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  const offending = forbiddenWorkerAuthVariables.find((name) => Boolean(env[name]));
  if (offending) {
    throw new ClaudeAuthError(
      "blocked_auth_configuration",
      `blocked_auth_configuration: ${offending} is set; the worker must use subscription auth for Claude CLI jobs`,
    );
  }
}

// Spawn-boundary invariant: runs against the *constructed child env*, not
// process.env. The worker process may legitimately hold ANTHROPIC_API_KEY
// (metered Messages API for text-only jobs); this assertion is what
// guarantees it never crosses into the spawned `claude` CLI's environment.
export function assertSubscriptionOnlyChildEnvironment(env: NodeJS.ProcessEnv): void {
  const offending = forbiddenClaudeAuthVariables.find((name) => Boolean(env[name]));
  if (offending) {
    throw new ClaudeAuthError(
      "blocked_auth_configuration",
      `blocked_auth_configuration: ${offending} reached the Claude CLI environment`,
    );
  }
}
