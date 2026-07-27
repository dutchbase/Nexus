// WF-05 (validation failure blocks commit/push/PR) and WF-06 (repair attempt
// receives plan + diff + failed validation output) — see prd.md §20.5-20.7,
// §28.7-28.8.
//
// ASSUMPTIONS made where the harness contract is undocumented (see the
// identical header block in plan-revision.spec.ts for the fuller rationale
// on #1-3; repeated here briefly):
//
// 1. Public submission body is a flat JSON object mapped onto `tickets`
//    columns (no seeded `form_fields` rows exist to define a field_key
//    contract).
// 2. Submitted -> Triage is driven via `PATCH /api/admin/tickets/{id}`
//    with `{ status: "Triage" }` (no dedicated route in PRD §29.3).
// 3. Per-job mock-claude scenario wiring: admin routes that create a job
//    accept an extra `mock_scenario_path` body field forwarded into the
//    job's `payload_json.mock_scenario_path`.
// 4. `POST /api/admin/runs/{id}/repair` takes the FAILED execution's
//    `agent_runs.id` (the run whose validation failed), with body
//    `{ feedback, mock_scenario_path }`.
// 5. `prompt_snapshots.phase` for a repair run is assumed to contain the
//    substring "repair" (queried with `ilike '%repair%'` rather than an
//    exact-match guess).
// 6. `.lint-should-fail` must be visible inside the ISOLATED execution
//    worktree the app creates, not just the main fixture checkout — an
//    untracked/gitignored file written only to FIXTURE_REPO_BILLING_API's
//    root would NOT appear in a `git worktree add`-created worktree (each
//    worktree has its own independent working-tree contents; only committed
//    content at the checked-out ref is shared). Per PRD §20.2 the worker
//    isolates execution via a Git worktree, so this file force-adds
//    (bypassing .gitignore) and COMMITS the marker onto the fixture repo's
//    default branch before triggering execution, then removes it with a
//    follow-up commit in afterAll. This mutates that one fixture's commit
//    log for the duration of this test file only — harmless, since
//    run-evals.sh recreates every git fixture from scratch
//    (`create-fixtures.sh --clean`) at the start of every eval run.
//
// `data/` root: not read directly in this file — `execution_attempts
// .worktree_path` is read straight from Postgres instead of being
// reconstructed from a guessed `data/worktrees/{project}/{ticket}/{n}`
// path, since the DB column is authoritative.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, unlinkSync, writeFileSync, appendFileSync } from "fs";
import * as path from "path";
import { execSync } from "child_process";
import {
  login,
  apiJson,
  ticketByNumber,
  queryOne,
  queryAll,
  writeMockClaudeScenario,
  DEFAULT_PLAN_MARKDOWN,
  dumpMockGithub,
  waitFor,
  type Session,
} from "../helpers";

const PROJECT_SLUG = "billing-api";
const FIXTURE_REPO_BILLING_API = process.env.FIXTURE_REPO_BILLING_API;
if (!FIXTURE_REPO_BILLING_API) {
  throw new Error("FIXTURE_REPO_BILLING_API not set — run harness/git-fixtures/create-fixtures.sh first");
}
const LINT_MARKER_PATH = path.join(FIXTURE_REPO_BILLING_API, ".lint-should-fail");
const GIT = (cmd: string) => execSync(`git ${cmd}`, { cwd: FIXTURE_REPO_BILLING_API, stdio: "pipe" });

// Commits (force-adding past .gitignore) so the marker is part of HEAD when
// the worker's `git worktree add` captures the checkout state — see
// assumption #6 above for why a plain untracked write isn't enough.
function commitLintMarker(present: boolean) {
  if (present) {
    writeFileSync(LINT_MARKER_PATH, "");
    GIT(`add -f .lint-should-fail`);
    GIT(`commit -m "eval: force lint failure"`);
  } else if (existsSync(LINT_MARKER_PATH)) {
    execSync(`rm -f .lint-should-fail`, { cwd: FIXTURE_REPO_BILLING_API });
    GIT(`add -A`);
    GIT(`commit -m "eval: clear forced lint failure"`);
  }
}

