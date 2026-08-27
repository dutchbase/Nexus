// Regression guard for the Notifications "Event rules" tab: the event name
// and its status badge must never overlap, even at the longest real event
// name and a narrow viewport. See plans/02-notification-event-badge-overlap.md
// — the CSS fix already lives in design-tokens.css (.event-row / .mono /
// .status, commit 290f7b6); this test exists so a future change (or a
// deploy that silently reverts to a stale in-memory copy of the CSS) gets
// caught automatically instead of relying on a manual browser check again.
import { expect, test } from "@playwright/test";
import { loginViaUI } from "./helpers";
import { NOTIFICATION_EVENTS } from "../../packages/domain/src/notifications.ts";

const WIDTHS = [375, 1440] as const;

for (const width of WIDTHS) {
  test(`event rule rows show no name/badge overlap at ${width}px`, async ({ page }) => {
    await loginViaUI(page);
    await page.setViewportSize({ width, height: 900 });
    // Event rules is the default-selected tab (panel-0 has no `hidden`
    // attribute — see apps/web/src/pages/notifications.ts) so no tab click
    // is needed after navigation.
    await page.goto("/admin/notifications");

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

      // No horizontal overlap: the name's right edge must not extend past
      // the badge's left edge, UNLESS the name has wrapped to multiple
      // lines (its box height will exceed one line-height), in which case
      // only literal box intersection matters.
      const nameRight = nameBox.x + nameBox.width;
      const badgeLeft = badgeBox.x;
      const wrapped = nameBox.height > 24; // single-line rows are ~1 line-height (~18-20px) + padding
      if (!wrapped) {
        expect(nameRight).toBeLessThanOrEqual(badgeLeft);
      } else {
        const intersects =
          nameBox.x < badgeBox.x + badgeBox.width &&
          nameBox.x + nameBox.width > badgeBox.x &&
          nameBox.y < badgeBox.y + badgeBox.height &&
          nameBox.y + nameBox.height > badgeBox.y;
        expect(intersects).toBe(false);
      }
    }
  });
}
