// WF-07 (idempotent PR creation — no duplicate PR for an existing head
// branch) and WF-08 (push failure preserves the local commit, retry doesn't
// re-invoke Claude) — see prd.md §20.2, §21.1-21.3, §28.9-28.10.
//
// ASSUMPTIONS made where the harness contract is undocumented (see the
// identical header block in plan-revision.spec.ts for the fuller rationale
// on #1-3; repeated here briefly):
//
// 1. Public submission body is a flat JSON object mapped onto `tickets`
//    columns.
// 2. Submitted -> Triage is driven via `PATCH /api/admin/tickets/{id}`
//    with `{ status: "Triage" }`.
// 3. Per-job mock-claude scenario wiring: admin routes that create a job
//    accept an extra `mock_scenario_path` body field.
// 4. `POST /api/admin/runs/{id}/retry` takes the failed execution's
//    `agent_runs.id`. No `mock_scenario_path` is supplied for it — per PRD
//    §28.9 ("do not rerun Claude") retry should only redo the git push, so
//    deliberately not priming a scenario turns "Claude got invoked again"
//    into an observable signal in MOCK_CLAUDE_LOG rather than a silent pass.
// 5. WF-07's race: mock-github's `POST /repos/:owner/:repo/pulls` never
//    rejects a duplicate head branch (see harness/mock-github/server.js —
//    it always allocates a new PR number), so pre-creating a PR there
//    cannot itself force the app into a 409/422 path. This test instead
//    relies on `pull_requests` (this app's own table, filtered by
//    `execution_attempt_id`) as the source of truth for "did the app avoid
//    creating a duplicate", per HARNESS_CONVENTIONS.md's "or the app's own
//    pull_requests DB table" alternative — that check is race-free by
//    construction (it only reflects what the app itself inserted,
//    regardless of whether our manual mock-github PR landed before or
//    after the app's own attempt). The `dumpMockGithub()` cross-check here
//    is best-effort and can't be made non-racy without an app-side hook.
// 6. WF-08's push-failure ticket status: PRD §17.1 has no distinct "push
//    failed" status; §17.2's transition table shows only one failure
//    target from `Validating`, "PR Creation Failed" — assumed to cover
//    both push and PR-API failures (§21.1 treats stage/commit/push/create-PR
//    as one worker-controlled sequence).
// 7. The bare remote path is read via `git -C <repo> remote get-url origin`
//    rather than a `FIXTURE_REMOTE_*` env var, since only `FIXTURE_REPO_*`
//    is documented as guaranteed-set for test processes.

import { describe, it, expect, beforeAll } from "vitest";
import { statSync, chmodSync } from "fs";
import { execSync } from "child_process";
import {
  login,
  apiJson,
  ticketByNumber,
  queryOne,
  queryAll,
  writeMockClaudeScenario,
  DEFAULT_PLAN_MARKDOWN,
  readMockClaudeLog,
  dumpMockGithub,
  githubControl,
  waitFor,
  type Session,
} from "../helpers";

