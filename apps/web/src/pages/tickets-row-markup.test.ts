import { expect, test, vi } from "vitest";
const query = vi.fn();
vi.mock("@dcc/database", () => ({ inTransaction: vi.fn(), pool: { query } }));
const tickets = await import("./tickets.ts");

const row = {
  id: "id-1", ticket_number: "DCC-1", title: "A ticket", project_name: "P", project_id: "p",
  status: "Submitted", priority: "high", updated_at: new Date(2026, 0, 1).toISOString(),
};

test("table rows expose an overlay link plus four quick-action buttons and one shared dialog", async () => {
  query.mockImplementation(async (sql: string) => sql.includes("FROM tickets t") ? { rows: [row] } : { rows: [] });
  const page = await tickets.render(new URL("http://test/admin/tickets"), { username: "admin", user_id: "admin" }, {});
  const body = page?.body ?? "";

  expect(body).toContain('<div class="ticket-row tickets7">');
  expect(body).not.toContain('<a class="ticket-row tickets7"');
  expect(body).toContain('class="ticket-row-link" href="/admin/tickets/DCC-1"');
  for (const key of ["acknowledge", "start-planning", "execute", "delete"]) {
    expect(body).toContain(`data-ticket-action="${key}"`);
  }
  expect(body).toMatch(/data-ticket-action="start-planning"[^>]*\bdisabled\b/);
  expect(body).not.toMatch(/data-ticket-action="acknowledge"[^>]*\bdisabled\b/);
  expect(body).toContain("<span>Actions</span>");
  expect((body.match(/data-ticket-action-dialog/g) ?? []).length).toBe(1);
});

import { styles } from "../ui.ts";

test("the tickets grid has an actions column and an overlay link that does not swallow clicks", () => {
  expect(styles).toContain(".tickets7.list-head,.tickets7.ticket-row { grid-template-columns:110px minmax(220px,3fr) 1.2fr 1fr 1.1fr 1.3fr .8fr 150px }");
  expect(styles).toContain(".tickets7.ticket-row > :not(.ticket-row-link) { position:relative;z-index:1;pointer-events:none }");
  expect(styles).toContain(".ticket-quick-actions,.ticket-quick-actions * { pointer-events:auto }");
});
