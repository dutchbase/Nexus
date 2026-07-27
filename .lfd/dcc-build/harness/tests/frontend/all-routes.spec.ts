// FE-12 — every route renders without a client-side error against the
// seeded fixtures, including the four intentional unhappy paths
// (design-handoff/README.md §3, §9; fixtures/seed.sql).
import { test, expect, type Page } from "@playwright/test";
import { loginAsAdmin, APP_BASE_URL } from "./playwright-helpers";

const ERROR_BOUNDARY_TEXT = /application error|something went wrong|500|internal server error/i;

async function gotoAndSettle(page: Page, path: string) {
  await page.goto(`${APP_BASE_URL}${path}`);
  // Run detail in particular may hold a live SSE/WebSocket connection open
  // (§6 "Real-time"), so networkidle can legitimately never fire — that's
  // tolerated (best-effort "stable state"), not treated as a failure.
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
}

// True if some reasonably-scoped, currently-visible element contains ALL of
// the given substrings — used to assert two pieces of data (e.g. a
// delivery's id and its error code) render together "near" each other
// without assuming a specific DOM shape.
async function elementContainingAll(page: Page, texts: string[]): Promise<boolean> {
  return page.evaluate((needles) => {
    const all = Array.from(document.querySelectorAll<HTMLElement>("body *"));
    return all.some((el) => {
      if (el.children.length > 60) return false;
      const t = el.textContent || "";
      return needles.every((n) => t.includes(n));
    });
  }, texts);
}

// Static routes hit directly by URL. Dynamic ids are seeded fixture data
// (see fixtures/seed.sql) whose route-param convention is confirmed by
// either PRD §23.4's dashboardUrl example or the design prototype's own
// mock-data route state (design-handoff §3/§8):
//   - DCC-142 (ticket_number) — PRD §23.4's dashboardUrl example is literally
//     ".../admin/tickets/DCC-142", confirming ticketId = ticket_number.
//   - plan version 3 — the prototype's mock ticket for DCC-142 carries
//     `plan:'v3'` / `planVersion: 3` verbatim.
//   - customer-portal / website-feedback / ponytail — slugs, matching the
//     prototype's `projectSlug` / `formSlug` / `skillSlug` route state.
//   - corporate-site #218 — a seeded, open pull request.
// RUN-0898's real URL id is deliberately NOT guessed: agent_runs.id is a
// uuid per PRD §26 (the human "RUN-0898" label baked into
// fixtures/seed.sql's uuid suffix is only a readability aid for fixture
// authors), so its route is discovered by clicking through from
// /admin/runs instead — see the dedicated unhappy-path block below.
const PUBLIC_ROUTES = ["/login", "/f/website-feedback", "/f/website-feedback/submitted"];

const ADMIN_ROUTES = [
  "/admin",
  "/admin/tickets",
  "/admin/tickets/DCC-142",
  "/admin/tickets/DCC-142/plans/3",
  "/admin/runs",
  "/admin/queue",
  "/admin/pull-requests",
  "/admin/pull-requests/corporate-site/218",
  "/admin/projects",
  "/admin/projects/customer-portal",
  "/admin/forms",
  "/admin/forms/website-feedback",
  "/admin/prompts",
  "/admin/skills",
  "/admin/skills/ponytail",
  "/admin/notifications",
  "/admin/audit",
  "/admin/settings",
  "/admin/system",
];

test("all routes render, including the four unhappy paths", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  const assertClean = async (label: string) => {
    expect(pageErrors, `uncaught page error(s) after visiting ${label}: ${pageErrors.join("; ")}`).toHaveLength(0);
    await expect(
      page.getByText(ERROR_BOUNDARY_TEXT),
      `visible generic error boundary text after visiting ${label}`,
    ).toHaveCount(0);
  };

  for (const path of PUBLIC_ROUTES) {
    await gotoAndSettle(page, path);
    await assertClean(path);
  }

  await loginAsAdmin(page);
  await assertClean("/admin (post-login)");

  for (const path of ADMIN_ROUTES) {
    await gotoAndSettle(page, path);
    await assertClean(path);
  }

  // ---- unhappy path 1: customer-portal's dirty-repository banner (§5.9, §9) ----
  await gotoAndSettle(page, "/admin/projects/customer-portal");
  await assertClean("/admin/projects/customer-portal");
  await expect(page.getByText(/dirty|uncommitted/i).first()).toBeVisible();

  // ---- unhappy path 2: DCC-144's Validation tab shows Validation Failed (§5.5, §9) ----
  await gotoAndSettle(page, "/admin/tickets/DCC-144");
  await assertClean("/admin/tickets/DCC-144");
  await page.getByRole("tab", { name: /validation/i }).click();
  await expect(page.getByText(/validation failed/i).first()).toBeVisible();

  // ---- unhappy path 3: ND-8841 failed with a 504 on the Deliveries tab (§5.13, §9) ----
  await gotoAndSettle(page, "/admin/notifications");
  await assertClean("/admin/notifications");
  await page.getByRole("tab", { name: /deliveries/i }).click();
  const deliveryRowShowsError = await elementContainingAll(page, ["ND-8841", "504"]);
  expect(
    deliveryRowShowsError,
    "expected ND-8841's row to show both its id and the 504 error together",
  ).toBe(true);
  await expect(page.getByText(/failed/i).first()).toBeVisible();

  // ---- unhappy path 4: RUN-0898 timed out at 40/40 turns (§5.7, §9) ----
  await gotoAndSettle(page, "/admin/runs");
  await assertClean("/admin/runs");
  const runRow = page.getByText("RUN-0898", { exact: false }).first();
  await expect(runRow).toBeVisible();
  await runRow.click();
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
  await expect(page).toHaveURL(/\/admin\/runs\/[^/]+$/);
  await assertClean("run detail (RUN-0898)");
  await expect(page.getByText(/timed out/i).first()).toBeVisible();
});
