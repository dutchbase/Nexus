import { expect, test, type Browser } from "@playwright/test";
import { loginViaUI } from "./helpers";

test("Jam evidence imports after save and remains admin-only", async ({ browser, page: admin }) => {
  await loginViaUI(admin);
  const username = `jam-reporter-${Date.now()}`, password = "jam-reporter-password";
  await admin.goto("/admin/users");
  await admin.getByRole("button", { name: "Add user" }).click();
  const dialog = admin.getByRole("dialog");
  await dialog.getByLabel("Username").fill(username);
  await dialog.getByLabel("Initial password").fill(password);
  await dialog.getByLabel("VA Jobs Platform").check();
  await dialog.getByRole("button", { name: "Add user" }).click();

  const context = await browser.newContext();
  const reporter = await context.newPage();
  try {
    await reporter.goto("/login");
    await reporter.getByLabel("Username").fill(username);
    await reporter.getByLabel("Password").fill(password);
    await Promise.all([reporter.waitForURL("**/tickets"), reporter.getByRole("button", { name: "Sign in" }).click()]);
    await reporter.getByRole("button", { name: "New ticket" }).click();
    await reporter.getByLabel("Korte samenvatting").fill("Jam delayed import");
    await reporter.getByLabel("Wat gaat er mis of wat mist er?").fill("Evidence arrives after submission.");
    await reporter.getByLabel("Jam link").fill("https://jam.dev/c/mock-capture?utm_source=test");
    await reporter.getByRole("button", { name: "Submit ticket" }).click();
    await expect(reporter.getByRole("heading", { name: "Jam delayed import" })).toBeVisible();
    await expect(reporter.getByText("Import pending")).toBeVisible();
    await expect(reporter.getByText("Details imported")).toBeVisible({ timeout: 15_000 });

    const ref = new URL(reporter.url()).pathname.split("/").at(-1)!;
    const scoped = await reporter.request.get(`/api/tickets/${ref}`);
    expect(JSON.stringify(await scoped.json())).not.toContain("mock save failed");
    expect((await reporter.request.get(`/api/admin/tickets/${ref}`)).status()).toBe(403);

    await admin.goto(`/admin/tickets/${ref}`);
    await expect(admin.getByText("Mock Browser", { exact: false })).toBeVisible();
    await expect(admin.getByText("mock save failed", { exact: false })).toBeVisible();
    const preview = await admin.request.get(`/api/admin/tickets/${ref}/prompt-preview`);
    expect(await preview.text()).toContain("mock save failed");
  } finally { await context.close(); }
});
