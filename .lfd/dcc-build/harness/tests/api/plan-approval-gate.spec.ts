// Implements eval cases WF-03 and WF-04 (see harness/eval-cases.json).
//
// Mock-Claude scenario mechanism: job-payload field (`mock_scenario_path` in
// the request body of any admin call that creates a planning/execution
// job), NOT the env-var mechanism. See the header comment in
// workflow-state-machine.spec.ts for the full rationale; every file in this
// harness that drives a job follows this same convention.
//
// Undocumented-contract assumptions this file makes (see final report):
//   - Same triage/approval route assumptions as workflow-state-machine.spec.ts:
//     GET /api/admin/tickets/{id} performs Submitted -> Triage; POST
//     .../approve-planning performs Triage -> Approved for Planning AND
//     creates the planning job in one call.
//   - POST /api/admin/plan-versions/{id}/approve's body carries
//     { plan_version_id, content_hash } (snake_case, matching the plan_versions
//     column names) even though the target id is already in the URL --- WF-03's
//     description explicitly requires the approval call to carry both values.
//   - PRD §26 lists no explicit "potentially_stale" column on `plans` or
//     `plan_versions`, even though PRD §19.4 requires the plan to be
//     flagged `potentially_stale` after the ticket changes. This is a real
//     gap between the narrative spec and the literal schema table. Rather
//     than hardcode a guessed column name, WF-04's staleness assertion
//     below discovers candidate columns at runtime via information_schema
//     and asserts one of them changed value across the PATCH. The execution
//     agent must add whatever column/mechanism satisfies this - report as a
//     goal.md note.

import { describe, it, expect, beforeAll } from "vitest";
import {
  login,
  api,
  apiJson,
  queryOne,
  queryAll,
  ticketByNumber,
  writeMockClaudeScenario,
  DEFAULT_PLAN_MARKDOWN,
  waitFor,
  type Session,
} from "../helpers";

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
      description: "Filed by plan-approval-gate.spec.ts.",
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

async function waitForStatus(ticketId: string, status: string, timeoutMs = 20000) {
  await waitFor(async () => (await queryOne("select status from tickets where id = $1", [ticketId])).status === status, {
    timeoutMs,
  });
}

// Drives a fresh ticket to Plan Approved and returns the approved plan_version row.
async function driveTicketToPlanApproved(session: Session, projectSlug: string, title: string) {
  const ticketNumber = await submitFreshTicket(projectSlug, title);
  const ticket = await ticketByNumber(ticketNumber);
  const ticketId = ticket.id;

  await waitForStatus(ticketId, "Submitted");
  await api(session, "GET", `/api/admin/tickets/${ticketId}`);
  await waitForStatus(ticketId, "Triage");

  const scenarioPath = writeMockClaudeScenario({ mode: "plan_valid", plan_markdown: DEFAULT_PLAN_MARKDOWN });
  const approveRes = await apiJson(session, "POST", `/api/admin/tickets/${ticketId}/approve-planning`, {
    mock_scenario_path: scenarioPath,
  });
  if (approveRes.status >= 300) throw new Error(`approve-planning failed: ${approveRes.text}`);

  await waitForStatus(ticketId, "Plan Ready for Review", 20000);

  const planVersion = await queryOne(
    `select pv.* from plan_versions pv join plans p on pv.plan_id = p.id where p.ticket_id = $1 order by pv.version desc limit 1`,
    [ticketId],
  );
  return { ticketId, ticketNumber, planVersion };
}

async function jobsForTicket(ticketId: string, type?: string) {
  const rows = await queryAll(
    type
      ? "select * from jobs where type = $2 and payload_json::text ILIKE $1 order by created_at"
      : "select * from jobs where payload_json::text ILIKE $1 order by created_at",
    type ? [`%${ticketId}%`, type] : [`%${ticketId}%`],
  );
  return rows;
}

describe("WF-03: execution blocked without approval, allowed after hash-matched approval", () => {
  let session: Session;

  beforeAll(async () => {
    session = await login();
  });

  it(
    "rejects execute with no approved plan and creates no execution job",
    async () => {
      const { ticketId } = await driveTicketToPlanApproved(session, "va-jobs-platform", "WF-03 no-approval gate");

      const jobsBefore = await jobsForTicket(ticketId);
      const executionJobsBefore = jobsBefore.filter((j) => String(j.type).startsWith("execution."));

      const blockedRes = await apiJson(session, "POST", `/api/admin/tickets/${ticketId}/execute`, {});
      expect(blockedRes.status, "execute without an approved plan must be rejected").toBeGreaterThanOrEqual(400);
      expect(blockedRes.status).toBeLessThan(500);

      const jobsAfter = await jobsForTicket(ticketId);
      const executionJobsAfter = jobsAfter.filter((j) => String(j.type).startsWith("execution."));
      expect(executionJobsAfter.length, "no execution job row should be created by a rejected execute call").toBe(
        executionJobsBefore.length,
      );
    },
    30000,
  );

  it(
    "allows execute once the exact plan_version has been approved, and the resulting execution references it",
    async () => {
      const { ticketId, planVersion } = await driveTicketToPlanApproved(session, "va-jobs-platform", "WF-03 approval unblocks");

      const approveRes = await apiJson(session, "POST", `/api/admin/plan-versions/${planVersion.id}/approve`, {
        plan_version_id: planVersion.id,
        content_hash: planVersion.content_hash,
      });
      expect(approveRes.status, `plan approval failed: ${approveRes.text}`).toBeLessThan(300);

      const execScenarioPath = writeMockClaudeScenario({
        mode: "exec_stream",
        events: [{ type: "turn", turn_index: 0 }],
        exit_code: 0,
      });
      const executeRes = await apiJson(session, "POST", `/api/admin/tickets/${ticketId}/execute`, {
        mock_scenario_path: execScenarioPath,
      });
      expect(executeRes.status, `execute should succeed once plan is approved: ${executeRes.text}`).toBeLessThan(300);

      let attempt: any = null;
      await waitFor(
        async () => {
          attempt = await queryOne("select * from execution_attempts where ticket_id = $1 order by created_at desc limit 1", [
            ticketId,
          ]);
          return !!attempt;
        },
        { timeoutMs: 20000 },
      );

      expect(attempt.plan_version_id, "execution_attempts row must reference the exact approved plan_version id").toBe(
        planVersion.id,
      );
      const referencedPlanVersion = await queryOne("select content_hash from plan_versions where id = $1", [
        attempt.plan_version_id,
      ]);
      expect(referencedPlanVersion.content_hash, "referenced plan_version's hash must match the approved hash").toBe(
        planVersion.content_hash,
      );
    },
    30000,
  );
});

