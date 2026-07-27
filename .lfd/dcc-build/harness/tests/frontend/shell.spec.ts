// FE-01, FE-02 — application shell (design-handoff/README.md §4, §11).
import { test, expect, type Page } from "@playwright/test";
import { loginAsAdmin, APP_BASE_URL } from "./playwright-helpers";

// Sidebar/header are unstyled-by-us layout landmarks with no dedicated
// prototype element name; §4 calls the whole left column "sidebar" and the
// top bar "header". We try the obvious semantic elements first (resilient to
// implementation) before falling back to a class-name guess.
async function locateSidebar(page: Page) {
  const candidates = ['aside', 'nav[aria-label]', '[role="navigation"]', '[class*="sidebar" i]'];
  for (const sel of candidates) {
    const loc = page.locator(sel).first();
    if (await loc.count()) return loc;
  }
  throw new Error("could not locate a sidebar element via aside/nav[aria-label]/[role=navigation]/[class*=sidebar]");
}

async function locateHeader(page: Page) {
  const candidates = ["header", '[role="banner"]', '[class*="header" i]'];
  for (const sel of candidates) {
    const loc = page.locator(sel).first();
    if (await loc.count()) return loc;
  }
  throw new Error("could not locate a header element via header/[role=banner]/[class*=header]");
}

// Nav items are styled as "full-width button" per §4 but §11 only requires a
// real interactive element — could legitimately be <a> (routing) or
// <button>. Try both roles.
async function navItem(page: Page, name: string) {
  const link = page.getByRole("link", { name: new RegExp(name, "i") });
  if (await link.count()) return link.first();
  const button = page.getByRole("button", { name: new RegExp(name, "i") });
  if (await button.count()) return button.first();
  throw new Error(`could not locate nav item "${name}" as a link or button`);
}

test("shell metrics and live badge counts", async ({ page }) => {
  await loginAsAdmin(page);
  await expect(page).toHaveURL(`${APP_BASE_URL}/admin`);

  const sidebar = await locateSidebar(page);
  const sidebarWidth = await sidebar.evaluate((el) => getComputedStyle(el).width);
  expect(sidebarWidth).toBe("246px");

  const header = await locateHeader(page);
  const headerHeight = await header.evaluate((el) => getComputedStyle(el).height);
  const headerPosition = await header.evaluate((el) => getComputedStyle(el).position);
  expect(headerHeight).toBe("64px");
  expect(headerPosition).toBe("sticky");

  for (const group of ["Overview", "Work", "Configure", "Operate"]) {
    await expect(sidebar.getByText(group, { exact: false }).first()).toBeVisible();
  }

  // Tickets nav item badge — a live count of "open" tickets, whose exact
  // business definition is the app's decision. 14 tickets are seeded; assert
  // a plausible, parseable count rather than an exact guessed number.
  const ticketsItem = await navItem(page, "tickets");
  const badgeText = (await ticketsItem.textContent()) ?? "";
  const match = badgeText.match(/(\d+)\s*$/);
  expect(match, `expected a trailing numeric badge in Tickets nav item text, got: "${badgeText}"`).not.toBeNull();
  const badgeNumber = Number(match![1]);
  expect(Number.isInteger(badgeNumber)).toBe(true);
  expect(badgeNumber).toBeGreaterThan(0);
  expect(badgeNumber).toBeLessThanOrEqual(14);
});

test("nav item stays active on detail sub-routes with aria-current", async ({ page }) => {
  await loginAsAdmin(page);

  // DCC-142 (va-jobs-platform, "Search filters reset when navigating back")
  // is seeded fixture data — see fixtures/seed.sql.
  await page.goto(`${APP_BASE_URL}/admin/tickets/DCC-142`);

  const ticketsItem = await navItem(page, "tickets");
  await expect(ticketsItem).toHaveAttribute("aria-current", "page");
});
