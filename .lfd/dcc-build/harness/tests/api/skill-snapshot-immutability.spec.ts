// DET-06
//
// Covers PRD §13.8 (skill snapshots are immutable once a plan is approved)
// and §13.9 (the run-specific bundle at data/skill-bundles/{run-id}/.claude/skills/
// is a copy/symlink of the *exact selected skill versions* at snapshot time).
//
// ---------------------------------------------------------------------------
// ASSUMPTIONS THE EXECUTION AGENT MUST MATCH:
//
// 1. Filesystem roots. `skills.filesystem_path` (e.g.
//    `skills/projects/va-jobs-platform/project-conventions/SKILL.md`) is a
//    path relative to the app's own repo root, not an absolute path. This
//    file resolves it against `process.env.DCC_SKILLS_ROOT` if set, else
//    against `process.cwd()` at test-run time (the harness assumes tests are
//    invoked from the app repo root, matching how `data/tickets/{...}` paths
//    in §18.5 and `data/skill-bundles/{...}` in §13.9 are also given as
//    repo-relative). Likewise `data/skill-bundles/{run-id}/...` is resolved
//    against `process.env.DCC_DATA_ROOT` if set, else `process.cwd()`. If
//    the execution agent puts these directories somewhere else, set
//    DCC_SKILLS_ROOT / DCC_DATA_ROOT when running the eval — that is the
//    intended escape hatch, not a harness bug.
//
// 2. Mutation ordering. The whole point of DET-06 is to catch an
//    implementation that re-reads the live SKILL.md file when it later
//    materializes a run's bundle, instead of using the content captured at
//    snapshot time. So this test mutates the on-disk file AFTER the plan
//    approval (which creates the skill_snapshot per §13.8) but BEFORE
//    triggering the execution run that materializes the bundle (§13.9) — not
//    after. A test that mutated the file only after the bundle already
//    existed would prove nothing.
//
// 3. Ticket creation / project assignment / Triage / mock-claude wiring use
//    the same conventions as prompt-determinism.spec.ts (see that file's
//    header comment for the full rationale, cross-referencing several
//    sibling spec files in this batch): submit via the `website-feedback`
//    form with both `project_id` and `project_slug` set to va-jobs-platform
//    (so its automatic skills — ponytail, project-conventions,
//    secure-development, testing-standards — apply), `GET` the ticket then
//    `approve-planning` (falling back to `PATCH {status:"Triage"}` first if
//    that's rejected), and pass `mock_scenario_path` in the body of any call
//    that creates a job.
// ---------------------------------------------------------------------------

import { describe, it, expect, afterAll } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import {
  login,
  apiJson,
  queryOne,
  writeMockClaudeScenario,
  DEFAULT_PLAN_MARKDOWN,
  waitFor,
  ticketByNumber,
  type Session,
} from "../helpers";

const VA_JOBS_PLATFORM_PROJECT_ID = "00000000-0000-0000-0000-000000000001";
const VA_JOBS_PLATFORM_SLUG = "va-jobs-platform";
const SKILLS_ROOT = process.env.DCC_SKILLS_ROOT ?? process.cwd();
const DATA_ROOT = process.env.DCC_DATA_ROOT ?? process.cwd();

async function createTicketOnVaJobsPlatform(fields: Record<string, unknown>) {
  const res = await apiJson(null, "POST", "/api/public/forms/website-feedback/submissions", {
    project_id: VA_JOBS_PLATFORM_PROJECT_ID,
    project_slug: VA_JOBS_PLATFORM_SLUG,
    ...fields,
  });
  if (!res.ok) throw new Error(`ticket submission failed: ${res.status} ${res.text}`);
  const envelope = (res.json && (res.json.ticket ?? res.json.data?.ticket ?? res.json.data ?? res.json)) ?? {};
  const ticketNumber: string | undefined = envelope.ticket_number ?? envelope.ticketNumber;
  if (!ticketNumber) throw new Error(`submission response had no recognizable ticket_number: ${res.text}`);
  const row = await ticketByNumber(ticketNumber);
  if (!row) throw new Error(`ticket ${ticketNumber} not found in DB after submission`);
  return row;
}

async function approveForPlanning(session: Session, ticketId: string, scenarioPath: string) {
  await apiJson(session, "GET", `/api/admin/tickets/${ticketId}`);
  let res = await apiJson(session, "POST", `/api/admin/tickets/${ticketId}/approve-planning`, {
    mock_scenario_path: scenarioPath,
  });
  if (!res.ok) {
    await apiJson(session, "PATCH", `/api/admin/tickets/${ticketId}`, { status: "Triage" });
    res = await apiJson(session, "POST", `/api/admin/tickets/${ticketId}/approve-planning`, {
      mock_scenario_path: scenarioPath,
    });
  }
  return res;
}

async function waitForLatestPlanVersion(ticketId: string) {
  await waitFor(
    async () => {
      const row = await queryOne(
        "select pv.id from plan_versions pv join plans p on p.id = pv.plan_id where p.ticket_id = $1",
        [ticketId],
      );
      return !!row;
    },
    { timeoutMs: 60000, intervalMs: 300 },
  );
  return queryOne(
    "select pv.* from plan_versions pv join plans p on p.id = pv.plan_id where p.ticket_id = $1 order by pv.version desc limit 1",
    [ticketId],
  );
}

