// End-user journey: execution — start execution of an approved plan, watch
// the run, and end with a pull request ready for review. Also covers
// cancelling a run in flight.
import { test, expect } from "@playwright/test";
import {
  loginViaUI,
  queryOne,
  waitFor,
  driveTicketToPlanApproved,
  injectScenarioOnce,
  scenarioRef,
  waitForTicketStatus,
} from "./helpers";

test.beforeEach(async ({ page }) => {
  await loginViaUI(page);
});

test("start execution runs the plan and produces a PR ready for review", async ({ page }) => {
  const { ticketNumber, ticketId } = await driveTicketToPlanApproved(page, `E2E execution ${Date.now()}`);

  const scenario = scenarioRef({
    mode: "exec_stream",
    // Validation rejects no-op executions, so the mock writes a real change.
    write_files: [{ path: "docs/e2e-change.md", content: `E2E execution change ${Date.now()}\n` }],
    events: [
      { type: "turn", turn_index: 0 },
      // The publication gate requires proof the Agent tool ran (worker.ts:682).
      { type: "tool_use", name: "Agent", turn_index: 0 },
      { type: "result", subtype: "success" },
    ],
    exit_code: 0,
  } as any);
  await injectScenarioOnce(page, "/execute", scenario);
  await expect(page.locator("[data-start-execution]")).toBeEnabled();
  await page.locator("[data-start-execution]").click();

  const finalStatus = await waitForTicketStatus(
    ticketId,
    ["PR Ready for Review", "PR Creation Failed", "Execution Failed", "Validation Failed"],
    90_000,
  );
  expect(finalStatus, "execution should end in a reviewable PR").toBe("PR Ready for Review");

  // Ground truth: exactly one PR row for this ticket's execution attempt.
  const pr = await queryOne(
    `select pr.* from pull_requests pr
     join execution_attempts ea on ea.id = pr.execution_attempt_id
     where ea.ticket_id = $1`,
    [ticketId],
  );
  expect(pr).toBeTruthy();

  // The PR shows up in the pull request list UI.
  await page.goto("/admin/pull-requests");
  await expect(page.locator(".prs-row", { hasText: ticketNumber }).first()).toBeVisible();

  // And the run appears as completed in the runs UI.
  const run = await queryOne("select * from agent_runs where ticket_id = $1 and run_type = 'execution' order by created_at desc limit 1", [ticketId]);
  expect(run?.status).toBe("completed");
  await page.goto(`/admin/runs/${run.id}`);
  await expect(page.locator("body")).toContainText(ticketNumber);
});

test("a failed execution can be retried with the approved plan", async ({ page }) => {
  test.setTimeout(120_000);
  const { ticketNumber, ticketId } = await driveTicketToPlanApproved(page, `E2E recovery ${Date.now()}`);

  await injectScenarioOnce(page, "/execute", scenarioRef({
    mode: "timeout", events: [{ type: "turn", turn_index: 0 }], timeout_after_events: 1,
  }));
  await page.locator("[data-start-execution]").click();
  expect(await waitForTicketStatus(ticketId, ["Execution Failed"], 90_000)).toBe("Execution Failed");

  await page.reload();
  await expect(page.locator("[data-start-execution]")).toBeEnabled();
  await expect(page.locator("[data-start-execution]")).toHaveText("Retry execution");
  await expect(page.locator(`a[href="/admin/tickets/${ticketNumber}/plans/1"]`, { hasText: "Revise plan" })).toBeVisible();

  await injectScenarioOnce(page, "/execute", scenarioRef({
    mode: "exec_stream",
    write_files: [{ path: "docs/e2e-recovery-change.md", content: `E2E recovery change ${Date.now()}\n` }],
    events: [
      { type: "turn", turn_index: 0 },
      { type: "tool_use", name: "Agent", turn_index: 0 },
      { type: "result", subtype: "success" },
    ],
    exit_code: 0,
  } as any));
  await page.locator("[data-start-execution]").click();
  expect(await waitForTicketStatus(ticketId, ["PR Ready for Review"], 90_000)).toBe("PR Ready for Review");

  const attempts = await queryOne("select count(*)::int count from execution_attempts where ticket_id = $1", [ticketId]);
  expect(Number(attempts?.count)).toBe(2);
});

test("a max-turns run with zero file changes fails the ticket instead of silently succeeding", async ({ page }) => {
  const { ticketId } = await driveTicketToPlanApproved(page, `E2E max-turns no-op ${Date.now()}`);

  // The process exits 0 (mirrors the real DCC incident: Claude Code exits
  // clean even for error_max_turns), but the final result event reports
  // turn exhaustion and the mock writes no files — the no-op + max-turns
  // path this scenario proves must still fail the ticket.
  const scenario = scenarioRef({
    mode: "exec_stream",
    write_files: [],
    events: [
      { type: "turn", turn_index: 0 },
      {
        type: "result", subtype: "error_max_turns", is_error: true, num_turns: 50,
        permission_denials: [{ tool_name: "Bash" }, { tool_name: "Bash" }],
      },
    ],
    exit_code: 0,
  } as any);
  await injectScenarioOnce(page, "/execute", scenario);
  await page.locator("[data-start-execution]").click();

  const finalStatus = await waitForTicketStatus(
    ticketId,
    ["Execution Failed", "PR Ready for Review", "PR Creation Failed", "Validation Failed"],
    90_000,
  );
  expect(finalStatus, "a well-formed but turn-exhausted no-op run must not sail through to Validating/PR Ready").toBe("Execution Failed");

  const run = await queryOne("select * from agent_runs where ticket_id = $1 and run_type = 'execution' order by created_at desc limit 1", [ticketId]);
  expect(run?.status).toBe("failed");
  expect(run?.error_code).toBe("execution_max_turns");
  expect(run?.metadata_json?.tool_denials?.reportedDenials).toBe(2);

  const pr = await queryOne(
    `select pr.* from pull_requests pr
     join execution_attempts ea on ea.id = pr.execution_attempt_id
     where ea.ticket_id = $1`,
    [ticketId],
  );
  expect(pr, "a run that never produced a change must never publish a PR").toBeFalsy();
});

test("a running execution can be cancelled from the run page", async ({ page }) => {
  const { ticketId } = await driveTicketToPlanApproved(page, `E2E cancel ${Date.now()}`);

  // A timeout scenario keeps the mock agent emitting slowly, leaving the run
  // in a cancellable state long enough to click Cancel.
  const scenario = scenarioRef({
    mode: "timeout",
    events: Array.from({ length: 40 }, (_, index) => ({ type: "turn", turn_index: index })),
    timeout_after_events: 40,
    event_delay_ms: 500,
  });
  await injectScenarioOnce(page, "/execute", scenario);
  await page.locator("[data-start-execution]").click();

  let run: any;
  await waitFor(async () => {
    run = await queryOne("select * from agent_runs where ticket_id = $1 and run_type = 'execution' order by created_at desc limit 1", [ticketId]);
    return !!run && run.status === "running";
  }, { timeoutMs: 30_000, intervalMs: 250 });

  page.on("dialog", (dialog) => dialog.accept());
  await page.goto(`/admin/runs/${run.id}`);
  await expect(page.locator("[data-run-cancel]")).toBeVisible();
  await page.locator("[data-run-cancel]").click();

  await waitFor(async () => {
    const row = await queryOne("select status from agent_runs where id = $1", [run.id]);
    return ["cancellation_requested", "cancelled"].includes(row?.status);
  }, { timeoutMs: 15_000, intervalMs: 250 });
});
