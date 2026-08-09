import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
vi.mock("@dcc/database", () => ({ pool: { query } }));

const usage = await import("./ai-usage.ts");
const session = { username: "admin", user_id: "admin" };

const row: any = {
  id: "aaaaaaaa-0000-4000-8000-000000000002", started_at: "2026-08-04T10:00:00Z",
  run_type: "execution", model: "sonnet", provider: "anthropic", ai_usage_status: "captured",
  input_tokens: 10, output_tokens: 20, reasoning_tokens: 8, cache_read_tokens: 2, cache_write_tokens: 3,
  total_tokens: 35, estimated_cost_usd: "0.00001234", ticket_number: "T-12", pr_number: 42,
  pr_url: "https://example.test/pr/42", project_name: "Project", prompt_name: "execution", prompt_version: 3,
};

beforeEach(() => query.mockReset());

function responses(rows = [row]) {
  query.mockImplementation(async (sql: string) => {
    if (String(sql).includes("count(*)::integer AS invocations")) return { rows: [{ invocations: "3", captured_tokens: "35", estimated_cost_usd: "0.00001234", coverage_exceptions: "2" }] };
    if (String(sql).includes("FROM agent_runs ar")) return { rows };
    return { rows: [] };
  });
}

describe("AI usage dashboard", () => {
  it("uses a 30-day default, parameterized filters, and a stable keyset cursor", async () => {
    responses();
    await usage.render(new URL("http://test/admin/ai-usage?project=alpha&run_type=execution&model=sonnet&usage_status=captured&search=T-12&from=2026-08-01&to=2026-08-05&cursor=2026-08-03T00%3A00%3A00Z%2Cr1"), session, {});

    const [sql, values] = query.mock.calls.find(([sql]) => String(sql).includes("ORDER BY ar.started_at DESC"))!;
    expect(sql).toContain("ar.started_at >= $");
    expect(sql).toContain("ar.started_at < $");
    expect(sql).toContain("(ar.started_at, ar.id) < ($");
    expect(sql).toMatch(/ORDER BY ar\.started_at DESC, ar\.id DESC LIMIT \$\d+/);
    expect(sql).toContain("ar.run_type = ANY($1::text[])");
    expect(values[0]).toEqual(["planning", "plan_revision", "execution", "execution.repair", "pr_ai_review", "pr_follow_up_description", "pr_conflict_resolution"]);
    expect(values).toEqual(expect.arrayContaining(["%alpha%", "execution", "sonnet", "captured", "%T-12%", "2026-08-03T00:00:00Z", "r1"]));
  });

  it.each([
    ["planning", ["planning", "plan_revision"]],
    ["execution", ["execution", "execution.repair"]],
    ["pr_work", ["pr_ai_review", "pr_follow_up_description", "pr_conflict_resolution"]],
  ])("filters lifecycle group %s by its run types", async (lifecycle, types) => {
    responses();
    await usage.render(new URL(`http://test/admin/ai-usage?all_time=1&lifecycle=${lifecycle}&run_type=${types[0]}`), session, {});

    const [sql, values] = query.mock.calls.find(([sql]) => String(sql).includes("ORDER BY ar.started_at DESC"))!;
    expect(sql).toContain("ar.run_type = ANY($");
    expect(values).toEqual(expect.arrayContaining([types, types[0]]));
  });

  it("keeps coverage exceptions visible and labels legacy usage as not captured", async () => {
    responses([{ ...row, ai_usage_status: null, input_tokens: null, total_tokens: null, estimated_cost_usd: null }]);
    const page = await usage.render(new URL("http://test/admin/ai-usage?all_time=1"), session, {});

    expect(page?.body).toContain("Coverage exceptions");
    expect(page?.body).toContain(">2<");
    expect(page?.body).toContain("Not captured");
    const [summarySql] = query.mock.calls.find(([sql]) => String(sql).includes("coverage_exceptions"))!;
    expect(summarySql).toContain("ar.ai_usage_status='captured' AND ar.estimated_cost_usd IS NULL");
  });

  it("renders compact accounting without exposing prompt content in the list", async () => {
    responses([{ ...row, task_prompt: "<script>secret</script>", ticket_number: "T-12", pr_id: "pr-1", prompt_versions: { "global.execution": "pv-execution" } }]);
    const page = await usage.render(new URL("http://test/admin/ai-usage"), session, {});

    expect(page?.body).toContain("10 in · 20 out");
    expect(page?.body).toContain("$0.00001234");
    expect(page?.body).not.toContain("secret");
    expect(page?.body).toContain('href="/admin/tickets/T-12"');
    expect(page?.body).toContain('href="/admin/pull-requests/pr-1"');
    expect(page?.body).not.toContain('<a class="ticket-row"');
    expect(page?.body).toContain("global.execution: pv-execution");
    const [sql] = query.mock.calls.find(([sql]) => String(sql).includes("ORDER BY ar.started_at DESC"))!;
    expect(sql).toContain("ps.metadata_json->'promptVersionIds' prompt_versions");
    expect(sql).not.toContain("prompt_version'");
  });
});
