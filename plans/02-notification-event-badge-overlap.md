# Notification Event Badge Overlap Verification & Regression Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task (this plan is small and linear; subagent-driven-development is unnecessary overhead here). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Confirm (and lock in with a regression test) that the Notifications `Event rules` tab no longer overlaps event names and status badges — the CSS fix already exists on `master` and was verified correct in a real browser render; this plan's job is to prove it's actually deployed/live and to add a test that would catch any future regression or "fix didn't take" deploy-lag confusion like this one.

**Architecture:** No CSS/markup changes are expected. This plan (a) adds a Playwright layout assertion that fails if the badge and event-name bounding boxes ever intersect again, at the longest real event name and a narrow viewport, and (b) documents a live-verification step for whoever runs this, because the most likely explanation for the original bug report is that the production process was serving a stale in-memory copy of `design-tokens.css` from before commit `290f7b6` deployed (this app reads `design-tokens.css` into a module-level constant once at process startup — see `apps/web/src/ui.ts:5-6` — so a merge without a restart/redeploy does not take effect).

**Tech Stack:** Playwright (already used in `.lfd/dcc-build/harness/tests/frontend/all-routes.spec.ts` and `tests/e2e/visual-sweep.spec.ts`), plain CSS (no Tailwind, no React).

**Spec:** This markdown file is self-contained; source task is "Fix event name and status badge overlap on Notifications event rules" (see plans/INDEX.md for the full original task text).

## Global Constraints

