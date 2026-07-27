// DET-08, OPS-04
//
// Covers PRD §13.7 (skill resolution = global mandatory + project automatic +
// ticket-selected + phase-required, deduped by ID) and §28.3 (a missing or
// disabled skill blocks the run and identifies itself).
//
// ---------------------------------------------------------------------------
// ASSUMPTIONS THE EXECUTION AGENT MUST MATCH:
//
// 1. `PUT /api/admin/tickets/{id}/skills` body shape. PRD §29.7 lists the
//    route but not its payload shape, and HARNESS_CONVENTIONS.md says field
//    names not fixed by a §26 table column are the implementation's choice.
//    We send the skill id under three plausible keys at once
//    (`skill_ids`, `skills`, `skill_slugs`) so the request works regardless
//    of which one the app reads; harmless extra fields are assumed ignored.
//
// 2. Bundle materialization happens for the PLANNING run too, not only
//    execution — PRD §18.3's conceptual planning command already includes
//    `--add-dir "$SKILL_BUNDLE_DIR"`. DET-08 therefore only needs to run
//    planning (not execution) to inspect the resolved/deduped bundle on
//    disk at `data/skill-bundles/{planning-run-id}/.claude/skills/`.
//
// 3. Filesystem/data roots: same `DCC_SKILLS_ROOT` / `DCC_DATA_ROOT`
//    convention as skill-snapshot-immutability.spec.ts.
//
// 4. Project/ticket setup, Triage and mock-claude wiring mirror
//    prompt-determinism.spec.ts (see that file's header comment for the full
//    rationale): submit via the `website-feedback` form with `project_id` /
//    `project_slug` both set to va-jobs-platform so its automatic skills
//    (ponytail, project-conventions, secure-development, testing-standards)
//    are in play, matching the task's guidance to use va-jobs-platform's
//    skill set; `GET` the ticket then `approve-planning`, falling back to
//    `PATCH {status:"Triage"}` first if that's rejected.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { existsSync, readdirSync } from "node:fs";
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
const DATA_ROOT = process.env.DCC_DATA_ROOT ?? process.cwd();

const SKILL_IDS = {
  ponytail: "00000000-0000-0000-0001-000000000001",
  projectConventions: "00000000-0000-0000-0001-000000000002",
  secureDevelopment: "00000000-0000-0000-0001-000000000003",
  testingStandards: "00000000-0000-0000-0001-000000000004",
  deploymentRules: "00000000-0000-0000-0001-000000000013", // enabled: false in seed.sql
};

