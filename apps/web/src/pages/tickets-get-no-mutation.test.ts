import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
const inTransaction = vi.fn();
vi.mock("@dcc/database", () => ({ inTransaction, pool: { query } }));

const tickets = await import("./tickets.ts");
const session = { username: "admin", user_id: "admin" };

const ticket = {
  id: "ticket-1", ticket_number: "T-1", project_id: "project-1", project_name: "Project", form_name: null,
  title: "Ticket title", description: "Ticket description", category: "bug", environment: "prod",
  status: "Submitted", created_at: "2026-08-04T10:00:00Z",
};

beforeEach(() => {
  query.mockReset();
  inTransaction.mockReset();
  query.mockImplementation(async (sql: string) => {
    if (!sql) return { rows: [] };
    if (sql.includes("FROM tickets t JOIN projects p")) return { rows: [ticket] };
    return { rows: [] };
  });
});

describe("ticket detail GET", () => {
  it("renders a Submitted ticket as-is without mutating it as a side effect of viewing", async () => {
    const page = await tickets.render(new URL("http://test/admin/tickets/T-1"), session, {});

    expect(page?.body).toContain("Submitted");
    expect(inTransaction).not.toHaveBeenCalled();
    for (const call of query.mock.calls) {
      expect(String(call[0])).not.toMatch(/UPDATE tickets|INSERT INTO ticket_status_history/i);
    }
  });

  it("renders lifecycle summaries from the existing ticket runs query", async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM tickets t JOIN projects p")) return { rows: [ticket] };
      if (sql.includes("SELECT * FROM agent_runs")) return { rows: [
        { id: "run-1", run_type: "planning", ai_usage_status: "captured", total_tokens: 42, estimated_cost_usd: "0.002", model: "opus", reasoning_level: "high", status: "completed" },
        { id: "run-2", run_type: "pr_ai_review", ai_usage_status: "unavailable", model: "haiku", reasoning_level: "low", status: "completed" },
      ] };
      return { rows: [] };
    });

    const page = await tickets.render(new URL("http://test/admin/tickets/T-1"), session, {});

    expect(query.mock.calls.some(([sql]) => String(sql).includes("SELECT * FROM agent_runs WHERE ticket_id=$1"))).toBe(true);
    expect(page?.body).toContain("AI usage");
    expect(page?.body).toContain("1 invocations · 42 tokens · $0.002");
    expect(page?.body).toContain("Unavailable 1");
    expect(page?.body).toContain('href="/admin/runs/run-1"');
  });
});
