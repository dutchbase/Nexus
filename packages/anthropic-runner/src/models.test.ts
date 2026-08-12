import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { aiModels, isDeepSeekModel } from "@dcc/domain";
import { describe, expect, test } from "vitest";
import { anthropicModelSpec, effortFor, UnsupportedAnthropicModelError } from "./models.ts";

const anthropicShorthands = aiModels.filter((model) => !isDeepSeekModel(model));

describe("anthropicModelSpec", () => {
  test("every non-DeepSeek shorthand in aiModels maps to an Anthropic model id", () => {
    for (const model of anthropicShorthands) {
      const spec = anthropicModelSpec(model);
      expect(typeof spec.id).toBe("string");
      expect(spec.id.length).toBeGreaterThan(0);
    }
  });

  // Migration 050 seeds only shorthand keys ('fable'/'opus'/'sonnet'/'haiku')
  // and pricing — it has no literal Anthropic API model-id strings anywhere.
  // This test can therefore only prove shorthand-key parity between
  // models.ts and the migration's seed rows; it cannot and does not verify
  // that the literal id strings models.ts maps each shorthand to (e.g.
  // "claude-sonnet-5") are themselves correct. Those must be confirmed
  // against a live Anthropic API endpoint (or shared/models.md in the
  // claude-api skill) before ANTHROPIC_API_KEY is ever set in production.
  test("shorthand keys match the ai_model_prices seed rows in migration 050 (drift guard)", () => {
    const migrationPath = fileURLToPath(new URL("../../database/migrations/050_ai_invocation_accounting.sql", import.meta.url));
    const sql = readFileSync(migrationPath, "utf8");
    const seededAnthropicShorthands = [...sql.matchAll(/\('([a-z0-9-]+)','anthropic',/g)].map((match) => match[1]);
    expect(seededAnthropicShorthands.length).toBeGreaterThan(0);
    expect(new Set(seededAnthropicShorthands)).toEqual(new Set(anthropicShorthands));
    for (const shorthand of seededAnthropicShorthands) {
      expect(() => anthropicModelSpec(shorthand)).not.toThrow();
    }
  });

  test("haiku.supportsEffort === false", () => {
    expect(anthropicModelSpec("haiku").supportsEffort).toBe(false);
  });

  test("non-haiku shorthands support effort", () => {
    expect(anthropicModelSpec("fable").supportsEffort).toBe(true);
    expect(anthropicModelSpec("opus").supportsEffort).toBe(true);
    expect(anthropicModelSpec("sonnet").supportsEffort).toBe(true);
  });

  test("throws UnsupportedAnthropicModelError for a DeepSeek shorthand", () => {
    expect(() => anthropicModelSpec("deepseek-v4-pro")).toThrow(UnsupportedAnthropicModelError);
  });

  test("throws UnsupportedAnthropicModelError for an unknown model", () => {
    expect(() => anthropicModelSpec("gpt-5")).toThrow(UnsupportedAnthropicModelError);
  });
});

describe("effortFor", () => {
  test("returns the level for a model that supports effort", () => {
    const sonnet = anthropicModelSpec("sonnet");
    expect(effortFor(sonnet, "high")).toBe("high");
    expect(effortFor(sonnet, "xhigh")).toBe("xhigh");
  });

  test("returns null for haiku regardless of level (supportsEffort === false)", () => {
    const haiku = anthropicModelSpec("haiku");
    expect(effortFor(haiku, "high")).toBeNull();
    expect(effortFor(haiku, "low")).toBeNull();
  });

  test("returns null for a level the Anthropic API does not accept", () => {
    const sonnet = anthropicModelSpec("sonnet");
    expect(effortFor(sonnet, "ultracode")).toBeNull();
    expect(effortFor(sonnet, "not-a-real-level")).toBeNull();
  });
});
