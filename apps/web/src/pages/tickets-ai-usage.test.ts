import { describe, expect, it } from "vitest";
import { ticketAiUsagePanel } from "./tickets.ts";

describe("ticket AI usage", () => {
  it("groups lifecycle costs while preserving partial coverage and escaped run details", () => {
    const html = ticketAiUsagePanel([
      { id: "planning", run_type: "planning", ai_usage_status: "captured", total_tokens: 100, estimated_cost_usd: "0.01", model: "opus", reasoning_level: "high", status: "completed" },
      { id: "revision", run_type: "plan_revision", ai_usage_status: "captured", total_tokens: 50, estimated_cost_usd: null, model: "sonnet", reasoning_level: "medium", status: "completed" },
      { id: "repair", run_type: "execution.repair", ai_usage_status: "unavailable", total_tokens: null, estimated_cost_usd: null, model: "haiku", reasoning_level: "low", status: "completed" },
      { id: "legacy\"><script>alert(1)</script>", run_type: "pr_ai_review", ai_usage_status: null, total_tokens: null, estimated_cost_usd: null, model: "<img src=x>", reasoning_level: "low", status: "completed" },
    ]);

    expect(html).toContain("Planning");
    expect(html).toContain("2 invocations · 150 tokens · $0.01");
    expect(html).toContain("Unpriced 1");
    expect(html).toContain("Execution");
    expect(html).toContain("Unavailable 1");
    expect(html).toContain("PR work");
    expect(html).toContain("Legacy 1");
    expect(html).toContain("All AI work");
    expect(html).toContain('href="/admin/runs/legacy&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"');
    expect(html).toContain("&lt;img src=x&gt;");
    expect(html).not.toContain("<script>");
  });

  it("does not treat captured zeroes as missing coverage", () => {
    const html = ticketAiUsagePanel([
      { id: "zero", run_type: "execution", ai_usage_status: "captured", total_tokens: 0, estimated_cost_usd: "0", model: "sonnet", reasoning_level: "low", status: "completed" },
    ]);

    expect(html).toContain("1 invocations · 0 tokens · $0.00");
    expect(html).not.toContain("Unavailable 1");
    expect(html).not.toContain("Unpriced 1");
    expect(html).not.toContain("Legacy 1");
  });

  it("keeps non-AI historical runs and distinguishes unpriced from zero-cost rows", () => {
    const html = ticketAiUsagePanel([
      { id: "historic", run_type: "validation", ai_usage_status: null, model: "—", reasoning_level: null, status: "completed" },
      { id: "unpriced", run_type: "execution", ai_usage_status: "captured", total_tokens: 10, estimated_cost_usd: null, model: "sonnet", reasoning_level: "low", status: "completed" },
      { id: "zero", run_type: "execution", ai_usage_status: "captured", total_tokens: 0, estimated_cost_usd: "0", model: "sonnet", reasoning_level: "low", status: "completed" },
    ]);

    expect(html).toContain('href="/admin/runs/historic"');
    expect(html).toContain("validation");
    expect(html).toContain('href="/admin/runs/unpriced"');
    expect(html).toContain("10 tokens · Unpriced");
    expect(html).toContain('href="/admin/runs/zero"');
    expect(html).toContain("0 tokens · $0.00");
  });
});
