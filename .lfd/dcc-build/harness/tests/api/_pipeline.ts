// Shared plumbing for tests/api/*.spec.ts that need to drive a ticket
// through Triage -> Approved for Planning -> Planning -> Plan Ready for
// Review -> Plan Approved -> Execution. NOT a *.spec.ts file itself, so
// score.sh's `for f in tests/api/*.spec.ts` loop never runs it directly —
// it's only ever imported.
//
// This file encodes several assumptions about app internals that are NOT
// pinned by PRD §26 or HARNESS_CONVENTIONS.md and can't be, because the app
// doesn't exist yet. Each is called out below. If the execution agent's
// implementation diverges, the affected assertions in the importing spec
// file are the reportable mismatch — see HARNESS_CONVENTIONS.md's guidance
// on the mock-claude scenario-routing mechanism ("pick whichever
// integration shape apps/worker actually uses... document the chosen
// mechanism") and on not silently adapting the harness to a shortcut.
//
// ASSUMPTION 1 (ticket triage): the admin ticket PATCH route accepts a
// direct `status` transition to "Triage" (Triage is not in PRD §17.3's list
// of statuses that "cannot be manually selected" — only Planning, Executing,
// Validating, PR Ready for Review, Merged are). We PATCH straight to Triage
// before calling approve-planning rather than relying on some UI-only
// "administrator opens triage" side effect that a raw API test can't
// trigger.
//
// ASSUMPTION 2 (mock-claude scenario routing): mock-claude
// (harness/mock-claude/claude) reads `MOCK_CLAUDE_SCENARIO` fresh on every
// invocation from ITS OWN process env — i.e. whatever the worker exports
// into the child process it spawns. run-evals.sh does NOT set
// MOCK_CLAUDE_SCENARIO globally (only MOCK_CLAUDE_LOG, PATH,
// CLAUDE_CODE_OAUTH_TOKEN), so per-job scenario selection has to be a worker
// responsibility, keyed off something per-job. HARNESS_CONVENTIONS.md names
// the candidate mechanism explicitly: `payload_json.mock_scenario_path`,
// dev/test only, grep-probed by SEC-16. Since jobs are created server-side
// by admin actions with no client-controlled payload, and tests have raw DB
// access (see helpers.ts), `routeScenarioToNextJob` below closes that gap
// out-of-band: it polls for the newest still-unclaimed row of the given job
// `type` created after a timestamp and UPDATEs its payload_json to add
// mock_scenario_path. This is inherently racy against the worker's claim
// loop (best-effort, generous poll window) and is ONLY needed where a test
// requires a specific scenario (e.g. a full 17-section plan) rather than
// merely "some invocation happened with these flags".
//
// ASSUMPTION 3 (finding "my" invocation in the shared mock-claude log):
// agent_runs.claude_session_id (PRD §26.1) is assumed to be set to the same
// value passed as `--session-id` to the `claude` CLI, which mock-claude
// echoes back into its log line as `parsed.session_id`. This lets tests
// correlate a specific DB run with a specific log entry without needing
// scenario routing to work at all, and without parsing MOCK_CLAUDE_LOG by
// wall-clock timing (fragile under concurrency 1 sequential runs, but still
// avoids ordering assumptions).

import { randomUUID } from "crypto";
import { queryOne, api, type Session } from "../helpers";

export async function submitTicket(opts: {
  formSlug: string;
  title: string;
  description: string;
  submitterEmail?: string;
  submitterName?: string;
}) {
  const res = await api(null, "POST", `/api/public/forms/${opts.formSlug}/submissions`, {
    title: opts.title,
    description: opts.description,
    submitter_name: opts.submitterName ?? "Eval Bot",
    submitter_email: opts.submitterEmail ?? `eval-${randomUUID()}@example.test`,
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`ticket submission failed: ${res.status} ${await res.text()}`);
  }
  // Don't trust the response envelope shape (HARNESS_CONVENTIONS.md) — read
  // ground truth back from Postgres, matched on the exact description we
  // just submitted (unique per call site).
  let row: any = null;
  for (let i = 0; i < 50 && !row; i++) {
    row = await queryOne("select * from tickets where description = $1 order by created_at desc limit 1", [
      opts.description,
    ]);
    if (!row) await new Promise((r) => setTimeout(r, 200));
  }
  if (!row) throw new Error("ticket did not appear in Postgres after submission");
  return row;
}

// See ASSUMPTION 1 above.
export async function moveToTriageAndApprovePlanning(session: Session, ticketId: string) {
  await api(session, "PATCH", `/api/admin/tickets/${ticketId}`, { status: "Triage" });
  const res = await api(session, "POST", `/api/admin/tickets/${ticketId}/approve-planning`);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`approve-planning failed: ${res.status} ${await res.text()}`);
  }
}

// See ASSUMPTION 2 above. Best-effort; returns the job id patched, or null
// if no matching job appeared within the timeout (caller's downstream
// waitFor will then time out too — that combined failure is the signal that
// this routing assumption doesn't match the real implementation).
export async function routeScenarioToNextJob(
  jobType: string,
  sinceIso: string,
  scenarioPath: string,
  timeoutMs = 10000,
): Promise<string | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const row = await queryOne(
      `select id from jobs where type = $1 and created_at >= $2::timestamptz order by created_at asc limit 1`,
      [jobType, sinceIso],
    );
    if (row) {
      await queryOne(
        `update jobs set payload_json = coalesce(payload_json, '{}'::jsonb) || jsonb_build_object('mock_scenario_path', $2::text) where id = $1 returning id`,
        [row.id, scenarioPath],
      );
      return row.id;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

// See ASSUMPTION 3 above.
export async function waitForAgentRun(ticketId: string, runTypeLike: string, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const row = await queryOne(
      `select * from agent_runs where ticket_id = $1 and run_type ilike $2 and claude_session_id is not null order by created_at desc limit 1`,
      [ticketId, runTypeLike],
    );
    if (row) return row;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`waitForAgentRun: no agent_runs row for ticket ${ticketId} matching run_type ilike ${runTypeLike} within ${timeoutMs}ms`);
}

export async function waitForTicketStatus(ticketId: string, statuses: string[], timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const row = await queryOne(`select status from tickets where id = $1`, [ticketId]);
    if (row && statuses.includes(row.status)) return row.status as string;
    await new Promise((r) => setTimeout(r, 300));
  }
  const row = await queryOne(`select status from tickets where id = $1`, [ticketId]);
  throw new Error(
    `waitForTicketStatus: ticket ${ticketId} never reached one of [${statuses.join(", ")}] within ${timeoutMs}ms (last seen: ${row?.status})`,
  );
}

export async function getLatestPlanVersion(ticketId: string) {
  return queryOne(
    `select pv.* from plan_versions pv join plans p on p.id = pv.plan_id where p.ticket_id = $1 order by pv.version desc limit 1`,
    [ticketId],
  );
}

export async function approvePlanVersion(session: Session, planVersionId: string) {
  const res = await api(session, "POST", `/api/admin/plan-versions/${planVersionId}/approve`);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`plan-version approve failed: ${res.status} ${await res.text()}`);
  }
}

export async function getLatestExecutionAttempt(ticketId: string) {
  return queryOne(`select * from execution_attempts where ticket_id = $1 order by attempt_number desc limit 1`, [
    ticketId,
  ]);
}
