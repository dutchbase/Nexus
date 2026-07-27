export const forbiddenClaudeAuthVariables = [
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
] as const;

export class ClaudeAuthError extends Error {
  code: "blocked_auth_configuration" | "blocked_auth";

  constructor(code: "blocked_auth_configuration" | "blocked_auth", message: string) {
    super(message);
    this.code = code;
  }
}

export function assertSubscriptionOnlyEnvironment(env: NodeJS.ProcessEnv = process.env) {
  const offending = forbiddenClaudeAuthVariables.find((name) => Boolean(env[name]));
  if (offending) {
    throw new ClaudeAuthError(
      "blocked_auth_configuration",
      `blocked_auth_configuration: forbidden Claude authentication variable ${offending} is set`,
    );
  }
}
