import type { ReasoningLevel } from "@dcc/domain";

export type AnthropicModelSpec = {
  readonly id: string;
  // claude-haiku-4-5 rejects output_config.effort with a 400 (older-model
  // family; no effort ladder). The 5-series (fable/opus/sonnet) all accept it.
  readonly supportsEffort: boolean;
};

// Repo shorthand -> Anthropic Messages API model id. These are the exact
// strings the previous engineer already used to seed ai_model_prices in
// packages/database/migrations/050_ai_invocation_accounting.sql (see the
// drift-guard test in models.test.ts) and match the currently cached model
// catalog — but this session has no way to hit a live /v1/models endpoint,
// so treat the literal id strings as unverified against Anthropic's servers.
const specs: Record<string, AnthropicModelSpec | undefined> = {
  fable: { id: "claude-fable-5", supportsEffort: true },
  opus: { id: "claude-opus-5", supportsEffort: true },
  sonnet: { id: "claude-sonnet-5", supportsEffort: true },
  haiku: { id: "claude-haiku-4-5", supportsEffort: false },
};

export class UnsupportedAnthropicModelError extends Error {
  readonly code = "unsupported_model" as const;
}

export function anthropicModelSpec(model: string): AnthropicModelSpec {
  const spec = specs[model];
  if (!spec) throw new UnsupportedAnthropicModelError(`model "${model}" has no Anthropic API mapping`);
  return spec;
}

// The installed @anthropic-ai/sdk (0.116.0) types output_config.effort as
// 'low' | 'medium' | 'high' | 'xhigh' | 'max' — the brief's sketch omitted
// "xhigh", which is a real, currently-typed effort level (and one
// @dcc/domain's reasoningLevels/supportedReasoning table already grants to
// sonnet/opus/fable), so it's included here. "ultracode" is a
// @dcc/domain ReasoningLevel used only by the OpenCode/DeepSeek transport
// (see packages/domain/src/index.ts) and is not a valid Anthropic API effort
// value, so it's deliberately excluded.
export type AnthropicEffort = Exclude<ReasoningLevel, "ultracode">;
const supportedEffortLevels: readonly AnthropicEffort[] = ["low", "medium", "high", "xhigh", "max"];

export function effortFor(spec: AnthropicModelSpec, level: string): AnthropicEffort | null {
  return spec.supportsEffort && (supportedEffortLevels as readonly string[]).includes(level)
    ? (level as AnthropicEffort)
    : null;
}
