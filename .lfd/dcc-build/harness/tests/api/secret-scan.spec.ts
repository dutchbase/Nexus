// SEC-08, SEC-09 [BOTH HARD-FAIL]: PRD §27.4 (secret scanning before
// commit), §11.3 (protected_paths example), §20.5 (worker-side validation
// pipeline run independently of whatever Claude claims).
//
// DELIBERATE SIMPLIFICATION — read this before touching the assertions:
// mock-claude (harness/mock-claude/) never touches the filesystem — it's a
// stub CLI that only prints canned stdout and logs its invocation (see
// harness/mock-claude/README.md). There is no real Claude session that
// could actually edit a file in the worktree, so there's nothing for the
// worker's own git-diff-based validation step to find UNLESS we put it
// there ourselves. This file's approach: trigger a real execution attempt
// through the real API (ticket -> plan -> approve -> execute), wait for the
// worker to create the isolated git worktree (PRD §20.2:
// data/worktrees/{project}/{ticket}/{attempt}, exposed via
// execution_attempts.worktree_path), then WRITE DIRECTLY into that worktree
// on disk — planting exactly what a compromised or careless Claude session
// would have produced — before the worker's own validation step
// (changed-file inspection / secret scan / protected-path inspection, PRD
// §20.5 steps 1-3) runs. The worker's validation must catch it regardless
// of who or what put it there; that's the actual thing SEC-08/SEC-09 test.
//
// This only works if we plant the file BEFORE the worker's execution.run
// job (which spawns the mock `claude` and waits for it to exit) finishes
// and validation starts. We poll for the worktree directory to exist right
// after triggering /execute, which happens as soon as the (synchronous,
// git-based) worktree-creation step completes — before Claude is even
// spawned — so there's a comfortable window. See tests/api/_pipeline.ts for
// the scenario-routing assumptions this shares with the other API specs.
//
// PROTECTED PATHS ASSUMPTION: fixtures/seed.sql's seeded project
// config_json does NOT set `protected_paths` explicitly (checked directly —
// it only sets `ai` and `skills`). Per PRD §11.3's example project config,
// we assume the effective/default protected_paths list includes at least
// `.env`, so SEC-09 modifies `.env` at the worktree root. If the real
// implementation requires protected_paths to be explicitly configured per
// project (with none = nothing protected), that's a reportable mismatch,
// not something to route around here.

import { describe, it, expect } from "vitest";
import { randomUUID } from "crypto";
import { existsSync, writeFileSync, appendFileSync } from "fs";
import { join } from "path";
import { login, api, writeMockClaudeScenario, DEFAULT_PLAN_MARKDOWN, queryOne, queryAll } from "../helpers";
import {
  submitTicket,
  moveToTriageAndApprovePlanning,
  routeScenarioToNextJob,
  waitForTicketStatus,
  getLatestPlanVersion,
  approvePlanVersion,
  getLatestExecutionAttempt,
} from "./_pipeline";

const IN_FLIGHT_STATUSES = ["Execution Queued", "Executing", "Validating"];
const BLOCKED_OK_STATUSES = ["Validation Failed", "Execution Failed", "PR Creation Failed"];

async function driveTicketToExecutingWorktree(marker: string) {
  const session = await login();
  const ticket = await submitTicket({
    formSlug: "ui-ux-feedback",
    title: `secret-scan probe ${marker}`,
    description: `secret-scan probe ${marker}`,
  });

  const planScenario = writeMockClaudeScenario({ mode: "plan_valid", plan_markdown: DEFAULT_PLAN_MARKDOWN });
  const planSince = new Date().toISOString();
  const planRouting = routeScenarioToNextJob("planning.generate", planSince, planScenario);
  await moveToTriageAndApprovePlanning(session, ticket.id);
  await planRouting;
  await waitForTicketStatus(ticket.id, ["Plan Ready for Review"], 30000);

  const planVersion = await getLatestPlanVersion(ticket.id);
  expect(planVersion, "plan_versions row").toBeTruthy();
  await approvePlanVersion(session, planVersion.id);
  await waitForTicketStatus(ticket.id, ["Plan Approved"], 15000);

  const execScenario = writeMockClaudeScenario({
    mode: "exec_stream",
    events: [{ type: "turn", turn_index: 0 }],
    exit_code: 0,
  });
  const execSince = new Date().toISOString();
  const execRouting = routeScenarioToNextJob("execution.run", execSince, execScenario);

  const execRes = await api(session, "POST", `/api/admin/tickets/${ticket.id}/execute`);
  expect(execRes.status, `execute failed: ${await execRes.text().catch(() => "")}`).toBeLessThan(300);

  // Poll for the worktree to exist on disk (execution_attempts.worktree_path).
  let attempt: any = null;
  const start = Date.now();
  while (Date.now() - start < 20000) {
    attempt = await getLatestExecutionAttempt(ticket.id);
    if (attempt?.worktree_path && existsSync(attempt.worktree_path)) break;
    attempt = null;
    await new Promise((r) => setTimeout(r, 200));
  }
  expect(attempt, "execution_attempts row with an existing worktree_path on disk").toBeTruthy();

  await execRouting;
  return { session, ticket, attempt };
}

