import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  UnprocessableEntityError,
} from "@anthropic-ai/sdk";
import { describe, expect, test } from "vitest";
import { AnthropicRunnerError } from "./errors.ts";
import { invokeAnthropicText } from "./index.ts";
import { UnsupportedAnthropicModelError } from "./models.ts";

// Dependency-injection seam, no vi.mock and no real network calls — matches
// how apps/worker/src/opencode.test.ts injects a fake executable instead of
// mocking node:child_process.
const fakeClient = (impl: (params: unknown, options: unknown) => Promise<unknown>) =>
  ({ messages: { create: impl } }) as never;

// A client whose `create` never resolves on its own, but rejects with
// `makeError()` the moment the request options' AbortSignal fires — mirrors
// how the real SDK's fetch call reacts to an aborted signal, without any
// real network I/O.
function abortAwareClient(makeError: () => unknown) {
  return fakeClient(
    (_params, options) =>
      new Promise((_resolve, reject) => {
        const signal = (options as { signal?: AbortSignal } | undefined)?.signal;
        if (signal?.aborted) {
          reject(makeError());
          return;
        }
        signal?.addEventListener("abort", () => reject(makeError()), { once: true });
      }),
  );
}

const baseInvocation = {
  task: "Summarize the diff",
  systemPrompt: "You are a helpful assistant.",
  model: "sonnet",
  effort: "high",
  apiKey: "test-key",
};

function okMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg_default",
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: null, cache_creation_input_tokens: null },
    ...overrides,
  };
}

describe("invokeAnthropicText — happy path", () => {
  test("joins multiple text blocks, sessionId === message.id, exitCode === 0", async () => {
    const usageRaw = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: null, cache_creation_input_tokens: null };
    const client = fakeClient(async () => ({
      id: "msg_123",
      content: [
        { type: "text", text: "Hello " },
        { type: "text", text: "world" },
      ],
      stop_reason: "end_turn",
      usage: usageRaw,
    }));

    const result = await invokeAnthropicText({ ...baseInvocation, client });

    expect(result.markdown).toBe("Hello world");
    expect(result.sessionId).toBe("msg_123");
    expect(result.exitCode).toBe(0);
    expect(result.stopReason).toBe("end_turn");
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5, rawUsage: usageRaw });
  });
});

describe("invokeAnthropicText — request shape", () => {
  test("non-haiku (sonnet/high): sends model, verbatim system, single user turn, output_config.effort", async () => {
    let captured: any;
    const client = fakeClient(async (params) => {
      captured = params;
      return okMessage();
    });

    await invokeAnthropicText({ ...baseInvocation, model: "sonnet", effort: "high", client });

    expect(captured.model).toBe("claude-sonnet-5");
    expect(captured.system).toBe(baseInvocation.systemPrompt);
    expect(captured.messages).toEqual([{ role: "user", content: baseInvocation.task }]);
    expect(captured.output_config).toEqual({ effort: "high" });
  });

  test("haiku: omits output_config entirely (haiku-4-5 rejects it with a 400)", async () => {
    let captured: any;
    const client = fakeClient(async (params) => {
      captured = params;
      return okMessage();
    });

    await invokeAnthropicText({ ...baseInvocation, model: "haiku", effort: "high", client });

    expect(captured.model).toBe("claude-haiku-4-5");
    expect("output_config" in captured).toBe(false);
  });

  test("never sends temperature, top_p, top_k, or thinking", async () => {
    let captured: any;
    const client = fakeClient(async (params) => {
      captured = params;
      return okMessage();
    });

    await invokeAnthropicText({ ...baseInvocation, client });

    for (const removedOnFiveSeries of ["temperature", "top_p", "top_k", "thinking"]) {
      expect(removedOnFiveSeries in captured).toBe(false);
    }
  });

  test("max_tokens defaults to 4096 and can be overridden", async () => {
    let captured: any;
    const client = fakeClient(async (params) => {
      captured = params;
      return okMessage();
    });

    await invokeAnthropicText({ ...baseInvocation, client });
    expect(captured.max_tokens).toBe(4096);

    await invokeAnthropicText({ ...baseInvocation, client, maxTokens: 8192 });
    expect(captured.max_tokens).toBe(8192);
  });
});

