// End-user journey: changing AI model configuration — the global AI-review
// default in Settings, and a ticket's per-phase model override, which must
// carry through to the plan the worker actually generates.
import { test, expect } from "@playwright/test";
import { loginViaUI, queryOne, createTicketViaUI, injectScenarioOnce, scenarioRef, waitForTicketStatus, DEFAULT_PLAN_MARKDOWN } from "./helpers";

test.beforeEach(async ({ page }) => {
  await loginViaUI(page);
});

test("change the default AI review model in settings", async ({ page }) => {
  await page.goto("/admin/settings");
  await page.getByRole("tab", { name: "AI" }).click();
  const form = page.locator("[data-ai-review-settings-form]");
  await form.locator('select[name="default_model"]').selectOption("haiku");
  await form.locator('select[name="default_reasoning_level"]').selectOption("low");
  await form.locator('button[type="submit"]').click();

  // No reload required — the save must resolve in place.
  await expect(form.locator(".error")).toHaveText("Saved");
  await expect(form.locator('select[name="default_model"]')).toHaveValue("haiku");
  const row = await queryOne("select default_model, default_reasoning_level from ai_review_settings where id = 1");
  expect(row).toMatchObject({ default_model: "haiku", default_reasoning_level: "low" });

  // Restore the seeded default so other journeys are unaffected.
  await form.locator('select[name="default_model"]').selectOption("sonnet");
  await form.locator('select[name="default_reasoning_level"]').selectOption("high");
  await form.locator('button[type="submit"]').click();
  await expect(form.locator(".error")).toHaveText("Saved");
});

test("toggling auto-review and auto-merge on the AI PR review defaults form saves without a reload", async ({ page }) => {
  await page.goto("/admin/settings");
  await page.getByRole("tab", { name: "AI" }).click();
  const form = page.locator("[data-ai-review-settings-form]");
  const autoReview = form.locator('input[name="auto_review_enabled"]');
  const autoMerge = form.locator('input[name="auto_merge_on_approve"]');
  const initialReview = await autoReview.isChecked();
  const initialMerge = await autoMerge.isChecked();

  await autoReview.setChecked(!initialReview);
  await autoMerge.setChecked(!initialMerge);
  await form.locator('button[type="submit"]').click();

  await expect(form.locator(".error")).toHaveText("Saved");
  const row = await queryOne("select auto_review_enabled, auto_merge_on_approve from ai_review_settings where id = 1");
  expect(row).toMatchObject({ auto_review_enabled: !initialReview, auto_merge_on_approve: !initialMerge });

  // Restore.
  await autoReview.setChecked(initialReview);
  await autoMerge.setChecked(initialMerge);
  await form.locator('button[type="submit"]').click();
  await expect(form.locator(".error")).toHaveText("Saved");
});

test("clicking Save twice in quick succession only submits once", async ({ page }) => {
  await page.goto("/admin/settings");
  await page.getByRole("tab", { name: "AI" }).click();
  const form = page.locator("[data-ai-review-settings-form]");

  let requestCount = 0;
  await page.route("**/api/admin/settings/ai-review", async (route) => {
    requestCount++;
    await route.continue();
  });

  const submit = form.locator('button[type="submit"]');
  await Promise.all([submit.click(), submit.click()]);
  await expect(form.locator(".error")).toHaveText("Saved");
  expect(requestCount).toBe(1);
});

test("save a per-phase system AI default and have it survive a refresh", async ({ page }) => {
  await page.goto("/admin/settings");
  await page.getByRole("tab", { name: "AI" }).click();
  const form = page.locator("[data-system-ai-settings-form]");
  await form.locator('select[name="planning_model"]').selectOption("deepseek-v4-pro");
  await form.locator('select[name="planning_reasoning_level"]').selectOption("high");
  await form.locator('button[type="submit"]').click();

  // Submitting must POST to /api/admin/settings/system-ai and reload — without
  // its submit handler the browser fell back to a native GET and silently
  // discarded the selection, which read back as "(none)".
  await page.waitForLoadState("load");
  await page.getByRole("tab", { name: "AI" }).click();
  await expect(form.locator('select[name="planning_model"]')).toHaveValue("deepseek-v4-pro");
  const row = await queryOne("select planning_model, planning_reasoning_level from system_ai_settings where id = 1");
  expect(row).toMatchObject({ planning_model: "deepseek-v4-pro", planning_reasoning_level: "high" });

  // Restore the seeded state so other journeys are unaffected.
  await form.locator('select[name="planning_model"]').selectOption("");
  await form.locator('select[name="planning_reasoning_level"]').selectOption("");
  await form.locator('button[type="submit"]').click();
  await page.waitForLoadState("load");
});

test("a phase given a model but no reasoning level reports the error in the form", async ({ page }) => {
  await page.goto("/admin/settings");
  await page.getByRole("tab", { name: "AI" }).click();
  const form = page.locator("[data-system-ai-settings-form]");
  await form.locator('select[name="planning_model"]').selectOption("deepseek-v4-pro");
  await form.locator('select[name="planning_reasoning_level"]').selectOption("");
  await form.locator('button[type="submit"]').click();

  await expect(form.locator(".error")).toHaveText(/planning needs both a model and a reasoning level/);
  const row = await queryOne("select planning_model from system_ai_settings where id = 1");
  expect(row).toMatchObject({ planning_model: null });
});

test("per-ticket advanced AI config drives the planning run's model", async ({ page }) => {
  const title = `E2E ai-config ${Date.now()}`;
  const ticketNumber = await createTicketViaUI(page, title);

  // The AI configuration form lives in the "AI & skills" tab.
  await page.getByRole("tab", { name: "AI & skills" }).click();
  // Switch the ticket to advanced mode and pin the planning phase to haiku/low.
  const aiForm = page.locator("#ai-config");
  await aiForm.locator('select[name="ai_configuration_mode"]').selectOption("advanced");
  await aiForm.locator('select[name="planning_model"]').selectOption("haiku");
  await aiForm.locator('select[name="planning_reasoning_level"]').selectOption("low");
  await aiForm.locator('button[type="submit"]').click();
  await expect(aiForm.locator(".error")).toHaveText("Saved");

  const ticket = await queryOne("select id, planning_model, planning_reasoning_level from tickets where ticket_number = $1", [ticketNumber]);
  expect(ticket).toMatchObject({ planning_model: "haiku", planning_reasoning_level: "low" });

  // The override must reach the actual planning run. The start button is
  // in the Overview tab.
  await injectScenarioOnce(page, "/approve-planning", scenarioRef({ mode: "plan_valid", plan_markdown: DEFAULT_PLAN_MARKDOWN }));
  await page.getByRole("tab", { name: "Overview" }).click();
  await page.locator("[data-start-planning]").click();
  await waitForTicketStatus(ticket.id, ["Plan Ready for Review"]);

  const run = await queryOne("select model, reasoning_level from agent_runs where ticket_id = $1 and run_type = 'planning' order by created_at desc limit 1", [ticket.id]);
  expect(run).toMatchObject({ model: "haiku", reasoning_level: "low" });
});
