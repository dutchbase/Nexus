import { aiInvocationPhases, type AiInvocationPhase } from "@dcc/domain";

// Which text-only jobs run on the metered Anthropic Messages API instead of
// the subscription-billed Claude CLI. Absent ANTHROPIC_API_KEY => everything
// stays on the CLI, so deploying without config is a no-op.
// DCC_ANTHROPIC_API_JOBS="" is an explicit kill switch (routes nothing, even
// with a key configured).
const defaultApiJobs: readonly AiInvocationPhase[] = ["pr_follow_up_description"];

export function anthropicApiPhases(env: NodeJS.ProcessEnv = process.env): ReadonlySet<AiInvocationPhase> {
  const raw = env.DCC_ANTHROPIC_API_JOBS;
  const names = raw === undefined
    ? [...defaultApiJobs]
    : raw.split(",").map((name) => name.trim()).filter(Boolean);
  const unknown = names.find((name) => !(aiInvocationPhases as readonly string[]).includes(name));
  if (unknown) throw new Error(`DCC_ANTHROPIC_API_JOBS names unknown phase "${unknown}"`);
  return new Set(names as AiInvocationPhase[]);
}

export function usesAnthropicApi(phase: AiInvocationPhase, env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.ANTHROPIC_API_KEY) && anthropicApiPhases(env).has(phase);
}

// Mirrors deepSeekKeyOrThrow() in worker.ts.
export function anthropicKeyOrThrow(env: NodeJS.ProcessEnv = process.env): string {
  const key = env.ANTHROPIC_API_KEY ?? "";
  if (!key) throw new Error("ANTHROPIC_API_KEY is not configured for the worker");
  return key;
}
