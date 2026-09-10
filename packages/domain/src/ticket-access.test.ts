import { describe, expect, test, vi } from "vitest";
import { lockTicketActor, reporterTicket, ticketForActor } from "./ticket-access.ts";

describe("ticket access", () => {
  test("locks and rechecks the stored actor", async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [{ role: "reporter", is_active: true }] }) };
    await lockTicketActor(client, { userId: "u1", role: "reporter" });
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("FOR UPDATE"), ["u1"]);
  });

  test("parenthesizes alternative references before membership scope", async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    await ticketForActor(client, { userId: "u1", role: "reporter" }, "DCC-1");
    expect(client.query.mock.calls[0][0]).toContain("WHERE (t.id::text=$1 OR t.ticket_number=$1)");
    expect(client.query.mock.calls[0][0]).toContain("m.user_id=$2");
  });

  test("projects only safe declared custom values", () => {
    const result = reporterTicket({
      id: "t", ticket_number: "DCC-1", project_id: "p", project_name: "Project", title: "Title",
      created_by_user_id: "u1", submission_revision: 2, submission_updated_at: new Date(0), created_at: new Date(0),
      custom_values_json: { impact: "high", secret: "hidden" }, status: "Executing", submitter_email: "private@example.test",
    }, { userId: "u1", role: "reporter" }, [{ field_key: "impact", field_type: "short_text" }]);
    expect(result).toMatchObject({ submission: { impact: "high" }, can_delete: true });
    expect(result).not.toHaveProperty("status");
    expect(result).not.toHaveProperty("submitter_email");
  });
});
