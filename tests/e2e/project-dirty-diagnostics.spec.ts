// End-user journey: repository_dirty diagnostics on the project detail page.
// Uses the customer-portal fixture project, which harness/git-fixtures/
// create-fixtures.sh seeds dirty on purpose (an uncommitted trailing comment
// appended to README.md) — see .lfd/dcc-build/harness/tests/api/
// project-validation.spec.ts for the existing API-level coverage of the same
// fixture. Requires FIXTURE_REPO_CUSTOMER_PORTAL, set by tests/e2e/run-e2e.sh.
import { execFileSync } from "node:child_process";
import { test, expect } from "@playwright/test";
import { loginViaUI, queryOne, waitFor } from "./helpers";

const FIXTURE_REPO_CUSTOMER_PORTAL = process.env.FIXTURE_REPO_CUSTOMER_PORTAL;

test.beforeEach(async ({ page }) => {
  test.skip(!FIXTURE_REPO_CUSTOMER_PORTAL, "FIXTURE_REPO_CUSTOMER_PORTAL not set — run via tests/e2e/run-e2e.sh");
  await loginViaUI(page);
});

test("Recheck repository updates diagnostics in place without a full page reload", async ({ page }) => {
  await page.goto("/admin/projects/customer-portal");
  await page.locator('button[role="tab"]', { hasText: "Validation" }).click();

  // The seeded dirty fixture (README.md, uncommitted) shows up categorized.
  await expect(page.locator("[data-repository-diagnostics]")).toContainText("README.md");
  await expect(page.locator("[data-repository-diagnostics]")).toContainText("Modified");

  // A full page navigation clears any property set on window — surviving
  // this marker after the click proves the recheck updated the DOM in place
  // rather than reloading.
  await page.evaluate(() => { (window as any).__e2eNoReloadMarker = true; });

  const before = await queryOne("select last_validated_at from projects where slug = $1", ["customer-portal"]);
  await page.locator("[data-recheck-repository]").click();
  await expect(page.locator("[data-recheck-repository]")).toHaveText("Checking…");

  await waitFor(
    async () => {
      const after = await queryOne("select last_validated_at from projects where slug = $1", ["customer-portal"]);
      return String(after.last_validated_at) !== String(before.last_validated_at);
    },
    { timeoutMs: 15_000, intervalMs: 500 },
  );

  expect(await page.evaluate(() => (window as any).__e2eNoReloadMarker)).toBe(true);
  await expect(page.locator("[data-recheck-repository]")).toHaveText("Recheck repository");
  // Still (accurately) dirty after the recheck — the fixture wasn't touched.
  await expect(page.locator("[data-repository-diagnostics]")).toContainText("README.md");
});

test("repository becomes healthy after changes are resolved, confirmed via Recheck", async ({ page }) => {
  const repo = FIXTURE_REPO_CUSTOMER_PORTAL as string;
  execFileSync("git", ["-C", repo, "stash", "push", "-u"]);
  try {
    await page.goto("/admin/projects/customer-portal");
    await page.locator('button[role="tab"]', { hasText: "Validation" }).click();
    await page.locator("[data-recheck-repository]").click();

    await waitFor(
      async () => {
        const project = await queryOne("select health_status from projects where slug = $1", ["customer-portal"]);
        return project.health_status === "healthy";
      },
      { timeoutMs: 15_000, intervalMs: 500 },
    );

    await expect(page.locator("[data-repository-diagnostics]")).toContainText("No local changes blocking planning or execution.");
    // The banner disappears once the repository is clean.
    await expect(page.locator("[data-dirty-page-banner]")).toBeEmpty();
  } finally {
    // Restore the fixture's seeded dirty state — other suites (e.g. the
    // harness's OPS-02 project-validation.spec.ts) assume customer-portal
    // stays dirty across the whole e2e run.
    execFileSync("git", ["-C", repo, "stash", "pop"]);
    await page.locator("[data-recheck-repository]").click().catch(() => {});
    await waitFor(
      async () => {
        const project = await queryOne("select health_status from projects where slug = $1", ["customer-portal"]);
        return project.health_status === "repository_dirty";
      },
      { timeoutMs: 15_000, intervalMs: 500 },
    ).catch(() => {});
  }
});
