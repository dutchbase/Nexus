import { describe, expect, it } from "vitest";
import { buildPullRequestBody } from "./pull-request.ts";

describe("pull request body", () => {
  it("contains every review and traceability field", () => {
    const body = buildPullRequestBody({
      ticketNumber: "DCC-42", ticketTitle: "Fix checkout", project: "Billing",
      problemSummary: "Checkout fails.", approvedPlanSummary: "Repair checkout.",
      model: "sonnet", reasoningLevel: "high", appliedSkills: ["testing"],
      changedFiles: ["src/checkout.ts"], validationResults: [{ check: "tests", status: "passed" }],
      knownLimitations: "None.", planHash: "abc123", executionRunId: "run-id",
      internalTicketUrl: "http://localhost/admin/tickets/DCC-42",
    });
    for (const value of [
      "DCC-42", "Fix checkout", "Billing", "Checkout fails.", "Repair checkout.",
      "sonnet", "high", "testing", "src/checkout.ts", "tests: passed", "None.",
      "abc123", "run-id", "http://localhost/admin/tickets/DCC-42", "Human review checklist",
    ]) expect(body).toContain(value);
  });
});