- Do NOT modify `apps/web/src/design-tokens.css` or `apps/web/src/pages/notifications.ts` unless the live-verification step in Task 1 proves the bug is still reproducible on a real running instance — the current code, byte-for-byte, was rendered in Chromium at 1440px/375px/320px with all 7 real event names (including the longest, `plan.ready_for_review`, 21 chars) and showed zero overlap.
- If Task 1 DOES reproduce a real overlap (meaning this plan's premise was wrong, or a newer change reintroduced the bug), stop, re-read `apps/web/src/design-tokens.css` lines 93-101 and `apps/web/src/pages/notifications.ts` line 31-32 fresh, and only then make a targeted CSS fix following the same flex + `min-width:0` + `flex-shrink:0` pattern already used for `.event-row` — do not guess a different approach.
- The canonical event list lives in `packages/domain/src/notifications.ts:3-6` (`NOTIFICATION_EVENTS`) — any test must import/reference this exact list, not a hand-copied one, so it can't drift.

---

## File Structure

- **Create:** `tests/e2e/notifications-event-rules-layout.spec.ts` — new Playwright test asserting no bounding-box overlap between event name and badge, across the full real event list, at a narrow (375px) and a normal desktop (1440px) viewport.
- No other files are expected to change (see constraints above).

---

### Task 1: Live-verify the fix is actually deployed

**Files:** none (manual/CLI verification step, not a code change)

- [ ] **Step 1: Confirm the source on `master` is what's live**

```bash
git log --oneline -1 -- apps/web/src/design-tokens.css
git show 290f7b6 -- apps/web/src/design-tokens.css | head -20
```
Confirm the `.event-row` block (flex row, `min-width:0`/`overflow-wrap:anywhere` on `.mono`, `flex-shrink:0` on `.status`) is present in the current file:
```bash
grep -n "\.event-row" apps/web/src/design-tokens.css
```
Expected: three rules at approximately lines 99-101, matching:
```css
.event-row { display:flex;align-items:center;justify-content:space-between;gap:12px;padding:13px 18px;border-top:1px solid var(--border) }
.event-row .mono { min-width:0;overflow-wrap:anywhere;flex:1 1 auto }
.event-row .status { flex-shrink:0 }
```

- [ ] **Step 2: Confirm the running server process has this file loaded**

`apps/web/src/ui.ts:5-6` reads `design-tokens.css` into an in-memory constant **once at process startup**:
```ts
const stylesPath = join(dirname(fileURLToPath(import.meta.url)), "design-tokens.css");
export const styles = await readFile(stylesPath, "utf8");
```
and `apps/web/src/server.ts:2559-2562` serves it with `cache-control: public, max-age=300`. If the deployed process was started before commit `290f7b6` landed, it is still serving the pre-fix CSS from memory regardless of what's on disk/in git.

On the deployed host, check whether the running process's start time predates the merge commit, and whether `/assets/design-tokens.css` (fetched directly, cache-busted with a query string) contains the literal string `.event-row`:
```bash
curl -s "https://<deployed-host>/assets/design-tokens.css?cachebust=$(date +%s)" | grep -c "\.event-row"
```
Expected: `1` (or more). If `0`, the process needs a restart/redeploy — this is an operational action, not a code change, and is out of scope for this plan to perform; flag it to whoever runs this plan so they can trigger the existing deploy pipeline (see runbook referenced in the repo's README "Updating" section) rather than silently redeploying as a side effect of a planning/verification task.

- [ ] **Step 3: Record the outcome**

If Step 2 shows the fix IS live and no overlap is visible in a real browser at the URL, proceed directly to Task 2 (add the regression test) — no further code changes needed. If Step 2 shows the fix is NOT live, that is a deployment/ops issue outside this plan's scope; note it in the execution report handed back to the user (per plans/INDEX.md's "manual actions required" section) rather than attempting a redeploy from within this plan.

---

### Task 2: Add a Playwright regression guard against future overlap

**Files:**
- Create: `tests/e2e/notifications-event-rules-layout.spec.ts`

**Interfaces:**
- Consumes: `NOTIFICATION_EVENTS` from `packages/domain/src/notifications.ts` (the canonical event list, currently 7 entries including `plan.ready_for_review` at 21 chars — the longest).
- Produces: no new exports; a standalone Playwright spec file.

- [ ] **Step 1: Check how existing Playwright specs authenticate and navigate to `/admin/notifications`**

Read `.lfd/dcc-build/harness/tests/frontend/all-routes.spec.ts` (which already visits `/admin/notifications`, lines ~66/109-110/117) and `tests/e2e/visual-sweep.spec.ts` (which already tests `/admin/*` routes at multiple widths) to copy their exact auth/session setup and `page.goto()` pattern — do not invent a new login flow.

- [ ] **Step 2: Write the test**

```ts
// tests/e2e/notifications-event-rules-layout.spec.ts
import { test, expect } from "@playwright/test";
import { NOTIFICATION_EVENTS } from "../../packages/domain/src/notifications.ts";
// Adjust the import path/session-setup import to match whatever
// tests/e2e/visual-sweep.spec.ts or .lfd/dcc-build/harness/tests/frontend/all-routes.spec.ts
// actually uses for authenticated admin session setup — copy it verbatim.

const WIDTHS = [375, 1440] as const;

for (const width of WIDTHS) {
  test(`event rule rows show no name/badge overlap at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    // ... navigate + authenticate exactly as the copied pattern does ...
    await page.goto("/admin/notifications");
    // Ensure the "Event rules" tab is active — check notifications.ts for the tab
    // query param / selector convention (e.g. ?tab=rules or a [data-tab] click) and
    // use the same one all-routes.spec.ts relies on.

    const rows = page.locator(".event-row");
    const count = await rows.count();
    expect(count).toBe(NOTIFICATION_EVENTS.length);

    for (let i = 0; i < count; i++) {
      const row = rows.nth(i);
      const nameBox = await row.locator(".mono").boundingBox();
      const badgeBox = await row.locator(".status").boundingBox();
      expect(nameBox).not.toBeNull();
      expect(badgeBox).not.toBeNull();
      if (!nameBox || !badgeBox) continue;
      // No horizontal overlap: the name's right edge must not extend past the badge's left edge,
      // UNLESS the name has wrapped to multiple lines (its box height will exceed one line-height),
      // in which case only vertical overlap matters.
      const nameRight = nameBox.x + nameBox.width;
      const badgeLeft = badgeBox.x;
      const wrapped = nameBox.height > 24; // single-line rows are ~1 line-height (~18-20px) + padding
      if (!wrapped) {
        expect(nameRight).toBeLessThanOrEqual(badgeLeft);
      } else {
        // Wrapped case: name and badge must not share the same vertical band on the same line —
        // assert the badge's vertical center falls within the row's own bounding box (sane sanity check)
        // and that badge and name boxes don't literally intersect.
        const intersects = nameBox.x < badgeBox.x + badgeBox.width && nameBox.x + nameBox.width > badgeBox.x
          && nameBox.y < badgeBox.y + badgeBox.height && nameBox.y + nameBox.height > badgeBox.y;
        expect(intersects).toBe(false);
      }
    }
  });
}
```

- [ ] **Step 3: Run the test against the current codebase**

Run: `npx playwright test tests/e2e/notifications-event-rules-layout.spec.ts`
Expected: PASS (2 tests, one per width) — this confirms in an automated, repeatable way what the manual investigation already found visually.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/notifications-event-rules-layout.spec.ts
git commit -m "test: guard against event-row name/badge overlap regressing"
```

---

## Self-Review Notes

- **Spec coverage**: the original task's acceptance criteria (no overlap for long names, badge stays full width/not clipped, name wraps/truncates gracefully, works at narrow and desktop widths, regression coverage) are all either already satisfied by the existing `290f7b6` CSS (verified by rendering) or covered by the new Task 2 test. No task item requires further CSS changes given the verified current state.
- **Placeholder scan**: Task 2's test has one explicit "copy the existing pattern" instruction (auth setup) rather than inventing one — intentional, matching this codebase's actual (unknown-to-this-plan-author) session/auth mechanics, which the executor must read first.
- **Type consistency**: N/A — no new shared types.

## Execution Handoff

Plan complete and saved to `plans/02-notification-event-badge-overlap.md`. Recommended: **Inline Execution** (superpowers:executing-plans) — this is a small, linear, low-risk verification + test-only plan with no multi-task review checkpoints needed.
