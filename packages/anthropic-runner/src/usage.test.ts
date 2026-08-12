import { describe, expect, test } from "vitest";
import { parseAnthropicUsage } from "./usage.ts";

describe("parseAnthropicUsage", () => {
  test("normalizes {input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens}", () => {
    const raw = { input_tokens: 100, output_tokens: 200, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 };

    expect(parseAnthropicUsage(raw)).toEqual({
      inputTokens: 100, outputTokens: 200, cacheReadTokens: 30, cacheWriteTokens: 40,
      rawUsage: raw,
    });
  });

  test("never emits reasoningTokens even when omitted from the raw usage", () => {
    const raw = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: null, cache_creation_input_tokens: null };
    const parsed = parseAnthropicUsage(raw);
    expect(parsed).not.toBeNull();
    expect(parsed).not.toHaveProperty("reasoningTokens");
  });

  test("treats null cache_read_input_tokens / cache_creation_input_tokens as absent (no cache activity)", () => {
    const raw = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: null, cache_creation_input_tokens: null };
    expect(parseAnthropicUsage(raw)).toEqual({ inputTokens: 10, outputTokens: 20, rawUsage: raw });
  });

  test("omits cache fields entirely when absent from the raw usage", () => {
    const raw = { input_tokens: 10, output_tokens: 20 };
    expect(parseAnthropicUsage(raw)).toEqual({ inputTokens: 10, outputTokens: 20, rawUsage: raw });
  });

  test("returns null on missing input or output tokens", () => {
    expect(parseAnthropicUsage({ output_tokens: 2 })).toBeNull();
    expect(parseAnthropicUsage({ input_tokens: 1 })).toBeNull();
    expect(parseAnthropicUsage({})).toBeNull();
  });

  test("returns null on non-integer input or output tokens", () => {
    expect(parseAnthropicUsage({ input_tokens: 1.5, output_tokens: 2 })).toBeNull();
    expect(parseAnthropicUsage({ input_tokens: 1, output_tokens: Number.NaN })).toBeNull();
  });

  test("returns null on negative input or output tokens", () => {
    expect(parseAnthropicUsage({ input_tokens: -1, output_tokens: 2 })).toBeNull();
    expect(parseAnthropicUsage({ input_tokens: 1, output_tokens: -2 })).toBeNull();
  });

  test("returns null on wrong-typed token counts", () => {
    expect(parseAnthropicUsage({ input_tokens: "1", output_tokens: 2 })).toBeNull();
    expect(parseAnthropicUsage({ input_tokens: 1, output_tokens: 2, cache_read_input_tokens: "30" })).toBeNull();
    expect(parseAnthropicUsage({ input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: -5 })).toBeNull();
  });

  test("returns null for non-object or nullish usage", () => {
    expect(parseAnthropicUsage(null)).toBeNull();
    expect(parseAnthropicUsage(undefined)).toBeNull();
    expect(parseAnthropicUsage("not an object")).toBeNull();
    expect(parseAnthropicUsage(42)).toBeNull();
  });
});
