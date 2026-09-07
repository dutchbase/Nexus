// End-user journey: signing in and out of the admin UI.
import { test, expect } from "@playwright/test";
import { loginViaUI, ADMIN_USER } from "./helpers";

test("rejects a wrong password with a visible error and no session", async ({ page }) => {
  await page.goto("/login");
  await page.locator('input[name="username"]').fill(ADMIN_USER);
  await page.locator('input[name="password"]').fill("definitely-not-the-password");
  await page.locator('button[type="submit"]').click();

  await expect(page.locator(".error")).not.toHaveText("");
  expect(page.url()).toContain("/login");

  // Still unauthenticated: /admin bounces back to the login page.
  await page.goto("/admin");
  await page.waitForURL("**/login");
});

test("signs in with valid credentials and lands on the dashboard", async ({ page }) => {
  await loginViaUI(page);
  await expect(page).toHaveURL(/\/admin$/);
  // The admin shell is present (sidebar navigation with the core sections).
  await expect(page.getByRole("link", { name: "Tickets" }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Pull requests" }).first()).toBeVisible();
});

test("unauthenticated visitors are redirected from admin pages to /login", async ({ page }) => {
  await page.goto("/admin/tickets");
  await page.waitForURL("**/login");
});

test("user can sign out from the UI", async ({ page }) => {
  await loginViaUI(page);
  await Promise.all([
    page.waitForURL("**/login", { timeout: 5_000 }),
    page.getByRole("button", { name: /sign out|log out/i }).or(page.getByRole("link", { name: /sign out|log out/i })).first().click({ timeout: 5_000 }),
  ]);
});
