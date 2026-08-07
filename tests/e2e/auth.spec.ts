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

// KNOWN GAP: POST /api/admin/logout exists (server.ts:640) but no page or
// shell component renders a sign-out control, so a user cannot log out from
// the UI. test.fail() keeps this documented: it alerts when the control ships.
test("user can sign out from the UI", async ({ page }) => {
  test.fail(true, "no logout button exists anywhere in the admin UI");
  await loginViaUI(page);
  await page.getByRole("button", { name: /sign out|log out/i }).or(page.getByRole("link", { name: /sign out|log out/i })).first().click({ timeout: 5_000 });
  await page.waitForURL("**/login", { timeout: 5_000 });
});
