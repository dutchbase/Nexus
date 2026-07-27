// FE-13 — public intake form has no admin chrome and shows the newly-issued
// ticket reference on successful submission (design-handoff/README.md §5.2).
import { test, expect } from "@playwright/test";
import { APP_BASE_URL } from "./playwright-helpers";

// "website-feedback" is the published form seeded in fixtures/seed.sql
// (also the prototype's own default `formSlug`). Field labels below are
// copied verbatim from the prototype's markup for this exact form — README
// §2 says copy is final, so these are safe to depend on directly rather than
// via name-attribute guesses.
const FORM_SLUG = "website-feedback";

test("public form has no admin chrome and shows the ticket reference on success", async ({ page }) => {
  await page.goto(`${APP_BASE_URL}/f/${FORM_SLUG}`);

  // No sidebar/header chrome (§4: "Login and public form: Rendered without
  // sidebar or header — full-bleed inside main"). The sidebar brand title
  // "Development hub" is verbatim copy unique to the admin shell (§4), so
  // its absence is a reasonable structural proxy for "no chrome" that
  // doesn't depend on a specific sidebar selector. Backed up with a
  // role=navigation / role=banner landmark check.
  await expect(page.getByText("Development hub", { exact: false })).toHaveCount(0);
  await expect(page.locator('[role="navigation"]')).toHaveCount(0);
  await expect(page.locator('[role="banner"]')).toHaveCount(0);

  // Required fields, per the prototype's own field list for this form
  // (project, category, title/"Korte samenvatting", description/"Wat gaat
  // er mis of wat mist er?"). Labels are implicit (<label> wraps the
  // control), which getByLabel resolves without needing id/for wiring.
  await page.getByLabel(/Welk project betreft het/i).selectOption({ index: 0 });
  await page.getByLabel(/^Categorie/i).selectOption({ index: 0 });
  await page.getByLabel(/Korte samenvatting/i).fill("Zoekfilters resetten bij terug navigeren");
  await page
    .getByLabel(/Wat gaat er mis of wat mist er/i)
    .fill(
      "Wanneer ik via de browser terugga naar het zoekresultaat staan alle filters weer op de standaardwaarde in plaats van behouden te blijven.",
    );

  // Optional fields — filled anyway since they're plausibly present and
  // filling them shouldn't break submission.
  const urlField = page.getByLabel(/Op welke pagina gebeurt dit/i);
  if (await urlField.count()) {
    await urlField.fill("https://example.com/vacatures?zoek=filters");
  }
  const environmentField = page.getByLabel(/^Omgeving/i);
  if (await environmentField.count()) {
    await environmentField.selectOption({ index: 0 });
  }

  const submit = page.getByRole("button", { name: /melding versturen/i });
  await expect(submit).toBeVisible();
  await submit.click();

  await page.waitForURL(`${APP_BASE_URL}/f/${FORM_SLUG}/submitted`, { timeout: 15000 });
  await expect(page.getByText(/DCC-\d+/)).toBeVisible();
});