function resolveSkillMdPath(filesystemPath: string): string {
  return path.isAbsolute(filesystemPath) ? filesystemPath : path.join(SKILLS_ROOT, filesystemPath);
}

describe("skill-snapshot-immutability", () => {
  let skillMdPath: string | undefined;
  let originalSkillMd: string | undefined;

  afterAll(() => {
    if (skillMdPath && originalSkillMd !== undefined && existsSync(skillMdPath)) {
      writeFileSync(skillMdPath, originalSkillMd, "utf8");
    }
  });

  it(
    "editing SKILL.md after snapshot does not affect the run",
    async () => {
      const session = await login();
      const ticket = await createTicketOnVaJobsPlatform({
        title: "DCC harness skill-snapshot immutability probe",
        description: "Synthetic ticket used by the eval harness to verify skill snapshot immutability. Do not action.",
        category: "Bug",
        priority: "medium",
        submitter_name: "harness-bot",
        submitter_email: "harness-bot@example.com",
        source_url: "https://harness.example.invalid/det-06",
        environment: "eval-harness",
        expected_behavior: "Skill snapshots are immutable.",
        actual_behavior: "n/a",
        reproduction_steps: "n/a",
      });

      const planScenario = writeMockClaudeScenario({ mode: "plan_valid", plan_markdown: DEFAULT_PLAN_MARKDOWN });
      const planRes = await approveForPlanning(session, ticket.id, planScenario);
      expect(planRes.ok, `approve-planning failed: ${planRes.status} ${planRes.text}`).toBe(true);

      const planVersion = await waitForLatestPlanVersion(ticket.id);
      expect(planVersion, "expected a plan_versions row").toBeTruthy();

      // Plan approval creates the immutable skill_snapshot per PRD §13.8.
      const approveRes = await apiJson(session, "POST", `/api/admin/plan-versions/${planVersion.id}/approve`, {
        plan_version_id: planVersion.id,
        content_hash: planVersion.content_hash,
      });
      expect(approveRes.ok, `plan-version approve failed: ${approveRes.status} ${approveRes.text}`).toBe(true);

      const skillSnapshot = await waitFor(
        async () => !!(await queryOne("select id from skill_snapshots where ticket_id = $1", [ticket.id])),
        { timeoutMs: 30000 },
      ).then(() =>
        queryOne("select * from skill_snapshots where ticket_id = $1 order by created_at desc limit 1", [ticket.id]),
      );
      expect(skillSnapshot, "expected a skill_snapshots row after plan approval").toBeTruthy();

      const skillRow = await queryOne("select * from skills where slug = $1", ["project-conventions"]);
      expect(skillRow, "expected the seeded project-conventions skill to exist").toBeTruthy();

      skillMdPath = resolveSkillMdPath(skillRow.filesystem_path);
      expect(existsSync(skillMdPath), `expected SKILL.md to exist at resolved path ${skillMdPath}`).toBe(true);
      originalSkillMd = readFileSync(skillMdPath, "utf8");

      // Mutate the on-disk skill file AFTER the snapshot but BEFORE the run
      // that materializes the bundle — see header comment #2.
      writeFileSync(skillMdPath, `${originalSkillMd}\n<!-- mutated by DET-06 harness test -->\n`, "utf8");

      const snapshotBeforeMaterialization = await queryOne("select * from skill_snapshots where id = $1", [
        skillSnapshot.id,
      ]);

      const execScenario = writeMockClaudeScenario({
        mode: "exec_stream",
        events: [{ type: "turn", turn_index: 0 }],
        exit_code: 0,
      });
      const execRes = await apiJson(session, "POST", `/api/admin/tickets/${ticket.id}/execute`, {
        mock_scenario_path: execScenario,
      });
      expect(execRes.ok, `execute failed: ${execRes.status} ${execRes.text}`).toBe(true);

      const executionRun = await waitFor(
        async () =>
          !!(await queryOne("select id from agent_runs where ticket_id = $1 and run_type = 'execution'", [ticket.id])),
        { timeoutMs: 60000 },
      ).then(() =>
        queryOne(
          "select * from agent_runs where ticket_id = $1 and run_type = 'execution' order by started_at desc limit 1",
          [ticket.id],
        ),
      );
      expect(executionRun, "expected an execution agent_runs row").toBeTruthy();

      const bundlePath = path.join(
        DATA_ROOT,
        "data",
        "skill-bundles",
        executionRun.id,
        ".claude",
        "skills",
        "project-conventions",
        "SKILL.md",
      );
      await waitFor(async () => existsSync(bundlePath), { timeoutMs: 30000 });

      const bundleContent = readFileSync(bundlePath, "utf8");
      expect(bundleContent).toBe(originalSkillMd);
      expect(bundleContent.includes("mutated by DET-06 harness test")).toBe(false);

      // The DB row itself must not have drifted either, regardless of the
      // on-disk file mutation.
      const snapshotAfter = await queryOne("select * from skill_snapshots where id = $1", [skillSnapshot.id]);
      expect(snapshotAfter.content_hash).toBe(snapshotBeforeMaterialization.content_hash);
      expect(JSON.stringify(snapshotAfter.skills_json)).toBe(JSON.stringify(snapshotBeforeMaterialization.skills_json));
    },
    180000,
  );
});