async function createTicketOnVaJobsPlatform(titleSuffix: string) {
  const res = await apiJson(null, "POST", "/api/public/forms/website-feedback/submissions", {
    project_id: VA_JOBS_PLATFORM_PROJECT_ID,
    project_slug: VA_JOBS_PLATFORM_SLUG,
    title: `DCC harness skill-resolution probe ${titleSuffix}`,
    description: "Synthetic ticket used by the eval harness to verify skill resolution. Do not action.",
    category: "Bug",
    priority: "medium",
    submitter_name: "harness-bot",
    submitter_email: "harness-bot@example.com",
    source_url: `https://harness.example.invalid/skill-resolution-${titleSuffix}`,
    environment: "eval-harness",
    expected_behavior: "Skill resolution is correct.",
    actual_behavior: "n/a",
    reproduction_steps: "n/a",
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

describe("skill-resolution", () => {
  it(
    "resolved and deduped skill set matches the bundle on disk",
    async () => {
      const session = await login();
      const ticket = await createTicketOnVaJobsPlatform("DET-08");

      // Manually select a skill that is ALSO already automatic for this
      // project, to exercise dedup-by-ID across two resolution sources.
      const putRes = await apiJson(session, "PUT", `/api/admin/tickets/${ticket.id}/skills`, {
        skill_ids: [SKILL_IDS.projectConventions],
        skills: [SKILL_IDS.projectConventions],
        skill_slugs: ["project-conventions"],
      });
      expect(putRes.ok, `ticket-skills PUT failed: ${putRes.status} ${putRes.text}`).toBe(true);

      const planScenario = writeMockClaudeScenario({ mode: "plan_valid", plan_markdown: DEFAULT_PLAN_MARKDOWN });
      const planRes = await approveForPlanning(session, ticket.id, planScenario);
      expect(planRes.ok, `approve-planning failed: ${planRes.status} ${planRes.text}`).toBe(true);

      const planningRun = await waitFor(
        async () =>
          !!(await queryOne("select id from agent_runs where ticket_id = $1 and run_type = 'planning'", [ticket.id])),
        { timeoutMs: 60000 },
      ).then(() =>
        queryOne(
          "select * from agent_runs where ticket_id = $1 and run_type = 'planning' order by started_at desc limit 1",
          [ticket.id],
        ),
      );
      expect(planningRun, "expected a planning agent_runs row").toBeTruthy();

      const bundleSkillsDir = path.join(DATA_ROOT, "data", "skill-bundles", planningRun.id, ".claude", "skills");
      await waitFor(async () => existsSync(bundleSkillsDir), { timeoutMs: 30000 });

      const bundleEntries = readdirSync(bundleSkillsDir).sort();
      const expectedSlugs = ["ponytail", "project-conventions", "secure-development", "testing-standards"].sort();

      expect(
        bundleEntries,
        `expected exactly the resolved+deduped skill set on disk, got: ${JSON.stringify(bundleEntries)}`,
      ).toEqual(expectedSlugs);

      // project-conventions must appear exactly once, not as e.g. a
      // "project-conventions-2" duplicate directory from a buggy dedup.
      const projectConventionsMatches = bundleEntries.filter((e) => e.startsWith("project-conventions"));
      expect(projectConventionsMatches.length).toBe(1);

      // DB-level dedup check: skill_snapshots.skills_json (created at plan
      // approval, PRD §13.8) must also contain no duplicate skill ids.
      const planVersion = await waitFor(
        async () =>
          !!(await queryOne(
            "select pv.id from plan_versions pv join plans p on p.id = pv.plan_id where p.ticket_id = $1",
            [ticket.id],
          )),
        { timeoutMs: 60000 },
      ).then(() =>
        queryOne(
          "select pv.* from plan_versions pv join plans p on p.id = pv.plan_id where p.ticket_id = $1 order by pv.version desc limit 1",
          [ticket.id],
        ),
      );
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
      expect(skillSnapshot, "expected a skill_snapshots row").toBeTruthy();

      const skillsJson = skillSnapshot.skills_json;
      const idsOrSlugs: string[] = (Array.isArray(skillsJson) ? skillsJson : []).map(
        (entry: any) => entry.slug ?? entry.skill_id ?? entry.id,
      );
      expect(idsOrSlugs.length, `expected 4 resolved skills, got: ${JSON.stringify(skillsJson)}`).toBe(4);
      expect(new Set(idsOrSlugs).size, `expected no duplicate skill ids/slugs in skills_json: ${JSON.stringify(skillsJson)}`).toBe(
        idsOrSlugs.length,
      );
    },
    180000,
  );

  it(
    "missing or disabled skill blocks the run and names it",
    async () => {
      const session = await login();
      const ticket = await createTicketOnVaJobsPlatform("OPS-04");

      const putRes = await apiJson(session, "PUT", `/api/admin/tickets/${ticket.id}/skills`, {
        skill_ids: [SKILL_IDS.deploymentRules],
        skills: [SKILL_IDS.deploymentRules],
        skill_slugs: ["deployment-rules"],
      });

      let blockingText = "";
      if (!putRes.ok) {
        blockingText = putRes.text;
      } else {
        const planScenario = writeMockClaudeScenario({ mode: "plan_valid", plan_markdown: DEFAULT_PLAN_MARKDOWN });
        const approveRes = await approveForPlanning(session, ticket.id, planScenario);
        expect(
          approveRes.ok,
          "expected the run to be blocked (non-2xx) when a disabled skill is selected on the ticket",
        ).toBe(false);
        blockingText = approveRes.text;
      }

      expect(
        blockingText.toLowerCase().includes("deployment-rules"),
        `expected the blocking error to name the specific skill slug "deployment-rules", got: ${blockingText}`,
      ).toBe(true);
    },
    60000,
  );
});
