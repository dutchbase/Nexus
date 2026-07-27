// FE-10, FE-11 — responsive layout below the 980px breakpoint
// (design-handoff/README.md §7 "Responsive", §11).
import { test, expect, type Page } from "@playwright/test";
import { loginAsAdmin, APP_BASE_URL } from "./playwright-helpers";

const MOBILE_VIEWPORT = { width: 900, height: 800 };

// Sidebar has no dedicated prototype element name — §4 just calls the whole
// left column "sidebar". Same candidate list/order as shell.spec.ts's
// locateSidebar, kept local here to avoid a cross-file coupling on an
// unexported helper.
async function locateSidebar(page: Page) {
  const candidates = ['aside', 'nav[aria-label]', '[role="navigation"]', '[class*="sidebar" i]'];
  for (const sel of candidates) {
    const loc = page.locator(sel).first();
    if (await loc.count()) return loc;
  }
  throw new Error(
    "could not locate a sidebar element via aside/nav[aria-label]/[role=navigation]/[class*=sidebar]",
  );
}

// Browsers always resolve `transform` to a matrix()/matrix3d() computed
// value; this pulls out the horizontal-translate component so off-canvas
// (§6: "translateX(-100%)") vs on-screen state can be asserted numerically
// regardless of which transform shorthand the execution agent authors.
function translateXFromMatrix(transform: string): number | null {
  if (!transform || transform === "none") return null;
  const matrix3d = transform.match(/^matrix3d\(([^)]+)\)$/);
  if (matrix3d) {
    const parts = matrix3d[1].split(",").map((s) => parseFloat(s.trim()));
    return parts[12] ?? null;
  }
  const matrix2d = transform.match(/^matrix\(([^)]+)\)$/);
  if (matrix2d) {
    const parts = matrix2d[1].split(",").map((s) => parseFloat(s.trim()));
    return parts[4] ?? null;
  }
  return null;
}

test("sub-980px drawer and card-row collapse", async ({ page }) => {
  await page.setViewportSize(MOBILE_VIEWPORT);
  await loginAsAdmin(page);

  await test.step("sidebar is an off-canvas drawer with a hamburger and a closing scrim", async () => {
    await page.goto(`${APP_BASE_URL}/admin`);

    const sidebar = await locateSidebar(page);
    const closedTransform = await sidebar.evaluate((el) => getComputedStyle(el).transform);
    const closedTx = translateXFromMatrix(closedTransform);
    expect(
      closedTx,
      `expected the sidebar to have an off-canvas translateX transform below 980px, got transform: "${closedTransform}"`,
    ).not.toBeNull();
    expect(closedTx!).toBeLessThan(-50);

    // Hamburger — §4: "Left (mobile only)". ASSUMPTION: its accessible name
    // contains "menu" (or "navigation"/"hamburger") — §11 requires an
    // aria-label on this icon-only control but doesn't fix its wording.
    const hamburger = page.getByRole("button", { name: /menu|navigation|hamburger/i }).first();
    await expect(hamburger).toBeVisible();
    await hamburger.click();

    const openTransform = await sidebar.evaluate((el) => getComputedStyle(el).transform);
    const openTx = translateXFromMatrix(openTransform);
    if (openTx !== null) {
      expect(Math.abs(openTx)).toBeLessThan(20);
    }
    await expect(sidebar).toBeInViewport();

    // Scrim — §6: "adds a var(--overlay) scrim at z-index 55 (sidebar 60)
    // that closes on click". There's no prescribed selector/testid for it,
    // so it's detected structurally: a newly-appearing fixed-position
    // element covering most of the viewport.
    const scrimHandle = await page.evaluateHandle(() => {
      return (
        Array.from(document.querySelectorAll<HTMLElement>("body *")).find((el) => {
          const cs = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return (
            cs.position === "fixed" &&
            cs.pointerEvents !== "none" &&
            rect.width > window.innerWidth * 0.7 &&
            rect.height > window.innerHeight * 0.7
          );
        }) ?? null
      );
    });
    const scrimElement = scrimHandle.asElement();
    expect(
      scrimElement,
      "expected a full-viewport fixed overlay (scrim) to appear once the drawer opens",
    ).not.toBeNull();

    await scrimElement!.click();

    const closedAgainTransform = await sidebar.evaluate((el) => getComputedStyle(el).transform);
    const closedAgainTx = translateXFromMatrix(closedAgainTransform);
    expect(
      closedAgainTx,
      "expected the sidebar to return to an off-canvas translateX after clicking the scrim",
    ).not.toBeNull();
    expect(closedAgainTx!).toBeLessThan(-50);
  });

  await test.step("ticket list renders as labeled card rows, not an unlabeled collapsed grid", async () => {
    await page.goto(`${APP_BASE_URL}/admin/tickets`);
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});

    // §7: "Every grid list drops its header row and switches to a card row"
    // — no desktop grid header should be visible/present.
    await expect(page.getByRole("columnheader")).toHaveCount(0);

    // DCC-142 is seeded fixture data (fixtures/seed.sql). Per §7's card-row
    // spec (identifier+status / title / meta+timestamp), its number, status
    // and title must all render together inside one reasonably-scoped
    // container — not as unlabeled stacked grid cells.
    const found = await page.evaluate(() => {
      const num = "DCC-142";
      const status = "Plan Ready for Review";
      const title = "Search filters reset when navigating back";
      const all = Array.from(document.querySelectorAll<HTMLElement>("body *"));
      return all.some((el) => {
        if (el.children.length > 40) return false;
        const t = el.textContent || "";
        return t.includes(num) && t.includes(status) && t.includes(title);
      });
    });
    expect(
      found,
      "expected a single card-row container with DCC-142's number, status and title all present",
    ).toBe(true);
  });
});

test("44px minimum touch targets on mobile", async ({ page }) => {
  await page.setViewportSize(MOBILE_VIEWPORT);
  await loginAsAdmin(page);
  await page.goto(`${APP_BASE_URL}/admin/tickets`);
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});

  const controls = page.locator("button, a, input, select");
  const count = await controls.count();
  let checked = 0;
  for (let i = 0; i < count && checked < 20; i++) {
    const control = controls.nth(i);
    if (!(await control.isVisible())) continue;
    const disabled = await control.isDisabled().catch(() => false);
    if (disabled) continue;
    const box = await control.boundingBox();
    if (!box) continue;
    expect(box.width, `control #${i} width below 44px`).toBeGreaterThanOrEqual(44);
    expect(box.height, `control #${i} height below 44px`).toBeGreaterThanOrEqual(44);
    checked++;
  }
  expect(checked, "expected at least one visible, enabled interactive control to sample").toBeGreaterThan(0);
});