async function submitTicket(projectSlug: string, title: string) {
  const res = await apiJson(null, "POST", "/api/public/forms/website-feedback/submissions", {
    project_slug: projectSlug,
    title,
    description: "Created by execution-validation.spec.ts (WF-05/WF-06).",
    category: "Bug",
    priority: "high",
    submitter_name: "harness-bot",
    submitter_email: "harness@example.invalid",
  });
  expect(res.status, `ticket submission failed: ${res.status} ${res.text}`).toBeLessThan(300);
  const ticket = res.json?.ticket ?? res.json;
  expect(ticket?.ticket_number, `submission response missing ticket_number: ${res.text}`).toBeTruthy();
  return ticket.ticket_number as string;
}

async function moveToTriage(session: Session, ticketId: string) {
  const res = await apiJson(session, "PATCH", `/api/admin/tickets/${ticketId}`, { status: "Triage" });
  expect(res.status, `Submitted -> Triage failed: ${res.status} ${res.text}`).toBeLessThan(300);
}

async function approvePlanning(session: Session, ticketId: string, scenarioPath: string) {
  const res = await apiJson(session, "POST", `/api/admin/tickets/${ticketId}/approve-planning`, {
    mock_scenario_path: scenarioPath,
  });
  expect(res.status, `approve-planning failed: ${res.status} ${res.text}`).toBeLessThan(300);
}

async function approvePlanVersion(session: Session, planVersionId: string) {
  const res = await apiJson(session, "POST", `/api/admin/plan-versions/${planVersionId}/approve`, {});
  expect(res.status, `plan-version approve failed: ${res.status} ${res.text}`).toBeLessThan(300);
}

async function driveTicketToPlanApproved(session: Session, projectSlug: string, titlePrefix: string) {
  const ticketNumber = await submitTicket(projectSlug, `${titlePrefix} ${Date.now()}`);
  const ticketRow = await ticketByNumber(ticketNumber);
  await moveToTriage(session, ticketRow.id);

  const planScenario = writeMockClaudeScenario({ mode: "plan_valid", plan_markdown: DEFAULT_PLAN_MARKDOWN });
  await approvePlanning(session, ticketRow.id, planScenario);

  await waitFor(async () => (await ticketByNumber(ticketNumber)).status === "Plan Ready for Review", { timeoutMs: 30000 });

  const plan = await queryOne(
    "select p.* from plans p join tickets t on t.id = p.ticket_id where t.ticket_number = $1",
    [ticketNumber],
  );
  const v1 = await queryOne("select * from plan_versions where plan_id = $1 and version = 1", [plan.id]);
  await approvePlanVersion(session, v1.id);

  await waitFor(async () => (await ticketByNumber(ticketNumber)).status === "Plan Approved", { timeoutMs: 15000 });

  return ticketNumber;
}

