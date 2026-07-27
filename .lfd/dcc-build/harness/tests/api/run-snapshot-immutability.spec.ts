// DET-09
//
// Covers PRD §4.5 ("every run must preserve ... exact project configuration
// version") and §12.6 ("once a run begins, the model and reasoning level are
// saved in the run snapshot. Changing the ticket settings later must not
// affect an active or completed run") applied to the project's
// `config_version` specifically.
//
// ---------------------------------------------------------------------------
// ASSUMPTIONS THE EXECUTION AGENT MUST MATCH:
//
// Neither `agent_runs` nor `prompt_snapshots` has a literal `config_version`
// column per PRD §26.1 — only `project_id`. The pinned config version this
// case is about must therefore live in `metadata_json` on one of those rows
// (HARNESS_CONVENTIONS.md: field names not fixed by a §26 column are the
// implementation's choice). We search `metadata_json` recursively for the
// first key that looks like a config-version reference:
//   - a key matching /config.*version/i (excluding ones ending in "...id")
//     holding a number/string -> used directly, or
//   - a key matching /config.*version.*id/i holding a string -> treated as a
//     foreign key into `project_config_versions.id`, whose `version` column
//     is then read.
// If neither is found anywhere in either row's metadata_json, the test fails
// outright (not skipped) with the metadata dumped, per the same
// "genuine failure, not a skip" policy used in prompt-determinism.spec.ts.
//
// Ticket creation / Triage / mock-claude wiring mirror the other files in
// this batch (see prompt-determinism.spec.ts's header comment for the full
// rationale): submit via the `website-feedback` form with `project_id` /
// `project_slug` both set to va-jobs-platform; `GET` the ticket then
// `approve-planning`, falling back to `PATCH {status:"Triage"}` first if
// that's rejected.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
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

async function createTicketOnVaJobsPlatform() {
  const res = await apiJson(null, "POST", "/api/public/forms/website-feedback/submissions", {
    project_id: VA_JOBS_PLATFORM_PROJECT_ID,
    project_slug: VA_JOBS_PLATFORM_SLUG,
    title: "DCC harness run-snapshot immutability probe",
    description: "Synthetic ticket used by the eval harness to verify run config_version pinning. Do not action.",
    category: "Bug",
    priority: "medium",
    submitter_name: "harness-bot",
    submitter_email: "harness-bot@example.com",
    source_url: "https://harness.example.invalid/det-09",
    environment: "eval-harness",
    expected_behavior: "Runs pin the exact project config_version.",
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

function deepFindConfigVersionRef(obj: any): { kind: "direct" | "id"; value: string | number } | null {
  if (!obj || typeof obj !== "object") return null;

  for (const [k, v] of Object.entries(obj)) {
    if (/config.*version/i.test(k) && !/id$/i.test(k) && (typeof v === "number" || typeof v === "string")) {
      return { kind: "direct", value: v };
    }
  }
  for (const [k, v] of Object.entries(obj)) {
    if (/config.*version.*id/i.test(k) && typeof v === "string") {
      return { kind: "id", value: v };
    }
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object") {
      const nested = deepFindConfigVersionRef(v);
      if (nested) return nested;
    }
  }
  return null;
}

async function resolvePinnedConfigVersion(metadataJson: any): Promise<string | number> {
  const ref = deepFindConfigVersionRef(metadataJson ?? {});
  if (!ref) {
    throw new Error(
      `could not find a config-version-shaped key anywhere in metadata_json: ${JSON.stringify(metadataJson)}`,
    );
  }
  if (ref.kind === "direct") return ref.value;
  const row = await queryOne("select version from project_config_versions where id = $1", [ref.value]);
  if (!row) {
    throw new Error(`metadata_json referenced project_config_versions.id=${ref.value} but no such row exists`);
  }
  return row.version;
}

describe("run-snapshot-immutability", () => {
  it(
    "run pins its exact config version",
    async () => {
      const session = await login();
      const ticket = await createTicketOnVaJobsPlatform();

      const projectBefore = await queryOne("select * from projects where id = $1", [VA_JOBS_PLATFORM_PROJECT_ID]);
      expect(projectBefore).toBeTruthy();

      const scenario = writeMockClaudeScenario({ mode: "plan_valid", plan_markdown: DEFAULT_PLAN_MARKDOWN });
      const planRes = await approveForPlanning(session, ticket.id, scenario);
      expect(planRes.ok, `approve-planning failed: ${planRes.status} ${planRes.text}`).toBe(true);

      const run = await waitFor(
        async () =>
          !!(await queryOne("select id from agent_runs where ticket_id = $1 and run_type = 'planning'", [ticket.id])),
        { timeoutMs: 60000 },
      ).then(() =>
        queryOne(
          "select * from agent_runs where ticket_id = $1 and run_type = 'planning' order by started_at desc limit 1",
          [ticket.id],
        ),
      );
      expect(run, "expected a planning agent_runs row").toBeTruthy();

      const snapshot = await queryOne("select * from prompt_snapshots where ticket_id = $1 order by created_at asc limit 1", [
        ticket.id,
      ]);
      expect(snapshot, "expected a prompt_snapshots row").toBeTruthy();

      const pinnedBefore = await resolvePinnedConfigVersion(run.metadata_json ?? snapshot.metadata_json);
      expect(pinnedBefore, "expected a resolvable pinned config_version before mutation").toBeTruthy();
      expect(String(pinnedBefore)).toBe(String(projectBefore.config_version));

      // Mutate the project's configuration — any trivial field change that
      // would bump config_version, per the task brief.
      const patchRes = await apiJson(session, "PATCH", `/api/admin/projects/${VA_JOBS_PLATFORM_PROJECT_ID}`, {
        description: `DET-09 config bump ${Date.now()}`,
      });
      expect(patchRes.ok, `project PATCH failed: ${patchRes.status} ${patchRes.text}`).toBe(true);

      const projectAfter = await waitFor(
        async () => {
          const row = await queryOne("select config_version from projects where id = $1", [VA_JOBS_PLATFORM_PROJECT_ID]);
          return row && String(row.config_version) !== String(projectBefore.config_version);
        },
        { timeoutMs: 30000 },
      ).then(() => queryOne("select * from projects where id = $1", [VA_JOBS_PLATFORM_PROJECT_ID]));

      expect(
        String(projectAfter.config_version),
        "expected the project's config_version to change after the PATCH",
      ).not.toBe(String(projectBefore.config_version));

      // Re-fetch the SAME already-completed run/snapshot rows and confirm
      // their pinned config_version did NOT move with the project's.
      const runAfter = await queryOne("select * from agent_runs where id = $1", [run.id]);
      const snapshotAfter = await queryOne("select * from prompt_snapshots where id = $1", [snapshot.id]);

      const pinnedAfter = await resolvePinnedConfigVersion(runAfter.metadata_json ?? snapshotAfter.metadata_json);
      expect(String(pinnedAfter)).toBe(String(pinnedBefore));
      expect(
        String(pinnedAfter),
        "the already-completed run must NOT have picked up the project's new config_version",
      ).not.toBe(String(projectAfter.config_version));
    },
    120000,
  );
});
