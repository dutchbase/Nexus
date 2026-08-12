import Anthropic from "@anthropic-ai/sdk";
import type { AiUsage } from "@dcc/domain";
import { AnthropicRunnerError, mapAnthropicError } from "./errors.ts";
import { anthropicModelSpec, effortFor } from "./models.ts";
import { parseAnthropicUsage } from "./usage.ts";

export type AnthropicTextInvocation = {
  task: string; // single user turn (was the CLI's `-p`)
  systemPrompt: string; // rendered prompt (was --append-system-prompt-file)
  model: string; // repo shorthand: "fable" | "opus" | "sonnet" | "haiku"
  effort: string;
  maxTokens?: number; // default 4096
  apiKey: string;
  signal?: AbortSignal;
  timeoutMs?: number; // default 120_000
  maxRetries?: number; // default 2 (SDK built-in; job queue retries on top — keep low)
  baseUrl?: string; // e2e mock
  client?: Pick<Anthropic, "messages">; // test seam — never set in production
};

export type AnthropicTextResult = {
  markdown: string;
  sessionId: string; // response.id -> agent_runs.claude_session_id
  exitCode: number; // always 0 on success; keeps worker call sites uniform
  stopReason: string | null;
  raw: unknown;
  usage?: AiUsage;
};

export async function invokeAnthropicText(input: AnthropicTextInvocation): Promise<AnthropicTextResult> {
  const spec = anthropicModelSpec(input.model);
  const effort = effortFor(spec, input.effort);
  const timeoutMs = input.timeoutMs ?? 120_000;
  const client: Pick<Anthropic, "messages"> = input.client ?? new Anthropic({
    apiKey: input.apiKey,
    maxRetries: input.maxRetries ?? 2,
    ...(input.baseUrl ? { baseURL: input.baseUrl } : {}),
  });
  // Hard outer bound across every SDK-internal retry attempt. `timeout`
  // below is the SDK's own per-attempt timeout (retried per maxRetries);
  // this AbortSignal.timeout is the ceiling on total wall-clock time
  // regardless of how many attempts the SDK makes.
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = AbortSignal.any([deadline, ...(input.signal ? [input.signal] : [])]);

  let message: Anthropic.Message;
  try {
    message = await client.messages.create(
      {
        model: spec.id,
        max_tokens: input.maxTokens ?? 4096,
        system: input.systemPrompt,
        messages: [{ role: "user", content: input.task }],
        // claude-haiku-4-5 rejects output_config.effort with a 400 (regression
        // guard: see models.ts's supportsEffort=false for haiku, and the
        // "request shape haiku" test in index.test.ts) — omit the field
        // entirely rather than sending a null/undefined effort.
        ...(effort ? { output_config: { effort } } : {}),
      },
      { signal, timeout: timeoutMs },
    );
  } catch (error) {
    throw mapAnthropicError(error, Boolean(input.signal?.aborted));
  }

  const usage = parseAnthropicUsage(message.usage) ?? undefined;

  // Safety classifiers return HTTP 200 with stop_reason "refusal" and empty
  // content — touching content[0] first would throw an unmapped TypeError.
  if (message.stop_reason === "refusal") {
    throw new AnthropicRunnerError("Anthropic declined the request", "anthropic_refusal", undefined, usage, message.id);
  }
  const markdown = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
  if (!markdown) {
    throw new AnthropicRunnerError("Anthropic returned no text content", "anthropic_empty_response", undefined, usage, message.id);
  }
  return {
    markdown,
    sessionId: message.id,
    exitCode: 0,
    stopReason: message.stop_reason ?? null,
    raw: message,
    ...(usage ? { usage } : {}),
  };
}

export * from "./models.ts";
export * from "./errors.ts";
export * from "./usage.ts";
