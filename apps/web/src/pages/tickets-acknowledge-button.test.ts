import { describe, expect, it } from "vitest";
import { approvalGatesCard } from "./tickets.ts";

describe("approvalGatesCard", () => {
  it("enables the acknowledge button for a Submitted ticket", () => {
    const html = approvalGatesCard({ status: "Submitted" });

    expect(html).toContain("data-acknowledge-ticket");
    expect(html).not.toMatch(/data-acknowledge-ticket[^>]*\bdisabled\b/);
  });

  it("disables the acknowledge button once the ticket has moved past Submitted", () => {
    const html = approvalGatesCard({ status: "Triage" });

    expect(html).toMatch(/data-acknowledge-ticket[^>]*\bdisabled\b/);
  });
});
