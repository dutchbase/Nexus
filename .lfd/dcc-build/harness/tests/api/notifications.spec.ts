import { describe, it, expect, beforeAll } from "vitest";
import {
  login,
  apiJson,
  queryOne,
  ticketByNumber,
} from "../helpers";

describe("OPS-01: Notification delivery and retry", () => {
  let session: Awaited<ReturnType<typeof login>>;

  beforeAll(async () => {
    session = await login();
  });

  it("should read seeded failed notification delivery ND-8841", async () => {
    const delivery = await queryOne(
      "select * from notification_deliveries where id = $1",
      ["00000000-0000-0000-0006-000000008841"]
    );
    expect(delivery).toBeDefined();
    expect(delivery.status).toBe("failed");
    expect(delivery.response_status).toBe(504);
    expect(delivery.attempt_count).toBeGreaterThanOrEqual(1);
    expect(delivery.error_message).toMatch(/timeout|504/i);
  });

  it("should not block ticket workflow when notification delivery fails", async () => {
    // ND-8841 is tied to DCC-145 (Corporate Site project)
    const ticket = await ticketByNumber("DCC-145");
    expect(ticket).toBeDefined();
    // Ticket should still have its workflow status (Plan Ready for Review),
    // not blocked/errored due to notification failure
    expect(ticket.status).toBe("Plan Ready for Review");
  });

  it("should accept manual retry of failed notification delivery", async () => {
    const deliveryId = "00000000-0000-0000-0006-000000008841";
    const beforeDelivery = await queryOne(
      "select attempt_count from notification_deliveries where id = $1",
      [deliveryId]
    );
    const beforeAttempts = beforeDelivery.attempt_count;

    const res = await apiJson(
      session,
      "POST",
      `/api/admin/notifications/deliveries/${deliveryId}/retry`
    );

    // Retry endpoint should accept the request (2xx)
    expect(res.ok || res.status < 400).toBe(true);

    // attempt_count should have incremented
    const afterDelivery = await queryOne(
      "select attempt_count from notification_deliveries where id = $1",
      [deliveryId]
    );
    expect(afterDelivery.attempt_count).toBeGreaterThan(beforeAttempts);
  });

  it("notification failure never blocks ticket approval workflow", async () => {
    // Re-verify DCC-145 is still usable for planning/execution despite ND-8841 failure
    const ticket = await ticketByNumber("DCC-145");
    expect(["Plan Ready for Review", "Approved for Planning", "Executing", "PR Ready for Review"])
      .toContain(ticket.status);
  });
});
