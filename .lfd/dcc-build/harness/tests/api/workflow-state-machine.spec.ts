// Implements eval case WF-01 (see harness/eval-cases.json).
//
// Mock-Claude scenario integration mechanism chosen for this whole harness
// (see HARNESS_CONVENTIONS.md "Mock-Claude scenarios"): the JOB-PAYLOAD
// mechanism, not the env-var mechanism. apps/web's admin endpoints that
// create a planning/execution job (approve-planning, execute, ...) must
// accept an optional test-only body field `mock_scenario_path` and copy it
// into the created job's `payload_json.mock_scenario_path`; apps/worker
// resolves MOCK_CLAUDE_SCENARIO for that job from the payload field,
// falling back to the ambient env var only when absent. This is required
// because the worker is a long-lived process shared across every test in
// the run, so an env var set once at process start cannot vary per-test.
// Every file in this harness that drives a planning/execution job assumes
// this same mechanism.
//
// Undocumented-route assumption (see final report): PRD §29.3 lists no
// dedicated "open triage" or "approve ticket" endpoint distinct from
// approve-planning. This test assumes:
//   - GET /api/admin/tickets/{id} performs the "Administrator opens triage"
//     transition (Submitted -> Triage) as a side effect of the admin
//     viewing the ticket.
//   - POST /api/admin/tickets/{id}/approve-planning performs BOTH the
//     "Ticket approved" (Triage -> Approved for Planning) transition AND
//     immediately creates the planning job ("Planning job created":
//     Approved for Planning -> Planning Queued), writing two
//     ticket_status_history rows.
//
// mock-claude never writes real files to the worktree (it only prints
// canned stdout), so this test writes a trivial real change into the
// worker-created worktree itself once the run reaches "Executing" (same
// technique harness/tests/api/secret-scan.spec.ts and
// execution-validation.spec.ts use) -- simulating what a real Claude
// execution session would have produced. This avoids freezing in any
// assumption about whether the app accepts an empty diff (a reasonable
// implementation might legitimately reject one), so the execution->PR->
// merge portion of this test exercises a genuine, validation-passable diff.

import { describe, it, expect, beforeAll } from "vitest";
import { existsSync, appendFileSync } from "fs";
import { join } from "path";
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
  sha256,
  githubControl,
  resetMockGithub,
  type Session,
} from "../helpers";

