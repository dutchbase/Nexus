// Regression guard for the Notifications "Event rules" tab: the event name
// must never overlap or displace its status badge, and the badge must never
// be squashed. See plans/02-notification-event-badge-overlap.md — the CSS
// lives in design-tokens.css (.event-row / .mono / .status, commit 290f7b6).
//
// The seven names in NOTIFICATION_EVENTS are all short enough to sit beside
// the badge with or without that CSS, so asserting only on the shipped list
// proves nothing: it stays green even with the .event-row rules deleted
// outright (verified by mutation-testing this spec against a running app).
// Each width therefore runs twice — once on the shipped names, then again
// after swapping in a name sized to overflow that row — which is the case
// the CSS exists to handle, and the case that fails without it.
//
// NOT VERIFIED HERE — the deployed host still needs checking by hand.
// plans/02 Task 1 Step 2 asks whether the running production process is
// actually serving this CSS: apps/web/src/ui.ts reads design-tokens.css into
// a module-level constant once at startup, so a process started before
// 290f7b6 landed keeps serving the pre-fix stylesheet from memory no matter
// what is on disk. That needs a real deployed URL and cannot run from the
// hermetic e2e stack:
//   curl -s "https://<deployed-host>/assets/design-tokens.css?cachebust=$(date +%s)" | grep -c "\.event-row"
// Expect >= 1; a 0 means the fix is not live and the host needs a restart or
// redeploy. Until someone runs that, this fix is confirmed in source and in
// test, but NOT confirmed live.
import { expect, test, type Page } from "@playwright/test";
import { loginViaUI } from "./helpers";
import { NOTIFICATION_EVENTS } from "../../packages/domain/src/notifications.ts";

const WIDTHS = [375, 1440] as const;

// Repeated until it is wider than the row it goes in. Dot-separated like a
// real event name, which normal word-wrap will not break — only the
// overflow-wrap in .event-row .mono can.
const LONG_NAME_SEGMENT = "a.very.long.future.event.name.that.will.never.fit.beside.its.badge.";

type RowLayout = {
  event: string;
  nameTextOverlapsBadge: boolean;
  nameTextEscapesRow: boolean;
  badgeEscapesRow: boolean;
  badgeLineCount: number;
  badgeClipped: boolean;
  pageOverflows: boolean;
};

// Measures what a reader would actually see: the ink of the event name (the
// text's own client rects, not the flex item's box, which always stops
// politely at the gap however broken the layout is) against the badge box
// and the row it is supposed to stay inside.
async function measureRows(page: Page): Promise<RowLayout[]> {
  return page.$$eval(".event-row", (rows) =>
    rows.map((row) => {
      const name = row.querySelector(".mono") as HTMLElement;
      const badge = row.querySelector(".status") as HTMLElement;
      const rowBox = row.getBoundingClientRect();
      const badgeBox = badge.getBoundingClientRect();

      const rectsOf = (el: HTMLElement) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        return [...range.getClientRects()];
      };
      const intersects = (a: DOMRect, b: DOMRect) =>
        a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
      const nameRects = rectsOf(name);

      return {
        event: name.textContent ?? "",
        nameTextOverlapsBadge: nameRects.some((rect) => intersects(rect, badgeBox)),
        // Without min-width:0/overflow-wrap the name refuses to wrap and its
        // text runs straight out through the side of the card instead.
        nameTextEscapesRow: nameRects.some((rect) => rect.right > rowBox.right + 1),
        // A badge shoved past the row's border box was pushed out by a name
        // that would not shrink.
        badgeEscapesRow: badgeBox.right > rowBox.right + 1,
        // Without flex-shrink:0 the badge gets squeezed under its label's
        // width and the label wraps onto extra lines.
        badgeLineCount: rectsOf(badge).length,
        badgeClipped: badge.scrollWidth > Math.ceil(badgeBox.width),
        pageOverflows: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      };
    }),
  );
}

function expectRowsIntact(layouts: RowLayout[], phase: string) {
  expect(layouts.length, `${phase}: no event rows rendered`).toBeGreaterThan(0);
  for (const { event, ...layout } of layouts) {
    const where = `${phase} [${event.slice(0, 32)}]`;
    expect(layout.nameTextOverlapsBadge, `${where}: name text overlaps the badge`).toBe(false);
    expect(layout.nameTextEscapesRow, `${where}: name text runs outside its row`).toBe(false);
    expect(layout.badgeEscapesRow, `${where}: badge pushed outside its row`).toBe(false);
    expect(layout.badgeLineCount, `${where}: badge squashed onto multiple lines`).toBe(1);
    expect(layout.badgeClipped, `${where}: badge clipped`).toBe(false);
    expect(layout.pageOverflows, `${where}: page scrolls horizontally`).toBe(false);
  }
}

for (const width of WIDTHS) {
  test(`event rule rows show no name/badge overlap at ${width}px`, async ({ page }) => {
    await loginViaUI(page);
    await page.setViewportSize({ width, height: 900 });
    // Event rules is the default-selected tab (panel-0 has no `hidden`
    // attribute — see apps/web/src/pages/notifications.ts) so no tab click
    // is needed after navigation.
    await page.goto("/admin/notifications");

    const shipped = await measureRows(page);
    expect(shipped.map((row) => row.event)).toEqual([...NOTIFICATION_EVENTS]);
    expectRowsIntact(shipped, "shipped event names");

    // 6px is a floor on the monospace glyph width at this font size, so the
    // padded-out name is guaranteed wider than the row whatever the width.
    await page.$$eval(
      ".event-row",
      (rows, segment) => {
        for (const row of rows) {
          const name = row.querySelector(".mono") as HTMLElement;
          const needed = Math.ceil(row.getBoundingClientRect().width / 6) + 20;
          let text = "";
          while (text.length < needed) text += segment;
          name.textContent = text.slice(0, needed);
        }
      },
      LONG_NAME_SEGMENT,
    );
    expectRowsIntact(await measureRows(page), "over-long event name");
  });
}
