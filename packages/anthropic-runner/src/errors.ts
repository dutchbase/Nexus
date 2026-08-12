import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  UnprocessableEntityError,
} from "@anthropic-ai/sdk";
import type { AiUsage } from "@dcc/domain";

export type AnthropicRunnerErrorCode =
  | "anthropic_auth"
  | "anthropic_invalid_request"
  | "anthropic_rate_limited"
  | "anthropic_overloaded"
  | "anthropic_connection"
  | "anthropic_timeout"
  | "anthropic_cancelled"
  | "anthropic_refusal"
  | "anthropic_empty_response"
  | "anthropic_failed";

export class AnthropicRunnerError extends Error {
  constructor(
    message: string,
    public code: AnthropicRunnerErrorCode,
    public status?: number,
    public usage?: AiUsage,
    public requestId?: string,
  ) {
    super(message);
  }
}

export const retryableAnthropicCodes: readonly AnthropicRunnerErrorCode[] = [
  "anthropic_rate_limited", "anthropic_overloaded", "anthropic_connection", "anthropic_timeout",
];

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requestIdOf(error: unknown): string | undefined {
  const requestId = (error as { requestID?: string | null } | undefined)?.requestID;
  return requestId ?? undefined;
}

function statusOf(error: unknown): number | undefined {
  return (error as { status?: number } | undefined)?.status;
}

// Branches on the SDK's typed error classes via instanceof — never on
// error message strings. Order matters: subclasses must be checked before
// their base classes (APIUserAbortError and APIConnectionTimeoutError both
// extend APIError; APIConnectionTimeoutError extends APIConnectionError).
//
// Deviation from the brief's guessed mapping: the brief's table had no entry
// for APIUserAbortError. invokeAnthropicText (index.ts) passes the SDK BOTH
// a `signal` (our own AbortSignal.any([hardDeadline, callerSignal])) and a
// `timeout` request option. When the *signal* aborts — whether that's our
// own hard deadline firing or the caller's own signal firing — the SDK's
// request loop checks `options.signal?.aborted` and throws
// `APIUserAbortError` (see node_modules/@anthropic-ai/sdk/client.js
// `makeRequest`), NOT `APIConnectionTimeoutError`. `APIConnectionTimeoutError`
// is reserved for the SDK's own internal per-attempt `timeout` option
// exhausting its retries via a native fetch timeout. Both cases are
// "the call was aborted or ran out of time" from our side, so both use the
// same `signalAborted ? anthropic_cancelled : anthropic_timeout` split.
export function mapAnthropicError(error: unknown, signalAborted: boolean, usage?: AiUsage): AnthropicRunnerError {
  const status = statusOf(error);
  const requestId = requestIdOf(error);
  const build = (code: AnthropicRunnerErrorCode) => new AnthropicRunnerError(messageOf(error), code, status, usage, requestId);

  if (error instanceof AuthenticationError || error instanceof PermissionDeniedError) return build("anthropic_auth");
  if (error instanceof NotFoundError || error instanceof BadRequestError || error instanceof UnprocessableEntityError) {
    return build("anthropic_invalid_request");
  }
  if (error instanceof RateLimitError) return build("anthropic_rate_limited");
  if (error instanceof InternalServerError) return build("anthropic_overloaded");
  if (error instanceof APIUserAbortError) return build(signalAborted ? "anthropic_cancelled" : "anthropic_timeout");
  if (error instanceof APIConnectionTimeoutError) return build(signalAborted ? "anthropic_cancelled" : "anthropic_timeout");
  if (error instanceof APIConnectionError) return build("anthropic_connection");
  if (error instanceof APIError) return build("anthropic_failed");
  if (signalAborted) return build("anthropic_cancelled");
  return build("anthropic_failed");
}