describe("invokeAnthropicText — error mapping", () => {
  const noHeaders = new Headers();
  const cases: Array<[string, () => unknown, string]> = [
    ["AuthenticationError", () => new AuthenticationError(401, { type: "authentication_error", message: "bad key" }, "bad key", noHeaders), "anthropic_auth"],
    ["PermissionDeniedError", () => new PermissionDeniedError(403, { type: "permission_error", message: "forbidden" }, "forbidden", noHeaders), "anthropic_auth"],
    ["NotFoundError", () => new NotFoundError(404, { type: "not_found_error", message: "missing model" }, "missing model", noHeaders), "anthropic_invalid_request"],
    ["BadRequestError", () => new BadRequestError(400, { type: "invalid_request_error", message: "bad request" }, "bad request", noHeaders), "anthropic_invalid_request"],
    ["UnprocessableEntityError", () => new UnprocessableEntityError(422, { type: "invalid_request_error", message: "unprocessable" }, "unprocessable", noHeaders), "anthropic_invalid_request"],
    ["RateLimitError", () => new RateLimitError(429, { type: "rate_limit_error", message: "slow down" }, "slow down", noHeaders), "anthropic_rate_limited"],
    ["InternalServerError", () => new InternalServerError(500, { type: "api_error", message: "oops" }, "oops", noHeaders), "anthropic_overloaded"],
    ["APIConnectionError", () => new APIConnectionError({ message: "network down" }), "anthropic_connection"],
    ["a non-SDK Error", () => new Error("boom"), "anthropic_failed"],
  ];

  test.each(cases)("%s -> %s", async (_name, makeError, expectedCode) => {
    const client = fakeClient(async () => {
      throw makeError();
    });

    await expect(invokeAnthropicText({ ...baseInvocation, client })).rejects.toMatchObject({ code: expectedCode });
  });
});

describe("invokeAnthropicText — refusal and empty response", () => {
  test("stop_reason 'refusal' with empty content throws anthropic_refusal and carries usage", async () => {
    const usageRaw = { input_tokens: 5, output_tokens: 0, cache_read_input_tokens: null, cache_creation_input_tokens: null };
    const client = fakeClient(async () => ({ id: "msg_refusal", content: [], stop_reason: "refusal", usage: usageRaw }));

    const error = await invokeAnthropicText({ ...baseInvocation, client }).catch((caught) => caught);

    expect(error).toBeInstanceOf(AnthropicRunnerError);
    expect(error.code).toBe("anthropic_refusal");
    expect(error.usage).toEqual({ inputTokens: 5, outputTokens: 0, rawUsage: usageRaw });
  });

  test("empty (whitespace-only) text content throws anthropic_empty_response", async () => {
    const client = fakeClient(async () => okMessage({ content: [{ type: "text", text: "   " }] }));

    await expect(invokeAnthropicText({ ...baseInvocation, client })).rejects.toMatchObject({ code: "anthropic_empty_response" });
  });

  test("no text blocks at all (non-refusal stop reason) throws anthropic_empty_response", async () => {
    const client = fakeClient(async () => okMessage({ content: [{ type: "tool_use", id: "t1", name: "x", input: {} }], stop_reason: "tool_use" }));

    await expect(invokeAnthropicText({ ...baseInvocation, client })).rejects.toMatchObject({ code: "anthropic_empty_response" });
  });
});

describe("invokeAnthropicText — truncation is not an error", () => {
  test("stop_reason 'max_tokens' with text resolves with stopReason: 'max_tokens'", async () => {
    const client = fakeClient(async () => okMessage({ content: [{ type: "text", text: "partial output" }], stop_reason: "max_tokens" }));

    const result = await invokeAnthropicText({ ...baseInvocation, client });

    expect(result.stopReason).toBe("max_tokens");
    expect(result.markdown).toBe("partial output");
  });
});

describe("invokeAnthropicText — cancellation vs timeout", () => {
  test("pre-aborted caller signal -> anthropic_cancelled, not anthropic_timeout", async () => {
    const controller = new AbortController();
    controller.abort();
    const client = abortAwareClient(() => new APIUserAbortError());

    await expect(invokeAnthropicText({ ...baseInvocation, client, signal: controller.signal }))
      .rejects.toMatchObject({ code: "anthropic_cancelled" });
  });

  test("timeoutMs: 1 against a never-resolving fake -> anthropic_timeout", async () => {
    const client = abortAwareClient(() => new APIConnectionTimeoutError());

    await expect(invokeAnthropicText({ ...baseInvocation, client, timeoutMs: 1 }))
      .rejects.toMatchObject({ code: "anthropic_timeout" });
  });
});

describe("invokeAnthropicText — unknown model", () => {
  test("throws before any client call", async () => {
    let called = false;
    const client = fakeClient(async () => {
      called = true;
      return okMessage();
    });

    await expect(invokeAnthropicText({ ...baseInvocation, model: "not-a-model", client }))
      .rejects.toBeInstanceOf(UnsupportedAnthropicModelError);
    expect(called).toBe(false);
  });
});
