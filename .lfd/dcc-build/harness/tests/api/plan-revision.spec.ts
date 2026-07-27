// WF-02 (plan revision resumes the original Claude session) and DET-07 (v1
// plan file on disk is immutable across a revision) — see prd.md §18.4-18.5,
// §19.2-19.4 and harness/HARNESS_CONVENTIONS.md.
//
// ASSUMPTIONS made where the harness contract is undocumented (flagged for
// goal.md — see this file's header comment block, repeated in the other two
// spec files):
//
// 1. POST /api/public/forms/{slug}/submissions accepts a flat JSON body
//    (project_slug, title, description, category, priority, submitter_name,
//    submitter_email, ...) mapped directly onto `tickets` columns. seed.sql
//    seeds no `form_fields` rows for `website-feedback`, so there is no
//    field_key contract to follow instead.
// 2. The "administrator opens triage" transition (Submitted -> Triage, PRD
//    §17.2) has no dedicated route in §29.3, so it's driven here via
//    `PATCH /api/admin/tickets/{id}` with `{ status: "Triage" }`.
// 3. Per-job mock-claude scenario wiring: HARNESS_CONVENTIONS.md leaves this
//    an open app-level choice (env var vs. job payload field). Since
//    apps/worker is a long-lived process started once by run-evals.sh before
//    any test runs, a single `MOCK_CLAUDE_SCENARIO` env var can't be swapped
//    per job from inside a test. This file assumes the documented
//    `payload_json.mock_scenario_path` mechanism is exposed to admin route
//    callers as an extra `mock_scenario_path` body field, which the route
//    forwards into the created job's payload.
// 4. `POST /api/admin/plans/{id}/request-revision` takes the parent `plans`
//    row id (not a `plan_versions` id) and a body of
//    `{ feedback, mock_scenario_path }`.
//
// `data/` root: resolved as `process.cwd()/data` (repo-root-relative),
// overridable via `DCC_DATA_ROOT` — no such env var is documented in
// HARNESS_CONVENTIONS.md, this is purely this test file's own guess for
// where to read `data/tickets/{n}/plans/v{v}.md` from disk.

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "fs";
import * as path from "path";
import {
  login,
  apiJson,
  ticketByNumber,
  queryOne,
  queryAll,
  writeMockClaudeScenario,
  DEFAULT_PLAN_MARKDOWN,
  waitFor,
  type Session,
} from "../helpers";

const DATA_ROOT = process.env.DCC_DATA_ROOT ?? path.resolve(process.cwd(), "data");
const PROJECT_SLUG = "va-jobs-platform";