async function waitForBlockedOutcome(ticketId: string) {
  const start = Date.now();
  let status = "";
  while (Date.now() - start < 60000) {
    const row = await queryOne("select status from tickets where id = $1", [ticketId]);
    status = row?.status ?? "";
    if (!IN_FLIGHT_STATUSES.includes(status)) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  return status;
}

async function assertNoLeak(secret: string) {
  const historyRows = await queryAll(
    "select reason from ticket_status_history where reason ilike $1",
    [`%${secret}%`],
  );
  expect(historyRows, "ticket_status_history.reason must not echo the planted secret").toHaveLength(0);

  const runRows = await queryAll(
    "select error_message from agent_runs where error_message ilike $1",
    [`%${secret}%`],
  );
  expect(runRows, "agent_runs.error_message must not echo the planted secret").toHaveLength(0);

  const jobRows = await queryAll("select id from jobs where error_json::text ilike $1", [`%${secret}%`]);
  expect(jobRows, "jobs.error_json must not echo the planted secret").toHaveLength(0);
}

describe("secret and protected-path scanning blocks the commit", () => {
  it("secret scan blocks the commit", async () => {
    const marker = randomUUID();
    const { ticket, attempt } = await driveTicketToExecutingWorktree(`sec08-${marker}`);

    // AWS-access-key-shaped literal (AKIA + 16 alphanumeric) plus a private
    // key block, in a plain new file — not a protected path, so this
    // isolates the secret-scan check from the protected-path check (SEC-09).
    const secretValue = "AKIAIOSFODNN7EXAMPLE";
    const plantedContent = [
      `# planted for eval SEC-08 marker=${marker}`,
      `AWS_ACCESS_KEY_ID=${secretValue}`,
      "-----BEGIN PRIVATE KEY-----",
      "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj",
      "-----END PRIVATE KEY-----",
      "",
    ].join("\n");
    writeFileSync(join(attempt.worktree_path, "EVAL_SECRET_PROBE.txt"), plantedContent);

    const finalStatus = await waitForBlockedOutcome(ticket.id);
    expect(finalStatus).not.toBe("PR Ready for Review");
    expect(BLOCKED_OK_STATUSES).toContain(finalStatus);

    const finalAttempt = await getLatestExecutionAttempt(ticket.id);
    expect(finalAttempt.result_commit, "execution_attempts.result_commit must stay null").toBeNull();

    await assertNoLeak(secretValue);
  }, 120000);

  it("protected-path modification blocks the commit", async () => {
    const marker = randomUUID();
    const { ticket, attempt } = await driveTicketToExecutingWorktree(`sec09-${marker}`);

    // Modify .env at the worktree root — PRD §11.3's example protected_paths
    // list (`.env`, `.env.*`, `secrets/**`, `production-data/**`, `.git/**`)
    // — this diff should be blocked even with no secret-shaped content in it
    // and even if lint/typecheck/test would otherwise pass.
    const envPath = join(attempt.worktree_path, ".env");
    appendFileSync(envPath, `\n# eval SEC-09 protected-path probe marker=${marker}\nFEATURE_FLAG_X=true\n`);

    const finalStatus = await waitForBlockedOutcome(ticket.id);
    expect(finalStatus).not.toBe("PR Ready for Review");
    expect(BLOCKED_OK_STATUSES).toContain(finalStatus);

    const finalAttempt = await getLatestExecutionAttempt(ticket.id);
    expect(finalAttempt.result_commit, "execution_attempts.result_commit must stay null").toBeNull();
  }, 120000);
});
