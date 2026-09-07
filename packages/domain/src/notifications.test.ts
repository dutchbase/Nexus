import { describe, expect, it, vi } from "vitest";
import { buildNotificationPayload, failNotificationDelivery } from "./notifications.ts";

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

describe("failNotificationDelivery", () => {
  it("persists an already-redacted provider diagnostic passed by the worker", async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }) };

    await expect(failNotificationDelivery(
      "delivery-id", "worker-id", "HTTP 401 from notification endpoint", 401, 5, client,
    )).resolves.toBe(true);

    expect(client.query).toHaveBeenCalledWith(expect.any(String), [
      "delivery-id", "worker-id", "HTTP 401 from notification endpoint", 401, 5,
    ]);
  });
});