async function submitTicket(projectSlug: string, title: string) {
  const res = await apiJson(null, "POST", "/api/public/forms/website-feedback/submissions", {
    project_slug: projectSlug,
    title,
    description: "Created by plan-revision.spec.ts (WF-02/DET-07).",
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

type Ctx = {
  ticketNumber: string;
  ticketId: string;
  planId: string;
  originalSessionId: string;
  v1BeforeBytes: Buffer;
  v1AfterBytes: Buffer;
  v1Path: string;
  versionsAfterRevision: any[];
  ticketStatusAfterRevision: string;
};

describe("WF-02 / DET-07 plan revision", () => {
  let session: Session;
  const ctx: Partial<Ctx> = {};

  beforeAll(async () => {
    session = await login();

    // --- Drive a fresh ticket to Plan Ready for Review with a v1 plan. ---
    const ticketNumber = await submitTicket(PROJECT_SLUG, `Plan revision harness case ${Date.now()}`);
    const ticketRow = await ticketByNumber(ticketNumber);
    await moveToTriage(session, ticketRow.id);

    const v1ScenarioPath = writeMockClaudeScenario({
      mode: "plan_valid",
      plan_markdown: DEFAULT_PLAN_MARKDOWN,
    });
    await approvePlanning(session, ticketRow.id, v1ScenarioPath);

    await waitFor(async () => {
      const t = await ticketByNumber(ticketNumber);
      return t.status === "Plan Ready for Review";
    }, { timeoutMs: 30000 });

    // --- Locate the plans/plan_versions/agent_runs rows for v1. ---
    const plan = await queryOne(
      "select p.* from plans p join tickets t on t.id = p.ticket_id where t.ticket_number = $1",
      [ticketNumber],
    );
    expect(plan, "no plans row found for ticket after planning completed").toBeTruthy();

    const v1 = await queryOne("select * from plan_versions where plan_id = $1 and version = 1", [plan.id]);
    expect(v1, "no plan_versions v1 row found").toBeTruthy();

    const planningRun = await queryOne("select * from agent_runs where id = $1", [v1.agent_run_id]);
    expect(planningRun?.claude_session_id, "planning agent_run has no claude_session_id").toBeTruthy();

    // Cross-check plans.planning_session_id against agent_runs.claude_session_id
    // when the former is populated — both are candidate "session to resume"
    // fields per prd.md §26; they should agree.
    if (plan.planning_session_id) {
      expect(plan.planning_session_id).toBe(planningRun.claude_session_id);
    }
    const originalSessionId: string = plan.planning_session_id ?? planningRun.claude_session_id;

    // DET-07 "before" snapshot.
    const v1Path = path.join(DATA_ROOT, "tickets", ticketNumber, "plans", "v1.md");
    const v1BeforeBytes = readFileSync(v1Path);

    // --- Write a revision scenario that refuses (exit 3) unless the app
    // resumes the exact same Claude session used for v1. This is the core
    // WF-02 assertion: it happens inside the mock, not via a test-side check. ---
    const v2Scenario = writeMockClaudeScenario({
      mode: "plan_valid",
      session_id_expected: originalSessionId,
      plan_markdown: DEFAULT_PLAN_MARKDOWN + "\n<!-- v2 revision marker -->\n",
    });

    const revisionRes = await apiJson(session, "POST", `/api/admin/plans/${plan.id}/request-revision`, {
      feedback: "Please add more detail to section 7 (Proposed Changes).",
      mock_scenario_path: v2Scenario,
    });
    expect(revisionRes.status, `request-revision failed: ${revisionRes.status} ${revisionRes.text}`).toBeLessThan(300);

    await waitFor(async () => {
      const versions = await queryAll("select * from plan_versions where plan_id = $1 order by version", [plan.id]);
      return versions.length >= 2;
    }, { timeoutMs: 30000 });

    // Diagnostic: if the revision agent_run failed because the mock refused
    // a session mismatch, surface that clearly instead of a bare timeout.
    const revisionRun = await queryOne(
      "select * from agent_runs where ticket_id = $1 and run_type = 'plan_revision' order by started_at desc limit 1",
      [ticketRow.id],
    );
    expect(revisionRun?.error_code, "revision run failed with session_id_mismatch — app did not resume the original Claude session").not.toBe("session_id_mismatch");

    const versionsAfterRevision = await queryAll("select * from plan_versions where plan_id = $1 order by version", [plan.id]);
    const ticketAfterRevision = await ticketByNumber(ticketNumber);
    const v1AfterBytes = readFileSync(v1Path);

    Object.assign(ctx, {
      ticketNumber,
      ticketId: ticketRow.id,
      planId: plan.id,
      originalSessionId,
      v1BeforeBytes,
      v1AfterBytes,
      v1Path,
      versionsAfterRevision,
      ticketStatusAfterRevision: ticketAfterRevision.status,
    } satisfies Ctx);
  }, 60000);

  it("WF-02: resumes the original planning session and stores a new plan_versions v2 row", () => {
    expect(ctx.versionsAfterRevision).toHaveLength(2);
    const [v1, v2] = ctx.versionsAfterRevision!;
    expect(v1.version).toBe(1);
    expect(v2.version).toBe(2);
    expect(v2.content_markdown).toContain("v2 revision marker");
    expect(v2.content_markdown).not.toBe(v1.content_markdown);
    expect(v2.content_hash).not.toBe(v1.content_hash);
    expect(ctx.ticketStatusAfterRevision).toBe("Plan Ready for Review");
  });

  it("DET-07: data/tickets/{n}/plans/v1.md is byte-identical before and after the revision", () => {
    expect(ctx.v1AfterBytes!.equals(ctx.v1BeforeBytes!), `v1.md at ${ctx.v1Path} changed after revision`).toBe(true);
  });
});
