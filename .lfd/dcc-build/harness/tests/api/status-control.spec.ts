// Implements eval case WF-09 (see harness/eval-cases.json).
//
// No mock-claude job is driven in this file, so the job-payload scenario
// mechanism documented in workflow-state-machine.spec.ts does not apply
// here.
//
// Undocumented-route assumption: PRD §29 defines no dedicated "set ticket
// status" route. Per the task brief this file treats
// `PATCH /api/admin/tickets/{id}` with a `status` field in the body as the
// most plausible route an implementation would use for direct status
// mutation, and asserts the five system-only statuses (PRD §17.3) can never
// be reached through it.

import { describe, it, expect, beforeAll } from "vitest";
import { login, api, apiJson, queryOne, type Session } from "../helpers";

const BASE_URL = process.env.APP_BASE_URL ?? "http://127.0.0.1:3000";

const SYSTEM_ONLY_STATUSES = ["Planning", "Executing", "Validating", "PR Ready for Review", "Merged"];

async function submitFreshTicket(projectSlug: string, title: string) {
  const project = await queryOne("select id from projects where slug = $1", [projectSlug]);
  if (!project) throw new Error(`fixture project ${projectSlug} not found`);
  const res = await fetch(`${BASE_URL}/api/public/forms/website-feedback/submissions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      project_id: project.id,
      title,
      description: "Filed by status-control.spec.ts (WF-09).",
      category: "bug",
      priority: "medium",
      submitter_name: "Eval Harness",
      submitter_email: "eval-harness@example.com",
      expected_behavior: "Expected behaviour text.",
      actual_behavior: "Actual behaviour text.",
      reproduction_steps: "1. Do the thing.",
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`ticket submission failed: ${res.status} ${text}`);
  const json = text ? JSON.parse(text) : {};
  const ticket = json.ticket ?? json;
  const ticketNumber: string = ticket.ticket_number ?? ticket.ticketNumber;
  if (!ticketNumber) throw new Error(`submission response had no ticket_number: ${text}`);
  return ticketNumber;
}

describe("WF-09: system-only statuses cannot be set manually", () => {
  let session: Session;

  beforeAll(async () => {
    session = await login();
  });

  it.each(SYSTEM_ONLY_STATUSES)("rejects (or silently ignores) a direct PATCH status=%s", async (forbiddenStatus) => {
    // Fresh "Submitted" ticket each time, so we're never fooled by a seeded
    // ticket that coincidentally already sits at the forbidden status.
    const ticketNumber = await submitFreshTicket("va-jobs-platform", `WF-09 status guard: ${forbiddenStatus}`);
    const before = await queryOne("select id, status from tickets where ticket_number = $1", [ticketNumber]);
    expect(before.status).toBe("Submitted");

    const res = await apiJson(session, "PATCH", `/api/admin/tickets/${before.id}`, { status: forbiddenStatus });

    const after = await queryOne("select status from tickets where id = $1", [before.id]);

    if (res.status >= 400) {
      // Rejected outright -- satisfies "cannot be manually selected".
      expect(after.status).toBe("Submitted");
    } else {
      // Request accepted (perhaps other fields were patched) but the status
      // field itself must have been silently ignored, never set to the
      // forbidden system-only value.
      expect(
        after.status,
        `PATCH with status=${forbiddenStatus} must not directly set the ticket to that status`,
      ).not.toBe(forbiddenStatus);
    }
  });
});
