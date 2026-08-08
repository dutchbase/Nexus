// End-user journey: planning — approve a ticket for planning, let the worker
// generate a plan (mock-claude), review it, request a revision, approve it.
import { test, expect, type Page } from "@playwright/test";
import {
  loginViaUI,
  queryOne,
  waitFor,
  createTicketViaUI,
  injectScenarioOnce,
  scenarioRef,
  waitForTicketStatus,
  DEFAULT_PLAN_MARKDOWN,
} from "./helpers";

test.beforeEach(async ({ page }) => {
  await loginViaUI(page);
});

// Drives a fresh ticket to "Plan Ready for Review" through the UI.
async function generatePlan(page: Page, title: string): Promise<{ ticketNumber: string; ticketId: string }> {
  const ticketNumber = await createTicketViaUI(page, title);
  const scenario = scenarioRef({ mode: "plan_valid", plan_markdown: DEFAULT_PLAN_MARKDOWN });
  await injectScenarioOnce(page, "/approve-planning", scenario);
  await page.locator("[data-approve-planning]").click();

  const row = await queryOne("select id from tickets where ticket_number = $1", [ticketNumber]);
  await waitForTicketStatus(row.id, ["Plan Ready for Review", "Planning Failed"]);
  const after = await queryOne("select status from tickets where id = $1", [row.id]);
  expect(after.status, "worker should produce a reviewable plan").toBe("Plan Ready for Review");
  return { ticketNumber, ticketId: row.id };
}

test("approve for planning produces a reviewable plan and the UI tracks it", async ({ page }) => {
  const { ticketNumber } = await generatePlan(page, `E2E planning ${Date.now()}`);

  await page.goto(`/admin/tickets/${ticketNumber}/plans`);
  await expect(page.locator(".card", { hasText: "Version 1" }).first()).toBeVisible();

  // Open the review page and approve through the dialog.
  await page.getByRole("link", { name: "Review & approve" }).first().click();
  await page.waitForURL("**/plans/1");
  await expect(page.locator("[data-open-approve-dialog]")).toBeEnabled();
  await page.locator("[data-open-approve-dialog]").click();
  await page.locator("[data-approve-note]").fill("Approved by the e2e journey suite.");
  // Confirming navigates back to the ticket detail page.
  await Promise.all([page.waitForURL(`**/admin/tickets/${ticketNumber}`), page.locator("[data-confirm-approve]").click()]);

  const row = await queryOne("select id, status from tickets where ticket_number = $1", [ticketNumber]);
  await waitForTicketStatus(row.id, ["Plan Approved"]);

  // The review page now shows the approved state and blocks re-approval.
  await page.goto(`/admin/tickets/${ticketNumber}/plans/1`);
  await expect(page.locator("[data-open-approve-dialog]")).toBeDisabled();
  await expect(page.locator("[data-open-approve-dialog]")).toHaveText("Approved");
});

test("planning captures valid provider usage emitted by the mock", async ({ page }) => {
  const title = `E2E planning usage ${Date.now()}`;
  const ticketNumber = await createTicketViaUI(page, title);
  await injectScenarioOnce(page, "/approve-planning", scenarioRef({
    mode: "plan_valid", plan_markdown: DEFAULT_PLAN_MARKDOWN,
    usage: { input_tokens: 12, output_tokens: 8, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 },
  } as any));
  await page.locator("[data-approve-planning]").click();

  const ticket = await queryOne("select id from tickets where ticket_number = $1", [ticketNumber]);
  await waitForTicketStatus(ticket.id, ["Plan Ready for Review", "Planning Failed"]);
  await expect.poll(() => queryOne(
    "select ai_usage_status,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,total_tokens from agent_runs where ticket_id=$1 and run_type='planning' order by created_at desc limit 1",
    [ticket.id],
  )).toEqual({ ai_usage_status: "captured", input_tokens: "12", output_tokens: "8", cache_read_tokens: "3", cache_write_tokens: "4", total_tokens: "27" });
});

test("planning marks usage unavailable when the mock result omits it", async ({ page }) => {
  const { ticketId } = await generatePlan(page, `E2E planning no usage ${Date.now()}`);
  await expect.poll(() => queryOne(
    "select ai_usage_status,input_tokens,raw_usage_json from agent_runs where ticket_id=$1 and run_type='planning' order by created_at desc limit 1",
    [ticketId],
  )).toEqual({ ai_usage_status: "unavailable", input_tokens: null, raw_usage_json: null });
});

test("request revision produces plan v2, which can then be approved", async ({ page }) => {
  const { ticketNumber, ticketId } = await generatePlan(page, `E2E revision ${Date.now()}`);

  await page.goto(`/admin/tickets/${ticketNumber}/plans/1`);
  const revised = scenarioRef({
    mode: "plan_valid",
    plan_markdown: DEFAULT_PLAN_MARKDOWN.replace("Mock plan for eval purposes.", "Revised mock plan (v2) for the e2e suite."),
  });
  await injectScenarioOnce(page, "/request-revision", revised);
  await page.locator("[data-open-revision-dialog]").click();
  await page.locator("[data-revision-feedback]").fill("Please revise: cover the rollback strategy in more detail.");
  await page.locator("[data-submit-revision]").click();

  // The ticket bounces through the revision statuses and returns to
  // "Plan Ready for Review" — the reliable signal is the v2 row itself.
  await waitFor(
    async () =>
      !!(await queryOne(
        "select pv.id from plan_versions pv join plans p on p.id = pv.plan_id where p.ticket_id = $1 and pv.version = 2",
        [ticketId],
      )),
    { timeoutMs: 45_000, intervalMs: 300 },
  );
  await waitForTicketStatus(ticketId, ["Plan Ready for Review"]);

  // v1 is superseded: its review page blocks approval, v2 allows it.
  await page.goto(`/admin/tickets/${ticketNumber}/plans/1`);
  await expect(page.locator("[data-open-approve-dialog]")).toBeDisabled();
  await page.goto(`/admin/tickets/${ticketNumber}/plans/2`);
  await expect(page.locator("[data-open-approve-dialog]")).toBeEnabled();
  await page.locator("[data-open-approve-dialog]").click();
  await page.locator("[data-confirm-approve]").click();
  await waitForTicketStatus(ticketId, ["Plan Approved"]);
});
