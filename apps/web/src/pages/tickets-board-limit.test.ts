import { expect, test, vi } from "vitest";
const query = vi.fn();
vi.mock("@dcc/database", () => ({ inTransaction: vi.fn(), pool: { query } }));
const tickets = await import("./tickets.ts");

test("board announces when more tickets exist than it displays", async () => {
  const rows = Array.from({ length: 201 }, (_, index) => ({
    id: `id-${index}`, ticket_number: `T-${index}`, title: `Ticket ${index}`, project_name: "P",
    project_id: "p", status: "Submitted", priority: "normal", updated_at: new Date(2026, 0, 1, 0, 0, index).toISOString(),
  }));
  query.mockImplementation(async (sql: string) => sql.includes("FROM tickets t") ? { rows } : { rows: [] });
  const page = await tickets.render(new URL("http://test/admin/tickets?view=board"), { username: "admin", user_id: "admin" }, {});
  expect(query.mock.calls.find(([sql]) => sql.includes("FROM tickets t"))?.[1]).toContain(201);
  expect(page?.body).toContain("Showing newest 200 tickets");
  expect(page?.body).not.toContain("Ticket 200");
});
