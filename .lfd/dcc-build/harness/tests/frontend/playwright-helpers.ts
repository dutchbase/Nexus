// Shared helpers for harness/tests/frontend/**/*.spec.ts (Playwright, browser-level tests).
// See ../../HARNESS_CONVENTIONS.md for the env-var contract these assume, and
// ../../../design-handoff/README.md for the UI spec every assertion here is
// pinned to.
//
// Design note: these tests drive the real login UI (not an API shortcut) so
// a broken /login page fails the suite the same way it would fail a human.
// If the app's actual login-form markup diverges from the selectors below,
// that's a reportable mismatch against this assumption — see the selector
// notes inline.

import type { Page } from "@playwright/test";

export const APP_BASE_URL = process.env.APP_BASE_URL ?? "http://127.0.0.1:3000";

// ---------------------------------------------------------------- design tokens (handoff §7)

export const LIGHT_TOKENS: Record<string, string> = {
  "--bg": "#F7F7F5",
  "--surface": "#FFFFFF",
  "--surface2": "#F0F2F6",
  "--raised": "#FFFFFF",
  "--border": "rgba(11,35,86,.12)",
  "--border2": "rgba(11,35,86,.22)",
  "--text": "#0B2356",
  "--text2": "#3A4A66",
  "--text3": "#8791A5",
  "--accent": "#C8102E",
  "--accent-fg": "#FFFFFF",
  "--accent-soft": "rgba(200,16,46,.08)",
  "--side-bg": "#0B2356",
  "--side-sub": "rgba(255,255,255,.34)",
  "--side-text": "rgba(255,255,255,.62)",
  "--side-active": "#FFFFFF",
  "--side-border": "rgba(255,255,255,.10)",
  "--side-hover": "rgba(255,255,255,.06)",
};

export const DARK_TOKENS: Record<string, string> = {
  "--bg": "#061334",
  "--surface": "#0B2356",
  "--surface2": "#102C6B",
  "--raised": "#0E2657",
  "--border": "rgba(255,255,255,.11)",
  "--border2": "rgba(255,255,255,.22)",
  "--text": "#F2F4F8",
  "--text2": "rgba(242,244,248,.72)",
  "--text3": "rgba(242,244,248,.46)",
  "--accent": "#E5384F",
  "--accent-fg": "#FFFFFF",
  "--accent-soft": "rgba(229,56,79,.15)",
  "--side-bg": "#040E27",
  "--side-sub": "rgba(255,255,255,.30)",
  "--side-text": "rgba(255,255,255,.58)",
  "--side-active": "#FFFFFF",
  "--side-border": "rgba(255,255,255,.08)",
  "--side-hover": "rgba(255,255,255,.05)",
};

// ---------------------------------------------------------------- login

// ASSUMPTION (flagged to the execution agent — see harness report): the app
// doesn't exist yet, so there is no real login-form markup to inspect. Per
// the task's own fallback instructions we standardize on the most
// conventional selectors and fall back once if they're absent:
//   username: input[name="username"]      (fallback: input[type="text"])
//   password: input[name="password"]      (fallback: input[type="password"])
//   submit:   button[type="submit"]       (fallback: role=button "Sign in"/"Log in")
// If the execution agent's real login form uses different attributes, this
// is the ONLY function that needs to change — every spec file in this batch
// goes through it.
export async function loginAsAdmin(page: Page): Promise<void> {
  const username = process.env.DCC_EVAL_ADMIN_USER;
  const password = process.env.DCC_EVAL_ADMIN_PASSWORD;
  if (!username || !password) {
    throw new Error(
      "DCC_EVAL_ADMIN_USER / DCC_EVAL_ADMIN_PASSWORD not set — run-evals.sh must run scripts/create-admin.ts first",
    );
  }

  await page.goto(`${APP_BASE_URL}/login`);

  const usernameField = page.locator('input[name="username"]');
  const usernameInput = (await usernameField.count()) > 0 ? usernameField.first() : page.locator('input[type="text"]').first();
  await usernameInput.fill(username);

  const passwordField = page.locator('input[name="password"]');
  const passwordInput = (await passwordField.count()) > 0 ? passwordField.first() : page.locator('input[type="password"]').first();
  await passwordInput.fill(password);

  const submitButton = page.locator('button[type="submit"]');
  const submit = (await submitButton.count()) > 0 ? submitButton.first() : page.getByRole("button", { name: /sign in|log in/i }).first();

  await Promise.all([page.waitForURL(`${APP_BASE_URL}/admin`), submit.click()]);
}
