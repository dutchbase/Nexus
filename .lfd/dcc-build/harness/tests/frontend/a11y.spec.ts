// FE-09 — accessibility: modal Escape-to-close, focus trap, and focus
// restore (design-handoff/README.md §6 "Modals", §11).
import { test, expect } from "@playwright/test";
import { loginAsAdmin, APP_BASE_URL } from "./playwright-helpers";

// DCC-142 (va-jobs-platform, "Search filters reset when navigating back") is
// seeded fixture data — see fixtures/seed.sql. Its ticket-detail header
// exposes a "Preview prompt" action (§5.5) which opens the prompt-preview
// modal, one of the four modals listed in §6 ("prompt preview, approve plan,
// request revision, execution-blocked"). Any of the four would exercise the
// same Escape/focus-trap/focus-restore behaviour required by §6 and §11 —
// this one was picked because it needs no prior state (no plan version, no
// blocked run) to be reachable.
const TICKET = "DCC-142";

test.beforeEach(async ({ page }) => {
  await loginAsAdmin(page);
  await page.goto(`${APP_BASE_URL}/admin/tickets/${TICKET}`);
});

test("modal Escape-to-close, focus trap, and focus restore", async ({ page }) => {
  const trigger = page.getByRole("button", { name: /preview prompt/i });
  await expect(trigger).toBeVisible();
  await trigger.click();

  // §11: modals should be real dialogs — role="dialog" is the accessible
  // contract this asserts against.
  const modal = page.getByRole("dialog");
  await expect(modal).toBeVisible();
  const modalHandle = await modal.elementHandle();
  expect(modalHandle, "expected the opened modal to resolve to a DOM element").not.toBeNull();

  // Focus trap: Tab repeatedly — well past the number of focusable elements
  // in any reasonable modal, so this also exercises wrap-from-last-back-to-
  // first — and assert focus never escapes the modal container to the page
  // behind the scrim.
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press("Tab");
    const containedInModal = await modalHandle!.evaluate((el) => el.contains(document.activeElement));
    expect(containedInModal, `Tab press #${i + 1} moved focus outside the modal`).toBe(true);
  }

  // Reverse direction (Shift+Tab) must stay trapped too.
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press("Shift+Tab");
    const containedInModal = await modalHandle!.evaluate((el) => el.contains(document.activeElement));
    expect(containedInModal, `Shift+Tab press #${i + 1} moved focus outside the modal`).toBe(true);
  }

  await page.keyboard.press("Escape");
  await expect(modal).toBeHidden();

  // Focus restore: the element that opened the modal is refocused on close.
  await expect(trigger).toBeFocused();
});
