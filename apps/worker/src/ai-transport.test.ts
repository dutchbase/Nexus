import { describe, expect, it } from "vitest";
import { anthropicApiPhases, anthropicKeyOrThrow, usesAnthropicApi } from "./ai-transport.ts";

describe("usesAnthropicApi", () => {
  it("is false when no ANTHROPIC_API_KEY is configured", () => {
    expect(usesAnthropicApi("pr_follow_up_description", {})).toBe(false);
  });

  it("is true for pr_follow_up_description with a key and the default config", () => {
    expect(usesAnthropicApi("pr_follow_up_description", { ANTHROPIC_API_KEY: "sk-test" })).toBe(true);
  });

  it("is false for a phase not in the default list even with a key", () => {
    expect(usesAnthropicApi("pr_ai_review", { ANTHROPIC_API_KEY: "sk-test" })).toBe(false);
  });

  it("is false when DCC_ANTHROPIC_API_JOBS is the empty-string kill switch", () => {
    expect(usesAnthropicApi("pr_follow_up_description", {
      ANTHROPIC_API_KEY: "sk-test",
      DCC_ANTHROPIC_API_JOBS: "",
    })).toBe(false);
  });

  it("respects an explicit multi-phase list", () => {
    const env = { ANTHROPIC_API_KEY: "sk-test", DCC_ANTHROPIC_API_JOBS: "pr_follow_up_description,pr_conflict_resolution" };
    expect(usesAnthropicApi("pr_follow_up_description", env)).toBe(true);
    expect(usesAnthropicApi("pr_conflict_resolution", env)).toBe(true);
    expect(usesAnthropicApi("pr_ai_review", env)).toBe(false);
  });
});

describe("anthropicApiPhases", () => {
  it("throws on an unknown phase name", () => {
    expect(() => anthropicApiPhases({ DCC_ANTHROPIC_API_JOBS: "not_a_real_phase" })).toThrow(
      'DCC_ANTHROPIC_API_JOBS names unknown phase "not_a_real_phase"',
    );
  });
});

describe("anthropicKeyOrThrow", () => {
  it("throws the exact configuration error message when unset", () => {
    expect(() => anthropicKeyOrThrow({})).toThrow("ANTHROPIC_API_KEY is not configured for the worker");
  });

  it("returns the key when configured", () => {
    expect(anthropicKeyOrThrow({ ANTHROPIC_API_KEY: "sk-test" })).toBe("sk-test");
  });
});
