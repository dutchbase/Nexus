// Shared helpers for the end-user journey suite (tests/e2e/*.spec.ts).
import type { Page } from "@playwright/test";
import { Client } from "pg";

async function withDb<T>(fn: (db: Client) => Promise<T>): Promise<T> {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    return await fn(db);
  } finally {
    await db.end();
  }
}

export async function queryOne(sql: string, params: any[] = []): Promise<any | null> {
  return withDb(async (db) => {
    const res = await db.query(sql, params);
    return res.rows[0] ?? null;
  });
}

export async function queryAll(sql: string, params: any[] = []): Promise<any[]> {
  return withDb(async (db) => {
    const res = await db.query(sql, params);
    return res.rows;
  });
}

export async function waitFor(
  predicate: () => Promise<boolean>,
  { timeoutMs = 15000, intervalMs = 200 } = {},
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor: timed out after ${timeoutMs}ms`);
}

export type MockClaudeScenario = {
  mode: "plan_valid" | "plan_invalid" | "timeout" | "exec_stream" | "invalid_model_combo";
  plan_markdown?: string;
  invalid_plan_text?: string;
  session_id_expected?: string;
  events?: any[];
  timeout_after_events?: number;
  exit_code?: number;
};

export const DEFAULT_PLAN_MARKDOWN = [
  "# Implementation Plan",
  "",
  "## 1. Summary",
  "Mock plan for eval purposes.",
  "## 2. Problem Definition",
  "## 3. Current Behaviour",
  "## 4. Expected Behaviour",
  "## 5. Relevant Architecture",
  "## 6. Relevant Files",
  "## 7. Proposed Changes",
  "## 8. Implementation Steps",
  "## 9. Database or Migration Changes",
  "## 10. Testing Strategy",
  "## 11. Security Considerations",
  "## 12. Performance Considerations",
  "## 13. Risks and Edge Cases",
  "## 14. Rollback Strategy",
  "## 15. Acceptance Criteria Mapping",
  "## 16. Out of Scope",
  "## 17. Open Questions",
  "",
].join("\n");

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
// clicks (start planning -> worker generates plan v1 -> approve dialog).
export async function driveTicketToPlanApproved(page: Page, title: string): Promise<{ ticketNumber: string; ticketId: string }> {
  const ticketNumber = await createTicketViaUI(page, title);
  const scenario = scenarioRef({ mode: "plan_valid", plan_markdown: DEFAULT_PLAN_MARKDOWN });
  await injectScenarioOnce(page, "/approve-planning", scenario);
  await page.locator("[data-start-planning]").click();

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
