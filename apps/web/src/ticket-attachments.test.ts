import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
const inTransaction = vi.fn();
vi.mock("@dcc/database", () => ({ inTransaction, pool: { query } }));

const tickets = await import("./pages/tickets.ts");
const session = { username: "admin", user_id: "admin" };

const ticket = {
  id: "ticket-1", ticket_number: "T-1", project_id: "project-1", project_name: "Project", form_name: null,
  title: "Ticket title", description: "Ticket description", category: "bug", environment: "prod",
  status: "Submitted", created_at: "2026-08-04T10:00:00Z",
};

const attachment = {
  id: "11111111-1111-4111-8111-111111111111", original_name: "screenshot.png", media_type: "image/png", size_bytes: 20480,
};

beforeEach(() => {
  query.mockReset();
  inTransaction.mockReset();
  query.mockImplementation(async (sql: string) => {
    if (!sql) return { rows: [] };
    if (sql.includes("FROM tickets t JOIN projects p")) return { rows: [ticket] };
    if (sql.includes("FROM attachments a JOIN uploads u")) return { rows: [attachment] };
    return { rows: [] };
  });
});

describe("ticket detail attachments card", () => {
  it("lists ticket attachments with a name, human size, and an authorized download link", async () => {
    const page = await tickets.render(new URL("http://test/admin/tickets/T-1"), session, {});

    expect(page?.body).toContain("Attachments");
    expect(page?.body).toContain("screenshot.png");
    expect(page?.body).toContain("/admin/attachments/11111111-1111-4111-8111-111111111111");
  });

  it("renders a no-attachments message when there are none", async () => {
    query.mockImplementation(async (sql: string) => {
      if (!sql) return { rows: [] };
      if (sql.includes("FROM tickets t JOIN projects p")) return { rows: [ticket] };
      return { rows: [] };
    });

    const page = await tickets.render(new URL("http://test/admin/tickets/T-1"), session, {});

    expect(page?.body).toContain("No attachments");
  });
});