async function submitFreshTicket(projectSlug: string, title: string) {
  const project = await queryOne("select id from projects where slug = $1", [projectSlug]);
  if (!project) throw new Error(`fixture project ${projectSlug} not found`);
  const res = await fetch(`${process.env.APP_BASE_URL ?? "http://127.0.0.1:3000"}/api/public/forms/website-feedback/submissions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      project_id: project.id,
      title,
      description: "Filed by workflow-state-machine.spec.ts (WF-01).",
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
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`ticket submission failed: ${res.status} ${text}`);
  const ticket = json.ticket ?? json;
  const ticketNumber: string = ticket.ticket_number ?? ticket.ticketNumber;
  if (!ticketNumber) throw new Error(`submission response had no ticket_number: ${text}`);
  return ticketNumber;
}

// Waits for (and returns) the ticket_status_history row recording the exact
// previous->new transition. History rows are append-only, so polling for a
// specific row (rather than the ticket's live current status) is robust
// against the worker racing ahead to later statuses before we get to poll.
async function waitForTransition(
  ticketId: string,
  previousStatus: string | null,
  newStatus: string,
  timeoutMs = 20000,
) {
  let row: any = null;
  await waitFor(
    async () => {
      row = await queryOne(
        previousStatus === null
          ? `select * from ticket_status_history where ticket_id = $1 and previous_status is null and new_status = $2 order by created_at desc limit 1`
          : `select * from ticket_status_history where ticket_id = $1 and previous_status = $2 and new_status = $3 order by created_at desc limit 1`,
        previousStatus === null ? [ticketId, newStatus] : [ticketId, previousStatus, newStatus],
      );
      return !!row;
    },
    { timeoutMs },
  );
  return row;
}

describe("WF-01: full happy path", () => {
  let session: Session;

  beforeAll(async () => {
    session = await login();
    await resetMockGithub();
  });

  it(
    "drives a fresh ticket end-to-end from Submitted to Completed, writing a correct ticket_status_history row at every step",
    async () => {
      // ---- Submitted --------------------------------------------------
      const ticketNumber = await submitFreshTicket("va-jobs-platform", "WF-01 happy path ticket");
      const ticket0 = await ticketByNumber(ticketNumber);
      expect(ticket0).toBeTruthy();
      const ticketId = ticket0.id;
      expect(ticket0.status).toBe("Submitted");
      await waitForTransition(ticketId, null, "Submitted");

      // ---- Triage -------------------------------------------------------
      const detail = await api(session, "GET", `/api/admin/tickets/${ticketId}`);
      expect(detail.ok).toBe(true);
      await waitFor(async () => (await ticketByNumber(ticketNumber)).status === "Triage", { timeoutMs: 10000 });
      await waitForTransition(ticketId, "Submitted", "Triage");

      // ---- Approved for Planning -> Planning Queued ----------------------
      const planScenarioPath = writeMockClaudeScenario({ mode: "plan_valid", plan_markdown: DEFAULT_PLAN_MARKDOWN });
      const approveRes = await apiJson(session, "POST", `/api/admin/tickets/${ticketId}/approve-planning`, {
        mock_scenario_path: planScenarioPath,
      });
      expect(approveRes.status, `approve-planning failed: ${approveRes.text}`).toBeLessThan(300);

      const approvedRow = await waitForTransition(ticketId, "Triage", "Approved for Planning");
      expect(approvedRow.actor_type).toBeTruthy();

      const queuedRow = await waitForTransition(ticketId, "Approved for Planning", "Planning Queued");
      expect(queuedRow.related_job_id, "Planning Queued transition should reference the planning.generate job").toBeTruthy();
      const planningJob = await queryOne("select * from jobs where id = $1", [queuedRow.related_job_id]);
      expect(planningJob?.type).toBe("planning.generate");

      // ---- Planning -------------------------------------------------------
      const planningRow = await waitForTransition(ticketId, "Planning Queued", "Planning", 20000);
      expect(planningRow.related_run_id, "Planning transition should reference the planning agent_run").toBeTruthy();
      const planningRun = await queryOne("select * from agent_runs where id = $1", [planningRow.related_run_id]);
      expect(planningRun).toBeTruthy();

      // ---- Plan Ready for Review -------------------------------------------
      const planReadyRow = await waitForTransition(ticketId, "Planning", "Plan Ready for Review", 20000);
      const planVersion = await queryOne(
        `select pv.* from plan_versions pv join plans p on pv.plan_id = p.id where p.ticket_id = $1 order by pv.version desc limit 1`,
        [ticketId],
      );
      expect(planVersion).toBeTruthy();
      expect(planVersion.content_markdown).toBe(DEFAULT_PLAN_MARKDOWN);
      expect(planVersion.content_hash).toBe(sha256(DEFAULT_PLAN_MARKDOWN));
      if (planReadyRow.related_plan_version_id) {
        expect(planReadyRow.related_plan_version_id).toBe(planVersion.id);
      }

      // ---- Plan Approved ----------------------------------------------------
      const approvePlanRes = await apiJson(session, "POST", `/api/admin/plan-versions/${planVersion.id}/approve`, {
        plan_version_id: planVersion.id,
        content_hash: planVersion.content_hash,
      });
      expect(approvePlanRes.status, `plan approval failed: ${approvePlanRes.text}`).toBeLessThan(300);
      const planApprovedRow = await waitForTransition(ticketId, "Plan Ready for Review", "Plan Approved");
      expect(planApprovedRow.related_plan_version_id).toBe(planVersion.id);

      const ticketAfterApproval = await ticketByNumber(ticketNumber);
      expect(ticketAfterApproval.approved_plan_version_id).toBe(planVersion.id);

      // ---- Execution Queued ---------------------------------------------
      const execScenarioPath = writeMockClaudeScenario({
        mode: "exec_stream",
        events: [
          { type: "turn", turn_index: 0 },
          { type: "tool_use", tool: "read", path: "README.md" },
          { type: "turn", turn_index: 1 },
        ],
        exit_code: 0,
      });
      const executeRes = await apiJson(session, "POST", `/api/admin/tickets/${ticketId}/execute`, {
        mock_scenario_path: execScenarioPath,
      });
      expect(executeRes.status, `execute failed: ${executeRes.text}`).toBeLessThan(300);
      const execQueuedRow = await waitForTransition(ticketId, "Plan Approved", "Execution Queued");
      expect(execQueuedRow.related_job_id, "Execution Queued transition should reference the execution job").toBeTruthy();

      // ---- Executing --------------------------------------------------------
      const executingRow = await waitForTransition(ticketId, "Execution Queued", "Executing", 20000);
      expect(executingRow.related_run_id, "Executing transition should reference the execution agent_run").toBeTruthy();

      // Write a trivial real change into the worker-created worktree so
      // validation has an actual diff to work with (see file-level comment).
      // execution_attempts.worktree_path is a documented PRD §26 column, so
      // this doesn't guess the data/ root convention.
      const attempt = await queryOne(
        "select * from execution_attempts where ticket_id = $1 order by created_at desc limit 1",
        [ticketId],
      );
      if (attempt?.worktree_path) {
        await waitFor(async () => existsSync(attempt.worktree_path), { timeoutMs: 15000 });
        appendFileSync(join(attempt.worktree_path, "README.md"), "\n<!-- WF-01 eval touch -->\n");
      }

      // ---- Validating -----------------------------------------------------
      const validatingRow = await waitForTransition(ticketId, "Executing", "Validating", 20000);
      expect(validatingRow).toBeTruthy();

      // ---- PR Ready for Review --------------------------------------------
      const prReadyRow = await waitForTransition(ticketId, "Validating", "PR Ready for Review", 20000);
      expect(prReadyRow.related_pull_request_id, "PR Ready for Review transition should reference the pull_requests row").toBeTruthy();
      const pr = await queryOne("select * from pull_requests where id = $1", [prReadyRow.related_pull_request_id]);
      expect(pr).toBeTruthy();
      expect(pr.ticket_id).toBe(ticketId);

      const project = await queryOne("select github_owner, github_repository from projects where id = $1", [ticket0.project_id]);

      // ---- simulate external GitHub PR approval ----------------------------
      const reviewRes = await githubControl(
        "POST",
        `/_control/repos/${project.github_owner}/${project.github_repository}/pulls/${pr.number}/review`,
        { state: "approved" },
      );
      expect(reviewRes.status).toBe(200);

      // The app must observe the external review via its own sync mechanism
      // (webhook or poll) and record an internal "PR Approved" transition.
      const prApprovedRow = await waitForTransition(ticketId, "PR Ready for Review", "PR Approved", 20000);
      expect(prApprovedRow.related_pull_request_id).toBe(pr.id);

      // ---- simulate external merge ------------------------------------------
      const mergeRes = await githubControl(
        "POST",
        `/_control/repos/${project.github_owner}/${project.github_repository}/pulls/${pr.number}/merge`,
        { merge_method: "squash" },
      );
      expect(mergeRes.status).toBe(200);

      const mergedRow = await waitForTransition(ticketId, "PR Approved", "Merged", 20000);
      expect(mergedRow.related_pull_request_id).toBe(pr.id);

      const completedRow = await waitForTransition(ticketId, "Merged", "Completed", 20000);
      expect(completedRow).toBeTruthy();

      const finalTicket = await ticketByNumber(ticketNumber);
      expect(finalTicket.status).toBe("Completed");

      // ---- every automatic transition fired exactly once ----------------
      const history = await queryAll(
        "select previous_status, new_status from ticket_status_history where ticket_id = $1 order by created_at asc",
        [ticketId],
      );
      const seenPairs = history.map((h) => `${h.previous_status ?? "null"}->${h.new_status}`);
      const expectedPairs = [
        "null->Submitted",
        "Submitted->Triage",
        "Triage->Approved for Planning",
        "Approved for Planning->Planning Queued",
        "Planning Queued->Planning",
        "Planning->Plan Ready for Review",
        "Plan Ready for Review->Plan Approved",
        "Plan Approved->Execution Queued",
        "Execution Queued->Executing",
        "Executing->Validating",
        "Validating->PR Ready for Review",
        "PR Ready for Review->PR Approved",
        "PR Approved->Merged",
        "Merged->Completed",
      ];
      for (const pair of expectedPairs) {
        expect(seenPairs.filter((p) => p === pair).length, `expected exactly one ${pair} transition, saw: ${seenPairs.join(", ")}`).toBe(1);
      }
    },
    120000,
  );
});
