import { expect, test, type Page } from "@playwright/test";
import { loginViaUI } from "./helpers";

// Visual sweep: every admin route at common desktop widths in both themes.
// Asserts nothing overflows the viewport horizontally (the audit found the
// dashboard's "Open triage" button clipped off-screen at ~1425px) and drops
// a screenshot per route for eyeballing. Not a journey suite — read-only
// navigation only.

const WIDTHS = [1024, 1280, 1366, 1425, 1440] as const;

const ROUTES = [
  "/admin",
  "/admin/tickets",
  "/admin/tickets/DCC-145",
  "/admin/runs",
  "/admin/queue",
  "/admin/pull-requests",
  "/admin/merge",
  "/admin/projects",
  "/admin/projects/va-jobs-platform",
  "/admin/forms",
  "/admin/prompts",
  "/admin/skills",
  "/admin/notifications",
  "/admin/ai-usage",
  "/admin/audit",
  "/admin/settings",
  "/admin/system",
];

async function setTheme(page: Page, theme: "light" | "dark") {
  await page.evaluate((value) => {
    localStorage.setItem("dccTheme", value);
    const dark = value === "dark";
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  }, theme);
}

test.describe.configure({ mode: "serial" });

test("no route overflows the viewport at common widths", async ({ page }) => {
  await loginViaUI(page);

  for (const width of WIDTHS) {
    for (const theme of ["light", "dark"] as const) {
      for (const route of ROUTES) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(route);
        await setTheme(page, theme);
        // Re-render-dependent layout settles after theme swap; fonts are
        // system fonts so one frame is enough.
        await page.waitForTimeout(50);
        const overflow = await page.evaluate(() => {
          const viewport = window.innerWidth;
          const docWidth = document.documentElement.scrollWidth;
          if (docWidth <= viewport) return null;
          // Name the widest offenders so the fix is obvious from the log.
          const offenders = [...document.querySelectorAll("*")]
            .map((el) => ({ el, rect: el.getBoundingClientRect() }))
            .filter(({ rect }) => rect.right > viewport + 1)
            .sort((a, b) => b.rect.width - a.rect.width)
            .slice(0, 5)
            .map(({ el, rect }) => `${el.tagName.toLowerCase()}${el.className && typeof el.className === "string" ? `.${el.className.split(" ")[0]}` : ""} w=${Math.round(rect.width)}`);
          return `viewport=${viewport} scrollWidth=${docWidth}; widest: ${offenders.join(", ")}`;
        });
        const label = `${theme}-${width}-${route.replaceAll("/", "_")}`;
        expect(overflow, `${label}: horizontal overflow`).toBeNull();
        await page.screenshot({ path: `tests/e2e/.results/visual-sweep/${label}.png`, fullPage: false });
      }
    }
  }
});