describe("WF-04: ticket edit after approval marks plan stale and blocks execution", () => {
  let session: Session;

  beforeAll(async () => {
    session = await login();
  });

  it(
    "flags the approved plan potentially_stale, blocks execute, and unblocks after explicit reconfirmation",
    async () => {
      const { ticketId, planVersion } = await driveTicketToPlanApproved(session, "va-jobs-platform", "WF-04 staleness gate");

      const approveRes = await apiJson(session, "POST", `/api/admin/plan-versions/${planVersion.id}/approve`, {
        plan_version_id: planVersion.id,
        content_hash: planVersion.content_hash,
      });
      expect(approveRes.status, `plan approval failed: ${approveRes.text}`).toBeLessThan(300);

      // Snapshot every column on the plan/plan_version rows before the edit,
      // so we can detect whichever column the execution agent uses to track
      // staleness without hardcoding a guessed name (see file header comment).
      const beforePlanVersion = await queryOne("select * from plan_versions where id = $1", [planVersion.id]);
      const plan = await queryOne("select * from plans where id = $1", [beforePlanVersion.plan_id]);

      const patchRes = await apiJson(session, "PATCH", `/api/admin/tickets/${ticketId}`, {
        description: "Updated description to invalidate the approved plan (WF-04).",
      });
      expect(patchRes.status, `ticket PATCH failed: ${patchRes.text}`).toBeLessThan(300);

      const afterPlanVersion = await queryOne("select * from plan_versions where id = $1", [planVersion.id]);
      const afterPlan = await queryOne("select * from plans where id = $1", [beforePlanVersion.plan_id]);

      const changedColumns = [
        ...Object.keys(beforePlanVersion).filter(
          (k) => JSON.stringify(beforePlanVersion[k]) !== JSON.stringify(afterPlanVersion[k]),
        ),
        ...Object.keys(plan).filter((k) => JSON.stringify(plan[k]) !== JSON.stringify(afterPlan[k])),
      ];
      expect(
        changedColumns.length,
        `expected some column on plans/plan_versions to change after the ticket edit to reflect potentially_stale ` +
          `(no column changed; before(plan_versions)=${JSON.stringify(beforePlanVersion)}, after=${JSON.stringify(afterPlanVersion)}, ` +
          `before(plans)=${JSON.stringify(plan)}, after=${JSON.stringify(afterPlan)})`,
      ).toBeGreaterThan(0);

      // Execution must now be blocked with a message about reconfirmation.
      const blockedExecRes = await apiJson(session, "POST", `/api/admin/tickets/${ticketId}/execute`, {});
      expect(blockedExecRes.status, "execute must be blocked while the plan is potentially_stale").toBeGreaterThanOrEqual(400);
      expect(blockedExecRes.status).toBeLessThan(500);
      const blockMessage = JSON.stringify(blockedExecRes.json ?? blockedExecRes.text).toLowerCase();
      expect(
        /reconfirm|re-confirm|stale|valid/.test(blockMessage),
        `blocked execute response should mention reconfirmation/staleness, got: ${blockMessage}`,
      ).toBe(true);

      // Reconfirm via the plan-version approve endpoint again (defensible
      // interpretation of "administrator explicitly confirms the plan
      // remains valid", per PRD §19.4 -- no dedicated confirm route exists
      // in PRD §29.4).
      const versionCountBefore = (
        await queryAll("select id from plan_versions where plan_id = $1", [beforePlanVersion.plan_id])
      ).length;

      const reconfirmRes = await apiJson(session, "POST", `/api/admin/plan-versions/${planVersion.id}/approve`, {
        plan_version_id: planVersion.id,
        content_hash: planVersion.content_hash,
        reconfirm: true,
      });
      expect(reconfirmRes.status, `reconfirmation approve failed: ${reconfirmRes.text}`).toBeLessThan(300);

      const versionCountAfter = (
        await queryAll("select id from plan_versions where plan_id = $1", [beforePlanVersion.plan_id])
      ).length;
      expect(versionCountAfter, "reconfirming must not create a new plan version").toBe(versionCountBefore);

      const unblockedExecScenarioPath = writeMockClaudeScenario({
        mode: "exec_stream",
        events: [{ type: "turn", turn_index: 0 }],
        exit_code: 0,
      });
      const unblockedExecRes = await apiJson(session, "POST", `/api/admin/tickets/${ticketId}/execute`, {
        mock_scenario_path: unblockedExecScenarioPath,
      });
      expect(unblockedExecRes.status, `execute should succeed after reconfirmation: ${unblockedExecRes.text}`).toBeLessThan(300);
    },
    30000,
  );
});
