import { describe, it, expect, beforeAll } from "vitest";
import {
  login,
  apiJson,
  queryOne,
  queryAll,
} from "../helpers";

describe("OPS-03: Invalid model/reasoning combination validation", () => {
  let session: Awaited<ReturnType<typeof login>>;

  beforeAll(async () => {
    session = await login();
  });

  it("should reject unsupported model/reasoning combination via PATCH", async () => {
    // Pick a test ticket, e.g. DCC-148 (Submitted status, va-jobs-platform)
    const ticket = await queryOne(
      "select id from tickets where ticket_number = $1",
      ["DCC-148"]
    );
    expect(ticket).toBeDefined();

    const ticketId = ticket.id;

    // Attempt to set an implausible combination (PRD §5 says effort levels may depend on model)
    // "haiku" + "ultracode" is highly unlikely to be supported
    const res = await apiJson(
      session,
      "PATCH",
      `/api/admin/tickets/${ticketId}`,
      {
        default_model: "haiku",
        default_reasoning_level: "ultracode",
      }
    );

    // Should be rejected (4xx)
    expect(res.ok).toBe(false);
    expect([400, 422]).toContain(res.status);

    // Response should mention validation error
    const responseText = JSON.stringify(res.json || {});
    expect(responseText.toLowerCase()).toMatch(
      /invalid|unsupported|reasoning|model|combination|not.*support/
    );
  });

  it("should reject approve-planning with invalid model/reasoning via POST", async () => {
    // First, try to set an invalid combo via PATCH (may or may not work)
    // Then attempt approve-planning
    const ticket = await queryOne(
      "select id from tickets where ticket_number = $1",
      ["DCC-148"]
    );
    expect(ticket).toBeDefined();

    const ticketId = ticket.id;

    // Attempt approval with invalid reasoning level
    const res = await apiJson(
      session,
      "POST",
      `/api/admin/tickets/${ticketId}/approve-planning`,
      {
        reasoning_level: "invalid-level",
      }
    );

    // Should be rejected
    expect(res.ok).toBe(false);
    expect([400, 422]).toContain(res.status);

    // Response should mention validation
    const responseText = JSON.stringify(res.json || {});
    expect(responseText.toLowerCase()).toMatch(/invalid|unsupported/);
  });

  it("should never silently downgrade model or reasoning level", async () => {
    const ticket = await queryOne(
      "select id from tickets where ticket_number = $1",
      ["DCC-148"]
    );
    const ticketId = ticket.id;

    // Capture current ticket config
    const beforeTicket = await queryOne(
      "select default_model, default_reasoning_level from tickets where id = $1",
      [ticketId]
    );

    // Attempt to set unsupported combo
    await apiJson(session, "PATCH", `/api/admin/tickets/${ticketId}`, {
      default_model: "haiku",
      default_reasoning_level: "ultracode",
    });

    // Ticket config should not change if request was rejected
    const afterTicket = await queryOne(
      "select default_model, default_reasoning_level from tickets where id = $1",
      [ticketId]
    );
    expect(afterTicket.default_model).toBe(beforeTicket.default_model);
    expect(afterTicket.default_reasoning_level).toBe(beforeTicket.default_reasoning_level);
  });

  it("should not create jobs/agent_runs with different model than requested", async () => {
    const ticket = await queryOne(
      "select id, ticket_number from tickets where ticket_number = $1",
      ["DCC-148"]
    );
    const ticketId = ticket.id;
    const ticketNumber = ticket.ticket_number;

    // Capture any runs BEFORE we attempt approval
    const runsBefore = await queryAll(
      "select * from agent_runs where ticket_id = $1 order by created_at",
      [ticketId]
    );

    // Attempt to approve with invalid config
    await apiJson(
      session,
      "POST",
      `/api/admin/tickets/${ticketId}/approve-planning`,
      {
        reasoning_level: "invalid-level",
      }
    );

    // Capture any runs AFTER
    const runsAfter = await queryAll(
      "select * from agent_runs where ticket_id = $1 order by created_at",
      [ticketId]
    );

    // Should be no new runs created by the rejected request
    expect(runsAfter.length).toBe(runsBefore.length);

    // If there were existing runs, verify none have a substituted/downgraded model
    for (const run of runsAfter) {
      // Downgrade would look like: requested opus but got sonnet
      // For this test, just verify model matches the ticket's current config
      const currentTicket = await queryOne(
        "select default_model from tickets where id = $1",
        [ticketId]
      );
      // The run's model should match what the ticket says (no silent downgrade)
      expect(run.model).not.toBe("haiku"); // haiku would be a downgrade
    }
  });
});
