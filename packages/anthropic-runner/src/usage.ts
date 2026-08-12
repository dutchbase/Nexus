import type { AiUsage } from "@dcc/domain";

// Same safe-integer validation contract as packages/claude-runner's
// parseClaudeFinalUsage: reject rather than coerce, so a malformed usage
// object surfaces as "usage unavailable" downstream (finalizeAiUsage falls
// through to recordAiUnavailable) instead of persisting garbage numbers.
function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

// The real @anthropic-ai/sdk (0.116.0) types message.usage as:
//   { input_tokens: number; output_tokens: number;
//     cache_creation_input_tokens: number | null; cache_read_input_tokens: number | null; ... }
// — cache_* fields are `number | null` (present but nullable), not optional
// like Claude CLI's usage payload. `null` here means "no cache activity" and
// is treated the same as "absent" (omit the key); any other non-integer
// value is treated as malformed and rejects the whole usage object.
//
// The SDK does also expose `usage.output_tokens_details.thinking_tokens`
// (reasoning tokens folded into output_tokens) — but per the task brief this
// is deliberately never surfaced as `reasoningTokens` here: the Messages API
// counts thinking inside output_tokens, and recordAiUsage() in
// packages/domain coalesces a missing reasoningTokens to 0, satisfying
// migration 050's `reasoning_tokens <= output_tokens` CHECK constraint.
export function parseAnthropicUsage(usage: unknown): AiUsage | null {
  if (!usage || typeof usage !== "object") return null;
  const raw = usage as Record<string, unknown>;
  const inputTokens = tokenCount(raw.input_tokens);
  const outputTokens = tokenCount(raw.output_tokens);
  if (inputTokens === null || outputTokens === null) return null;
  const optional = (value: unknown) => (value === undefined || value === null ? undefined : tokenCount(value));
  const cacheReadTokens = optional(raw.cache_read_input_tokens);
  const cacheWriteTokens = optional(raw.cache_creation_input_tokens);
  if (cacheReadTokens === null || cacheWriteTokens === null) return null;
  return {
    inputTokens,
    outputTokens,
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    rawUsage: usage,
  };
}
