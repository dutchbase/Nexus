// FE-03, FE-04 — design tokens and theme control (design-handoff/README.md §6, §7).
import { test, expect } from "@playwright/test";
import { loginAsAdmin, APP_BASE_URL, LIGHT_TOKENS, DARK_TOKENS } from "./playwright-helpers";

async function readTokens(page: import("@playwright/test").Page, names: string[]) {
  return page.evaluate((tokenNames) => {
    const style = getComputedStyle(document.documentElement);
    const out: Record<string, string> = {};
    for (const name of tokenNames) {
      out[name] = style.getPropertyValue(name).trim();
    }
    return out;
  }, names);
}

test("design tokens match handoff §7 verbatim in both themes", async ({ page }) => {
  await loginAsAdmin(page);

  const tokenNames = Object.keys(LIGHT_TOKENS);

  // Light theme is the default — no data-theme attribute needed.
  const light = await readTokens(page, tokenNames);
  for (const name of tokenNames) {
    expect(light[name], `light theme ${name}`).toBe(LIGHT_TOKENS[name]);
  }

  // Force dark theme directly (the toggle UI itself is FE-04's job).
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  const dark = await readTokens(page, tokenNames);
  for (const name of tokenNames) {
    expect(dark[name], `dark theme ${name}`).toBe(DARK_TOKENS[name]);
  }
});

test("theme control writes data-theme and Auto follows OS preference", async ({ page }) => {
  await loginAsAdmin(page);

  const lightButton = page.getByRole("button", { name: /^light$/i }).first();
  const autoButton = page.getByRole("button", { name: /^auto$/i }).first();
  const darkButton = page.getByRole("button", { name: /^dark$/i }).first();

  // Explicit Dark selection.
  await darkButton.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  // Persists across reload (cookie / server-side preference, not lost).
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  // Explicit Light selection, also persists.
  await lightButton.click();
  await page.waitForFunction(() => document.documentElement.getAttribute("data-theme") !== "dark");
  await page.reload();
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", "dark");

  // Auto follows matchMedia('(prefers-color-scheme: dark)') and re-applies on change.
  await page.emulateMedia({ colorScheme: "dark" });
  await autoButton.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  await page.emulateMedia({ colorScheme: "light" });
  await page.waitForFunction(() => document.documentElement.getAttribute("data-theme") !== "dark");
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", "dark");

  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForFunction(() => document.documentElement.getAttribute("data-theme") === "dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});