describe("WF-05 / WF-06 execution validation and repair", () => {
  let session: Session;
  let ticketNumber: string;
  let ticketId: string;
  let executionAttempt: any;
  let executionAgentRun: any;

  beforeAll(async () => {
    session = await login();
    commitLintMarker(false); // defensive reset, in case a prior run left one committed

    ticketNumber = await driveTicketToPlanApproved(session, PROJECT_SLUG, "Execution validation harness case");
    const ticketRow = await ticketByNumber(ticketNumber);
    ticketId = ticketRow.id;

    // Force validation to fail: the app's execution worktree for this
    // project must observe scripts/lint.sh exiting 1 (see git-fixtures'
    // scripts/lint.sh, which checks for this exact marker file). Committed
    // onto the fixture repo's HEAD so `git worktree add` carries it into the
    // new isolated worktree — see assumption #6 at the top of this file.
    commitLintMarker(true);

    const execScenario = writeMockClaudeScenario({
      mode: "exec_stream",
      events: [{ type: "turn", turn_index: 0 }, { type: "result", subtype: "success" }],
      exit_code: 0,
    });
    const execRes = await apiJson(session, "POST", `/api/admin/tickets/${ticketId}/execute`, {
      mock_scenario_path: execScenario,
    });
    expect(execRes.status, `execute failed: ${execRes.status} ${execRes.text}`).toBeLessThan(300);

    await waitFor(async () => (await ticketByNumber(ticketNumber)).status === "Validation Failed", { timeoutMs: 45000 });

    executionAttempt = await queryOne(
      "select * from execution_attempts where ticket_id = $1 order by attempt_number desc limit 1",
      [ticketId],
    );
    expect(executionAttempt, "no execution_attempts row found").toBeTruthy();
    executionAgentRun = await queryOne("select * from agent_runs where id = $1", [executionAttempt.agent_run_id]);
    expect(executionAgentRun, "no agent_runs row for the execution attempt").toBeTruthy();
  }, 90000);

  afterAll(() => {
    commitLintMarker(false);
  });

  it("WF-05: validation failure blocks PR creation, preserves worktree and logs", async () => {
    const ticket = await ticketByNumber(ticketNumber);
    expect(ticket.status).toBe("Validation Failed");

    const branchName: string | null = executionAttempt.branch_name;
    const dump = await dumpMockGithub();
    const allPrs: any[] = Object.values(dump ?? {}).flat() as any[];
    const prsForBranch = allPrs.filter((pr) => !branchName || pr.head?.ref === branchName);
    expect(prsForBranch, "a PR was created for a ticket whose validation failed").toHaveLength(0);

    const dbPrs = await queryAll("select * from pull_requests where execution_attempt_id = $1", [executionAttempt.id]);
    expect(dbPrs).toHaveLength(0);

    expect(executionAttempt.worktree_path, "execution_attempts.worktree_path not set").toBeTruthy();
    expect(existsSync(executionAttempt.worktree_path), `worktree missing on disk at ${executionAttempt.worktree_path}`).toBe(true);

    const events = await queryAll("select * from agent_run_events where agent_run_id = $1 order by sequence", [executionAgentRun.id]);
    expect(events.length).toBeGreaterThan(0);
  });

  it("WF-06: repair attempt prompt includes the approved plan, worktree diff and failed validation output", async () => {
    // Produce a real, distinguishable diff in the (still-preserved) failed
    // worktree so we can assert the repair prompt actually embeds the diff
    // content rather than just a section header.
    const diffMarker = `repair-diff-marker-${Date.now()}`;
    appendFileSync(path.join(executionAttempt.worktree_path, "README.md"), `\n<!-- ${diffMarker} -->\n`);

    // Remove the lint marker so the repair attempt can actually succeed
    // (otherwise it would fail validation again and this test would need to
    // loop indefinitely waiting for a repair that can never pass). The
    // repair attempt reuses this SAME worktree (it's a repair of the
    // existing execution_attempt, not a fresh one per PRD §20.7), so the
    // marker must be removed from the worktree's own checked-out files
    // directly -- resetting the origin repo's HEAD (commitLintMarker(false))
    // would only affect a future NEW worktree, not this already-checked-out
    // one.
    const worktreeMarkerPath = path.join(executionAttempt.worktree_path, ".lint-should-fail");
    if (existsSync(worktreeMarkerPath)) unlinkSync(worktreeMarkerPath);
    commitLintMarker(false); // also reset origin HEAD, for hygiene / any future attempt

    const repairScenario = writeMockClaudeScenario({
      mode: "exec_stream",
      events: [{ type: "turn", turn_index: 0 }, { type: "result", subtype: "success" }],
      exit_code: 0,
    });
    const repairRes = await apiJson(session, "POST", `/api/admin/runs/${executionAgentRun.id}/repair`, {
      feedback: "Fix the lint failure and retry.",
      mock_scenario_path: repairScenario,
    });
    expect(repairRes.status, `repair failed: ${repairRes.status} ${repairRes.text}`).toBeLessThan(300);

    let snapshot: any;
    await waitFor(async () => {
      snapshot = await queryOne(
        "select * from prompt_snapshots where ticket_id = $1 and phase ilike '%repair%' order by created_at desc limit 1",
        [ticketId],
      );
      return !!snapshot;
    }, { timeoutMs: 30000 });

    expect(snapshot.content, "repair prompt missing approved plan content").toContain("Mock plan for eval purposes.");
    expect(snapshot.content, "repair prompt missing the worktree diff").toContain(diffMarker);
    expect(snapshot.content, "repair prompt missing the failed validation output").toContain("forced failure via .lint-should-fail marker");
  }, 60000);
});
