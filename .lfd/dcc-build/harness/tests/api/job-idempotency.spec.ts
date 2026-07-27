// Implements eval case WF-11 (see harness/eval-cases.json).
//
// Mock-Claude scenario mechanism: job-payload field (`mock_scenario_path`),
// same convention as workflow-state-machine.spec.ts. Both racing calls in
// this test pass the same scenario path; since the point of the test is
// that only one job should ever be created, which scenario "wins" is moot.
//
// Undocumented-contract assumptions:
//   - Same Submitted->Triage->approve-planning route assumptions as
//     workflow-state-machine.spec.ts.
//   - The `jobs` table (PRD §26) has no direct ticket_id column, only
//     `payload_json` (jsonb) and `idempotency_key`. This file correlates
//     jobs to a ticket via a substring search over `payload_json::text`
//     for the ticket's UUID, which is robust regardless of what key name
//     the implementation chooses inside payload_json to store the ticket
//     reference under.

import { describe, it, expect, beforeAll } from "vitest";
import { login, api, apiJson, queryOne, queryAll, waitFor, type Session } from "../helpers";

const BASE_URL = process.env.APP_BASE_URL ?? "http://127.0.0.1:3000";

async function submitFreshTicket(projectSlug: string, title: string) {
  const project = await queryOne("select id from projects where slug = $1", [projectSlug]);
  if (!project) throw new Error(`fixture project ${projectSlug} not found`);
  const res = await fetch(`${BASE_URL}/api/public/forms/website-feedback/submissions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      project_id: project.id,
      title,
      description: "Filed by job-idempotency.spec.ts (WF-11).",
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

describe("WF-11: duplicate approval clicks create exactly one job", () => {
  let session: Session;

  beforeAll(async () => {
    session = await login();
  });

  it(
    "two concurrent approve-planning requests for the same ticket produce exactly one planning.generate job",
    async () => {
      const ticketNumber = await submitFreshTicket("va-jobs-platform", "WF-11 idempotent approval");
      const ticket = await queryOne("select id, status from tickets where ticket_number = $1", [ticketNumber]);
      const ticketId = ticket.id;

      await waitFor(async () => (await queryOne("select status from tickets where id = $1", [ticketId])).status === "Submitted", {
        timeoutMs: 10000,
      });
      await api(session, "GET", `/api/admin/tickets/${ticketId}`);
      await waitFor(async () => (await queryOne("select status from tickets where id = $1", [ticketId])).status === "Triage", {
        timeoutMs: 10000,
      });

      // Fire both requests without awaiting either individually first, so
      // they race against each other in the app/worker.
      const [r1, r2] = await Promise.all([
        apiJson(session, "POST", `/api/admin/tickets/${ticketId}/approve-planning`, {}),
        apiJson(session, "POST", `/api/admin/tickets/${ticketId}/approve-planning`, {}),
      ]);

      // At least one of the two racing calls must succeed (both may, if the
      // second is treated as a no-op / returns the existing job).
      expect([r1.status, r2.status].some((s) => s < 300), `both approve-planning calls failed: ${r1.status} ${r2.status}`).toBe(
        true,
      );

      // Give the app a moment to settle any async job-creation path, then
      // assert on the durable jobs table rather than the HTTP responses.
      await waitFor(
        async () => {
          const jobs = await queryAll(
            "select * from jobs where type = $2 and payload_json::text ILIKE $1",
            [`%${ticketId}%`, "planning.generate"],
          );
          return jobs.length >= 1;
        },
        { timeoutMs: 15000 },
      );

      const jobs = await queryAll("select * from jobs where type = $2 and payload_json::text ILIKE $1", [
        `%${ticketId}%`,
        "planning.generate",
      ]);

      expect(jobs.length, `expected exactly one planning.generate job for ticket ${ticketId}, found ${jobs.length}`).toBe(1);
      expect(jobs[0].idempotency_key, "job must carry a non-null idempotency_key").toBeTruthy();
    },
    30000,
  );
});
