// Shared helpers for the end-user journey suite (tests/e2e/*.spec.ts).
//
// DB access, mock-claude scenario writing, and job scenario routing are
// reused from the eval harness (read-only imports — HARNESS_CONVENTIONS.md
// forbids modifying those files, not importing them).
import type { Page } from "@playwright/test";
import {
  queryOne,
  queryAll,
  waitFor,
  DEFAULT_PLAN_MARKDOWN,
  type MockClaudeScenario,
} from "../../.lfd/dcc-build/harness/tests/helpers";

export { queryOne, queryAll, waitFor, DEFAULT_PLAN_MARKDOWN };

// Scenario "path" handed to the app's test-only mock_scenario_path field.
// Inline JSON rather than a file: scoped executions run inside bubblewrap
// where files under tests/e2e/ are unreadable — our mock-claude parses the
// env var value directly when it isn't a readable file path.
export function scenarioRef(scenario: MockClaudeScenario & { event_delay_ms?: number }): string {
  return JSON.stringify(scenario);
}

export const APP_BASE_URL = process.env.APP_BASE_URL ?? "http://127.0.0.1:3100";

export const ADMIN_USER = process.env.E2E_ADMIN_USER ?? "e2e-admin";
export const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "";

// Logs in through the real login form, like a human would.
export async function loginViaUI(page: Page): Promise<void> {
  if (!ADMIN_PASSWORD) throw new Error("E2E_ADMIN_PASSWORD not set — run via tests/e2e/run-e2e.sh");
  await page.goto("/login");
  await page.locator('input[name="username"]').fill(ADMIN_USER);
  await page.locator('input[name="password"]').fill(ADMIN_PASSWORD);
  await Promise.all([page.waitForURL("**/admin"), page.locator('button[type="submit"]').click()]);
}

export async function ticketByNumber(ticketNumber: string) {
  return queryOne("select * from tickets where ticket_number = $1", [ticketNumber]);
}

// Creates a ticket through the admin "Add ticket" modal; lands on its detail
// page. Admin-authored tickets start in "Triage" (server.ts:1413).
export async function createTicketViaUI(page: Page, title: string): Promise<string> {
  await page.goto("/admin/tickets");
  await page.locator("[data-add-ticket-button]").click();
  const form = page.locator("[data-add-ticket-form]");
  await form.locator('select[name="project_id"]').selectOption({ index: 1 });
  await form.locator('input[name="title"]').fill(title);
  await form.locator('textarea[name="description"]').fill("Created through the admin UI by the e2e journey suite.");
  await form.locator('button[type="submit"]').click();
  await page.waitForURL("**/admin/tickets/DCC-*");
  const row = await queryOne("select ticket_number, status from tickets where title = $1", [title]);
  if (row?.status !== "Triage") throw new Error(`expected Triage after modal create, got ${row?.status}`);
  return row.ticket_number as string;
}

// Submits the public intake form; returns the new ticket number ("Submitted").
export async function submitPublicTicket(page: Page, title: string): Promise<string> {
  await page.goto("/f/website-feedback");
  await page.locator('select[name="project_id"]').selectOption({ index: 1 });
  await page.locator('input[name="title"]').fill(title);
  await page.locator('textarea[name="description"]').fill("Public submission created by the e2e journey suite.");
  await page.locator('button[type="submit"]').click();
  await page.waitForURL("**/submitted**");
  let row: any;
  await waitFor(async () => {
    row = await queryOne("select ticket_number from tickets where title = $1", [title]);
    return !!row;
  });
  return row.ticket_number as string;
}

// Drives a fresh admin-created ticket to "Plan Approved" purely through UI
// clicks (approve planning -> worker generates plan v1 -> approve dialog).
export async function driveTicketToPlanApproved(page: Page, title: string): Promise<{ ticketNumber: string; ticketId: string }> {
  const ticketNumber = await createTicketViaUI(page, title);
  const scenario = scenarioRef({ mode: "plan_valid", plan_markdown: DEFAULT_PLAN_MARKDOWN });
  await injectScenarioOnce(page, "/approve-planning", scenario);
  await page.locator("[data-approve-planning]").click();

  const row = await queryOne("select id from tickets where ticket_number = $1", [ticketNumber]);
  await waitForTicketStatus(row.id, ["Plan Ready for Review"]);

  await page.goto(`/admin/tickets/${ticketNumber}/plans/1`);
  await page.locator("[data-open-approve-dialog]").click();
  await Promise.all([page.waitForURL(`**/admin/tickets/${ticketNumber}`), page.locator("[data-confirm-approve]").click()]);
  await waitForTicketStatus(row.id, ["Plan Approved"]);
  return { ticketNumber, ticketId: row.id };
}

// Drives a fresh ticket all the way to "PR Ready for Review" through the UI:
// plan, approve, execute (mock writes a real file change), wait for the PR.
export async function driveTicketToPrReady(page: Page, title: string): Promise<{ ticketNumber: string; ticketId: string; prId: string; prNumber: number }> {
  const { ticketNumber, ticketId } = await driveTicketToPlanApproved(page, title);
  const scenario = scenarioRef({
    mode: "exec_stream",
    write_files: [{ path: "docs/e2e-change.md", content: `E2E change for ${title}\n` }],
    events: [
      { type: "turn", turn_index: 0 },
      { type: "tool_use", name: "Agent", turn_index: 0 },
      { type: "result", subtype: "success" },
    ],
    exit_code: 0,
  } as any);
  await injectScenarioOnce(page, "/execute", scenario);
  await page.locator("[data-start-execution]").click();
  await waitForTicketStatus(ticketId, ["PR Ready for Review"], 90_000);
  const pr = await queryOne(
    `select pr.id, pr.number from pull_requests pr
     join execution_attempts ea on ea.id = pr.execution_attempt_id
     where ea.ticket_id = $1 order by pr.created_at desc limit 1`,
    [ticketId],
  );
  return { ticketNumber, ticketId, prId: pr.id, prNumber: pr.number };
}

// Deterministic mock-claude scenario routing: the next matching UI-originated
// request gets `mock_scenario_path` injected into its JSON body — the same
// test-only field the admin API accepts (server.ts:1597,1685,1874,1990). The
// user still clicks the real button; only the in-flight request is augmented.
export async function injectScenarioOnce(page: Page, pathSuffix: string, scenarioPath: string) {
  await page.route(`**${pathSuffix}`, async (route) => {
    const request = route.request();
    let body: any = {};
    try {
      body = request.postDataJSON() ?? {};
    } catch {
      body = {};
    }
    await route.continue({ postData: JSON.stringify({ ...body, mock_scenario_path: scenarioPath }) });
    await page.unroute(`**${pathSuffix}`);
  });
}

export async function waitForTicketStatus(ticketId: string, statuses: string[], timeoutMs = 45_000) {
  let last: string | undefined;
  await waitFor(
    async () => {
      const row = await queryOne("select status from tickets where id = $1", [ticketId]);
      last = row?.status;
      return statuses.includes(last ?? "");
    },
    { timeoutMs, intervalMs: 300 },
  ).catch(() => {
    throw new Error(`ticket ${ticketId} never reached [${statuses.join(", ")}] (last: ${last})`);
  });
  return last as string;
}
