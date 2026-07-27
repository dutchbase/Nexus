// Implements eval case WF-10 (see harness/eval-cases.json).
//
// Mock-Claude scenario mechanism: job-payload field (`mock_scenario_path`),
// same convention as ../api/workflow-state-machine.spec.ts.
//
// This is a BEST-EFFORT, purely black-box atomicity check. True
// crash-injection (killing the worker process between the plan_versions
// INSERT and the tickets.status UPDATE inside the planning-completion
// transaction) would require an app-internal hook this harness does not
// have and this file does not invent one. Instead, it drives a real
// planning job to completion and polls the database in a tight loop across
// the completion window, asserting that at every sample the two writes are
// observed together (both present or both absent) -- i.e. it never catches
// the app in a partially-committed state. This can prove a violation if the
// implementation genuinely commits the two writes non-atomically and the
// window is wide enough to be sampled, but a passing run is not a formal
// proof of atomicity, only the absence of an observed violation.
//
// If the execution agent's implementation later exposes a debug/test hook
// for injecting a crash between the two writes, this file may be extended
// to use it for a stronger guarantee -- but per the task brief, no such
// hook is invented here.

import { describe, it, expect, beforeAll } from "vitest";
import { login, api, apiJson, queryOne, writeMockClaudeScenario, DEFAULT_PLAN_MARKDOWN, waitFor, type Session } from "../helpers";

const BASE_URL = process.env.APP_BASE_URL ?? "http://127.0.0.1:3000";
const PRE_COMPLETION_STATUSES = new Set(["Planning Queued", "Planning"]);
const POST_COMPLETION_STATUS = "Plan Ready for Review";

async function submitFreshTicket(projectSlug: string, title: string) {
  const project = await queryOne("select id from projects where slug = $1", [projectSlug]);
  if (!project) throw new Error(`fixture project ${projectSlug} not found`);
  const res = await fetch(`${BASE_URL}/api/public/forms/website-feedback/submissions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      project_id: project.id,
      title,
      description: "Filed by probes/transaction-atomicity.spec.ts (WF-10).",
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

// Single round-trip query so status and plan_versions-existence are read
// from the same DB snapshot (as consistent as this black-box probe can get
// without an app-internal hook).
async function sample(ticketId: string) {
  const row = await queryOne(
    `select t.status as status,
            (select count(*) from plan_versions pv join plans p on pv.plan_id = p.id where p.ticket_id = t.id) as version_count
     from tickets t where t.id = $1`,
    [ticketId],
  );
  return { status: row.status as string, versionCount: Number(row.version_count) };
}

describe("WF-10: plan completion is all-or-nothing", () => {
  let session: Session;

  beforeAll(async () => {
    session = await login();
  });

  it(
    "never observes a plan_versions row without the matching ticket.status update, or vice versa",
    async () => {
      const ticketNumber = await submitFreshTicket("va-jobs-platform", "WF-10 atomicity probe");
      const ticket = await queryOne("select id from tickets where ticket_number = $1", [ticketNumber]);
      const ticketId = ticket.id;

      await waitFor(async () => (await sample(ticketId)).status === "Submitted", { timeoutMs: 10000 });
      await api(session, "GET", `/api/admin/tickets/${ticketId}`);
      await waitFor(async () => (await sample(ticketId)).status === "Triage", { timeoutMs: 10000 });

      const scenarioPath = writeMockClaudeScenario({ mode: "plan_valid", plan_markdown: DEFAULT_PLAN_MARKDOWN });
      const approveRes = await apiJson(session, "POST", `/api/admin/tickets/${ticketId}/approve-planning`, {
        mock_scenario_path: scenarioPath,
      });
      expect(approveRes.status, `approve-planning failed: ${approveRes.text}`).toBeLessThan(300);

      // Tight polling loop across the whole completion window: from
      // immediately after triggering the job, until the ticket reaches
      // Plan Ready for Review (or we time out).
      const samples: { status: string; versionCount: number }[] = [];
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        const s = await sample(ticketId);
        samples.push(s);
        if (s.status === POST_COMPLETION_STATUS) {
          // Take a couple more samples right after completion, then stop.
          samples.push(await sample(ticketId));
          samples.push(await sample(ticketId));
          break;
        }
        await new Promise((r) => setTimeout(r, 25));
      }

      expect(samples.length, "probe collected no samples at all").toBeGreaterThan(0);
      expect(
        samples.some((s) => s.status === POST_COMPLETION_STATUS),
        `planning job never reached ${POST_COMPLETION_STATUS} within the polling window; last sample: ${JSON.stringify(
          samples[samples.length - 1],
        )}`,
      ).toBe(true);

      // The atomicity invariant: while still in a pre-completion status, no
      // plan_versions row should exist yet; once in the post-completion
      // status, a plan_versions row must exist. No sample should show the
      // two writes disagreeing with each other.
      const violations = samples.filter((s) => {
        if (PRE_COMPLETION_STATUSES.has(s.status)) return s.versionCount > 0;
        if (s.status === POST_COMPLETION_STATUS) return s.versionCount === 0;
        return false;
      });

      expect(
        violations,
        `observed ${violations.length} sample(s) where ticket.status and plan_versions existence disagreed: ${JSON.stringify(
          violations,
        )}`,
      ).toEqual([]);
    },
    45000,
  );
});
