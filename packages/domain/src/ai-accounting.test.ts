import { describe, expect, it } from "vitest";
import {
  aiLifecycleGroup, createAiInvocation, providerForModel, recordAiUnavailable, recordAiUsage,
} from "./index.ts";

describe("AI invocation accounting", () => {
  it("maps supported models and invocation lifecycles", () => {
    expect(providerForModel("sonnet")).toBe("anthropic");
    expect(providerForModel("deepseek-v4-pro")).toBe("deepseek");
    expect(aiLifecycleGroup("plan_revision")).toBe("planning");
    expect(aiLifecycleGroup("execution.repair")).toBe("execution");
    expect(aiLifecycleGroup("pr_conflict_resolution")).toBe("pr_work");
  });

  it("creates a pending invocation with its provider", async () => {
    let values: unknown[] = [];
    const row = await createAiInvocation({
      id: "run-1", projectId: "project-1", runType: "planning", model: "sonnet", reasoningLevel: "high",
    }, { query: async (_sql, input) => {
      values = input!;
      return { rows: [{ id: "run-1", usage_status: "pending", provider: "anthropic" }] };
    } });

    expect(row).toMatchObject({ usage_status: "pending", provider: "anthropic" });
    expect(values).toContain("anthropic");
  });

  it("persists provider totals and the effective price exactly once", async () => {
    let values: unknown[] = [];
    const row = await recordAiUsage({
      runId: "run-1", inputTokens: 100, outputTokens: 200, reasoningTokens: 50, cacheReadTokens: 30, cacheWriteTokens: 40,
      rawUsage: { input_tokens: 100 },
    }, { query: async (_sql, input) => {
      if (_sql.includes("FOR UPDATE")) return { rows: [{ id: "run-1", ai_usage_status: "pending", model: "sonnet", started_at: "2026-08-08" }] };
      if (_sql.includes("FROM ai_model_prices")) return { rows: [{ id: "price-1", input_usd_per_million: 3, output_usd_per_million: 15, cache_read_usd_per_million: 0.3, cache_write_usd_per_million: 3.75 }] };
      values = input!;
      return { rows: [{ id: "run-1", usage_status: "captured", total_tokens: 370, estimated_cost_usd: "0.001" }] };
    } });

    expect(row).toMatchObject({ usage_status: "captured", total_tokens: 370 });
    expect(values).toContain(370);
    expect(values).not.toContain(420); // reasoning is already included in output.
  });

  it("does not overwrite captured or unavailable accounting", async () => {
    const rows = [{ id: "run-1", usage_status: "captured", total_tokens: 370 }];
    const client = { query: async () => ({ rows }) };
    await expect(recordAiUsage({ runId: "run-1", inputTokens: 1, outputTokens: 1, rawUsage: {} }, client)).resolves.toEqual(rows[0]);
    await expect(recordAiUnavailable("run-1", client)).resolves.toEqual(rows[0]);
  });

  it("locks the invocation before returning concurrent terminal accounting", async () => {
    const calls: string[] = [];
    const client = { query: async (sql: string) => {
      calls.push(sql);
      return { rows: calls.length === 1
        ? [{ id: "run-1", ai_usage_status: "captured" }]
        : [] };
    } };

    await expect(recordAiUsage({ runId: "run-1", inputTokens: 1, outputTokens: 1, rawUsage: {} }, client))
      .resolves.toMatchObject({ ai_usage_status: "captured" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("FOR UPDATE");
  });
});
