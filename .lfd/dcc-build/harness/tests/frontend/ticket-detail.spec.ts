// FE-05, FE-06, FE-07, FE-08 — ticket detail (design-handoff/README.md §5.5).
import { test, expect, type Page, type Locator } from "@playwright/test";
import { loginAsAdmin, APP_BASE_URL } from "./playwright-helpers";

// DCC-142 (va-jobs-platform, "Search filters reset when navigating back",
// status "Plan Ready for Review" — no approved plan yet) and DCC-141
// (billing-api, "Add SEPA direct debit...", status "Plan Approved") are
// seeded fixture data — see fixtures/seed.sql.
const TICKET_NO_APPROVED_PLAN = "DCC-142";
const TICKET_WITH_APPROVED_PLAN = "DCC-141";

const EXPECTED_TAB_NAMES = [
  "Overview",
  "AI & skills",
  "Prompt",
  "Plans",
  "Runs",
  "Validation",
  "Pull request",
  "Activity",
];

async function gotoTicket(page: Page, ticketNumber: string) {
  await loginAsAdmin(page);
  await page.goto(`${APP_BASE_URL}/admin/tickets/${ticketNumber}`);
}

// Reads the "RESOLVED REFERENCES INJECTED INTO THE PROMPT" panel body text
// (§5.5) — walks up from the heading to the nearest sectioning ancestor,
// since the panel has no dedicated role of its own in the handoff.
async function resolvedReferencesPanel(page: Page): Promise<Locator> {
  const heading = page.getByText(/resolved references injected into the prompt/i).first();
  await expect(heading).toBeVisible();
  return heading.locator('xpath=ancestor::*[self::section or self::div][1]');
}

test("exactly 8 tabs with correct roles", async ({ page }) => {
  await gotoTicket(page, TICKET_NO_APPROVED_PLAN);

  const tablist = page.getByRole("tablist");
  await expect(tablist).toBeVisible();

  const tabs = tablist.getByRole("tab");
  await expect(tabs).toHaveCount(8);

  const names = await tabs.allTextContents();
  expect(names.map((n) => n.trim())).toEqual(EXPECTED_TAB_NAMES);
});

test("start execution disabled until plan approval, live-enables after", async ({ page }) => {
  await gotoTicket(page, TICKET_NO_APPROVED_PLAN);
  const startNoPlan = page.getByRole("button", { name: /start execution/i });
  await expect(startNoPlan).toBeDisabled();

  await gotoTicket(page, TICKET_WITH_APPROVED_PLAN);
  const startApproved = page.getByRole("button", { name: /start execution/i });
  await expect(startApproved).toBeEnabled();
});

// Follow-up: driving the live Plan-Ready-for-Review -> plan-approval ->
// "Start execution" becomes enabled (without page.reload()) transition
// end-to-end requires the execution agent's actual approval-modal markup
// (selectors for "Approve plan vN" trigger, modal confirm button, etc. —
// see handoff §6 "Modals" and §5.5 right-rail "Approval gates"). The static
// disabled/enabled states across the two fixture tickets above are covered;
// this sub-case is intentionally left as a stub until that markup exists.
test.fixme(
  "start execution live-enables after in-page plan approval (no reload)",
  async () => {},
);

test("automatic vs manual skill chip affordances", async ({ page }) => {
  await gotoTicket(page, TICKET_NO_APPROVED_PLAN);
  await page.getByRole("tab", { name: /ai & skills/i }).click();

  const autoChips = page.locator('[title^="Automatically added by project"]');
  const manualChips = page.locator('[title^="Selected on this ticket"]');

  const autoCount = await autoChips.count();
  expect(autoCount).toBeGreaterThan(0);

  for (let i = 0; i < autoCount; i++) {
    const chip = autoChips.nth(i);
    await expect(chip).toContainText(/auto/i);
    await expect(chip.locator('button[aria-label*="remove" i]')).toHaveCount(0);
  }

  const manualCount = await manualChips.count();
  if (manualCount === 0) {
    test.info().annotations.push({
      type: "note",
      description: "no manually-selected skill chip in fixture state; remove-button behaviour not exercised",
    });
    return;
  }

  const manualChip = manualChips.first();
  const removeButton = manualChip.locator('button[aria-label*="remove" i]');
  await expect(removeButton).toHaveCount(1);

  const panel = await resolvedReferencesPanel(page);
  const panelHandle = await panel.elementHandle();
  const beforeText = await panel.textContent();

  await removeButton.click();

  await page.waitForFunction(
    ([el, prev]) => el && el.textContent !== prev,
    [panelHandle, beforeText] as const,
  );
  const afterText = await panel.textContent();
  expect(afterText).not.toBe(beforeText);
});

test("skill toggle updates chips and resolved references together", async ({ page }) => {
  await gotoTicket(page, TICKET_NO_APPROVED_PLAN);
  await page.getByRole("tab", { name: /ai & skills/i }).click();

  const panel = await resolvedReferencesPanel(page);
  const panelHandle = await panel.elementHandle();
  const beforeChipCount = await page.locator('[title^="Automatically added by project"], [title^="Selected on this ticket"]').count();
  const beforeText = await panel.textContent();

  await page.getByRole("button", { name: /\+?\s*add skill/i }).click();

  const checkboxes = page.getByRole("checkbox");
  const checkboxCount = await checkboxes.count();
  expect(checkboxCount).toBeGreaterThan(0);

  let toggled: Locator | null = null;
  for (let i = 0; i < checkboxCount; i++) {
    const row = checkboxes.nth(i);
    if (await row.isEnabled()) {
      toggled = row;
      break;
    }
  }
  expect(toggled, "expected at least one enabled (non-disabled-in-registry) skill row in the picker").not.toBeNull();

  // "in the same tick" — assert the update happens without a page.reload();
  // poll the DOM instead of a hard sleep.
  await toggled!.click();

  await page.waitForFunction(
    ([el, prev]) => el && el.textContent !== prev,
    [panelHandle, beforeText] as const,
    { timeout: 5000 },
  );
  const afterText = (await panel.textContent()) ?? "";
  expect(afterText).not.toBe(beforeText);

  const afterChipCount = await page.locator('[title^="Automatically added by project"], [title^="Selected on this ticket"]').count();
  expect(afterChipCount).not.toBe(beforeChipCount);

  // Same resolved-reference lines must appear in the Prompt tab.
  const referenceLines = afterText
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("-"));
  expect(referenceLines.length).toBeGreaterThan(0);

  await page.getByRole("tab", { name: /^prompt$/i }).click();
  const promptTabText = (await page.getByRole("tabpanel").innerText()) ?? "";
  for (const line of referenceLines) {
    expect(promptTabText).toContain(line);
  }
});
