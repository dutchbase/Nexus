import { expect, test } from "@playwright/test";
import { loginViaUI } from "./helpers";

// C2 verification: PR detail Description card has the same padding wrapper as
// sibling cards, and long lines in AI review history / raw pre blocks wrap
// instead of clipping at the card edge.
test("PR description card is padded and long pre content wraps", async ({ page }) => {
  await loginViaUI(page);
  await page.goto("/admin/pull-requests/billing-api/5");

  // Description card uses the shared head/body wrappers like Metadata.
  const descriptionSection = page.locator("section.card", { has: page.locator(".card-head", { hasText: "Description" }) });
  await expect(descriptionSection).toBeVisible();
  // Content is inset by the shared 18px card-body padding, not flush.
  const inset = await descriptionSection.locator(".card-body").evaluate((body) => {
    const bodyRect = body.getBoundingClientRect();
    const first = body.querySelector("*");
    if (!first) return null;
    const firstRect = first.getBoundingClientRect();
    return { left: firstRect.left - bodyRect.left, top: firstRect.top - bodyRect.top };
  });
  expect(inset).not.toBeNull();
  expect(inset!.left).toBeGreaterThanOrEqual(16);
  expect(inset!.top).toBeGreaterThanOrEqual(16);

  // Every pre on the page wraps: no pre's scroll width exceeds its client width.
  const clippedPres = await page.evaluate(() =>
    [...document.querySelectorAll("pre")]
      .filter((pre) => pre.scrollWidth > pre.clientWidth + 2)
      .map((pre) => pre.textContent?.slice(0, 60)),
  );
  expect(clippedPres).toEqual([]);
});
