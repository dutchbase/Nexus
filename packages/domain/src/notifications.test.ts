import { describe, expect, it } from "vitest";
import { buildNotificationPayload } from "./notifications.ts";

describe("buildNotificationPayload", () => {
  it("builds the documented event shape and omits an inapplicable run", () => {
    expect(buildNotificationPayload({
      event: "ticket.created",
      occurredAt: new Date("2026-07-27T04:30:00.000Z"),
      ticket: { id: "ticket-id", ticket_number: "DCC-142", title: "Overlap", status: "Submitted", priority: "High" },
      project: { id: "project-id", name: "VA Jobs Platform" },
      dashboardUrl: "https://feedback.example.com/admin/tickets/DCC-142",
    })).toEqual({
      event: "ticket.created",
      occurredAt: "2026-07-27T04:30:00.000Z",
      ticket: { id: "ticket-id", number: "DCC-142", title: "Overlap", status: "Submitted", priority: "High" },
      project: { id: "project-id", name: "VA Jobs Platform" },
      dashboardUrl: "https://feedback.example.com/admin/tickets/DCC-142",
    });
  });
});