async function submitTicket(projectSlug: string, title: string) {
  const res = await apiJson(null, "POST", "/api/public/forms/website-feedback/submissions", {
    project_slug: projectSlug,
    title,
    description: "Created by pr-creation.spec.ts (WF-07/WF-08).",
    category: "Bug",
    priority: "medium",
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

  return { ticketNumber, ticketId: ticketRow.id as string };
}

function trivialExecScenario() {
  return writeMockClaudeScenario({
    mode: "exec_stream",
    events: [{ type: "turn", turn_index: 0 }, { type: "result", subtype: "success" }],
    exit_code: 0,
  });
}

describe("WF-07 idempotent PR creation", () => {
  let session: Session;

  beforeAll(async () => {
    session = await login();
  });

  it("does not create a duplicate PR when one already exists for the execution's head branch", async () => {
    const project = await queryOne("select * from projects where slug = $1", ["va-jobs-platform"]);
    const { ticketNumber, ticketId } = await driveTicketToPlanApproved(session, "va-jobs-platform", "PR idempotency harness case");

    const execRes = await apiJson(session, "POST", `/api/admin/tickets/${ticketId}/execute`, {
      mock_scenario_path: trivialExecScenario(),
    });
    expect(execRes.status, `execute failed: ${execRes.status} ${execRes.text}`).toBeLessThan(300);

    // Race the app to the head branch: pre-create a PR against mock-github
    // for the exact branch name the app is about to push, simulating "a PR
    // already exists for this branch" (PRD §28.10 retry-idempotency path).
    let attempt: any;
    await waitFor(async () => {
      attempt = await queryOne(
        "select * from execution_attempts where ticket_id = $1 order by attempt_number desc limit 1",
        [ticketId],
      );
      return !!attempt?.branch_name;
    }, { timeoutMs: 20000, intervalMs: 100 });

    const preemptive = await githubControl("POST", `/repos/${project.github_owner}/${project.github_repository}/pulls`, {
      title: `Preemptive PR for ${attempt.branch_name}`,
      body: "Created directly against mock-github by pr-creation.spec.ts to simulate an already-existing PR for this branch.",
      head: attempt.branch_name,
      base: project.default_branch,
      draft: true,
    });
    expect(preemptive.status).toBe(201);

    await waitFor(async () => {
      const t = await ticketByNumber(ticketNumber);
      return t.status === "PR Ready for Review" || t.status === "PR Creation Failed";
    }, { timeoutMs: 45000 });

    const finalAttempt = await queryOne("select * from execution_attempts where id = $1", [attempt.id]);
    const dbPrs = await queryAll("select * from pull_requests where execution_attempt_id = $1", [finalAttempt.id]);
    expect(dbPrs, "app created zero or more than one pull_requests row for a single execution attempt").toHaveLength(1);

    const dump = await dumpMockGithub();
    const repoKey = `${project.github_owner}/${project.github_repository}`;
    const reposPrs: any[] = dump?.[repoKey] ?? [];
    const matchingForBranch = reposPrs.filter((pr) => pr.head?.ref === finalAttempt.branch_name);
    expect(matchingForBranch.length, "no PR exists on mock-github for the execution's head branch at all").toBeGreaterThanOrEqual(1);
    expect(
      matchingForBranch.some((pr) => pr.number === dbPrs[0].number),
      "the app's stored pull_requests row does not correspond to any real mock-github PR for this branch",
    ).toBe(true);
  }, 90000);
});

describe("WF-08 push failure preserves the local commit and retry doesn't re-invoke Claude", () => {
  let session: Session;

  beforeAll(async () => {
    session = await login();
  });

  it("recovers from a push failure via retry without a new Claude session", async () => {
    const FIXTURE_REPO_CORPORATE_SITE = process.env.FIXTURE_REPO_CORPORATE_SITE;
    if (!FIXTURE_REPO_CORPORATE_SITE) {
      throw new Error("FIXTURE_REPO_CORPORATE_SITE not set — run harness/git-fixtures/create-fixtures.sh first");
    }
    const remotePath = execSync("git remote get-url origin", { cwd: FIXTURE_REPO_CORPORATE_SITE }).toString().trim();
    const objectsDir = `${remotePath}/objects`;
    const originalMode = statSync(objectsDir).mode & 0o777;

    const { ticketNumber, ticketId } = await driveTicketToPlanApproved(session, "corporate-site", "Push failure harness case");

    chmodSync(objectsDir, 0o555); // read+execute only: git push can no longer write new objects
    let executionAttempt: any;
    let executionAgentRun: any;
    try {
      const execRes = await apiJson(session, "POST", `/api/admin/tickets/${ticketId}/execute`, {
        mock_scenario_path: trivialExecScenario(),
      });
      expect(execRes.status, `execute failed: ${execRes.status} ${execRes.text}`).toBeLessThan(300);

      // Wait until the worker has committed locally (per §28.9 "preserve
      // local commit") even though the push to the read-only remote fails.
      await waitFor(async () => {
        executionAttempt = await queryOne(
          "select * from execution_attempts where ticket_id = $1 order by attempt_number desc limit 1",
          [ticketId],
        );
        return !!executionAttempt?.result_commit;
      }, { timeoutMs: 60000 });

      executionAgentRun = await queryOne("select * from agent_runs where id = $1", [executionAttempt.agent_run_id]);
      expect(executionAgentRun?.working_directory, "execution agent_run has no working_directory (worktree) recorded").toBeTruthy();

      const worktreeLog = execSync("git log --oneline -1", { cwd: executionAttempt.worktree_path }).toString().trim();
      expect(worktreeLog, "no local commit found in the worktree after a failed push").not.toBe("");

      const ticketAfterFailedPush = await ticketByNumber(ticketNumber);
      expect(ticketAfterFailedPush.status).toBe("PR Creation Failed");

      const prsBeforeRetry = await queryAll("select * from pull_requests where execution_attempt_id = $1", [executionAttempt.id]);
      expect(prsBeforeRetry, "a PR was created despite the push failing").toHaveLength(0);
    } finally {
      chmodSync(objectsDir, originalMode);
    }

    const claudeInvocationsForWorktree = () =>
      readMockClaudeLog().filter((entry) => entry.cwd === executionAgentRun.working_directory).length;
    const invocationsBeforeRetry = claudeInvocationsForWorktree();

    const retryRes = await apiJson(session, "POST", `/api/admin/runs/${executionAgentRun.id}/retry`, {});
    expect(retryRes.status, `retry failed: ${retryRes.status} ${retryRes.text}`).toBeLessThan(300);

    await waitFor(async () => {
      const t = await ticketByNumber(ticketNumber);
      return t.status === "PR Ready for Review";
    }, { timeoutMs: 45000 });

    const invocationsAfterRetry = claudeInvocationsForWorktree();
    expect(invocationsAfterRetry, "Claude was re-invoked for this worktree during a retry that should only redo the git push").toBe(invocationsBeforeRetry);

    const prsAfterRetry = await queryAll("select * from pull_requests where execution_attempt_id = $1", [executionAttempt.id]);
    expect(prsAfterRetry).toHaveLength(1);
  }, 120000);
});
