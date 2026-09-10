import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { loginViaUI, queryOne } from "./helpers";

const password = "reporter-test-password";
const projectOne = "VA Jobs Platform";
const projectTwo = "Corporate Site";

async function addReporter(page: Page, username: string, project: string) {
  await page.goto("/admin/users");
  await page.getByRole("button", { name: "Add user" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Username").fill(username);
  await dialog.getByLabel("Initial password").fill(password);
  await dialog.getByLabel(project).check();
  await dialog.getByRole("button", { name: "Add user" }).click();
  await expect(page.locator("[data-user]", { has: page.getByRole("heading", { name: username }) })).toBeVisible();
}

async function loginReporter(browser: Browser, username: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/login");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await Promise.all([
    page.waitForURL("**/tickets"),
    page.getByRole("button", { name: "Sign in" }).click(),
  ]);
  return { context, page };
}

function userRow(page: Page, username: string) {
  return page.locator("[data-user]", { has: page.getByRole("heading", { name: username }) });
}

test("admin assigns reporters and ticket access follows membership and ownership", async ({ browser, page: adminPage }) => {
  await loginViaUI(adminPage);
  const suffix = Date.now();
  const reporterOne = `reporter-one-${suffix}`;
  const reporterTwo = `reporter-two-${suffix}`;
  await addReporter(adminPage, reporterOne, projectOne);
  await addReporter(adminPage, reporterTwo, projectTwo);

  const first = await loginReporter(browser, reporterOne);
  const second = await loginReporter(browser, reporterTwo);
  try {
    const reporterPage = first.page;
    await expect(reporterPage.getByLabel("Project").first()).toContainText(projectOne);
    await expect(reporterPage.getByLabel("Project").first()).not.toContainText(projectTwo);
    await expect(second.page.getByLabel("Project").first()).toContainText(projectTwo);
    await expect(second.page.getByLabel("Project").first()).not.toContainText(projectOne);

    await reporterPage.getByRole("button", { name: "New ticket" }).click();
    await reporterPage.getByLabel("Title", { exact: true }).fill("Reporter save bug");
    await reporterPage.getByLabel("Description", { exact: true }).fill("Save opens a blank page.");
    await reporterPage.getByRole("button", { name: "Submit ticket" }).click();
    await expect(reporterPage.getByRole("heading", { name: "Reporter save bug" })).toBeVisible();
    await expect(reporterPage.getByRole("link", { name: "Runs", exact: true })).toHaveCount(0);
    const forbidden = await reporterPage.request.get("/api/admin/jobs");
    expect(forbidden.status()).toBe(403);

    const ticketNumber = new URL(reporterPage.url()).pathname.split("/").at(-1)!;
    await reporterPage.getByLabel("Description", { exact: true }).fill("Save now keeps the current page.");
    await reporterPage.getByRole("button", { name: "Save changes" }).click();
    await expect(reporterPage.getByText("Save now keeps the current page.", { exact: true })).toBeVisible();

    expect((await second.page.request.get(`/api/tickets/${ticketNumber}`)).status()).toBe(404);
    await second.page.goto("/tickets/DCC-145");
    await second.page.getByLabel("Description", { exact: true }).fill("Edited by another assigned reporter.");
    await second.page.getByRole("button", { name: "Save changes" }).click();
    await expect(second.page.getByText("Edited by another assigned reporter.", { exact: true })).toBeVisible();

    await reporterPage.getByRole("button", { name: "Delete" }).click();
    await reporterPage.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
    await expect(reporterPage).toHaveURL(/\/tickets$/);
    await adminPage.goto(`/admin/tickets/${ticketNumber}`);
    await expect(adminPage.getByText("Deleted by submitter", { exact: true })).toBeVisible();
    expect(await queryOne("select status, submitter_deleted_at from tickets where ticket_number=$1", [ticketNumber]))
      .toMatchObject({ status: "Submitted", submitter_deleted_at: expect.anything() });

    await reporterPage.getByRole("button", { name: "Log out" }).click();
    await expect(reporterPage).toHaveURL(/\/login$/);
    await reporterPage.getByLabel("Username").fill(reporterOne);
    await reporterPage.getByLabel("Password").fill(password);
    await Promise.all([reporterPage.waitForURL("**/tickets"), reporterPage.getByRole("button", { name: "Sign in" }).click()]);

    await adminPage.goto("/admin/users");
    const row = userRow(adminPage, reporterOne);
    await row.getByText("Edit projects", { exact: true }).click();
    await row.getByLabel(projectOne).uncheck();
    await row.getByRole("button", { name: "Save projects" }).click();
    await expect(userRow(adminPage, reporterOne).getByText("No assigned projects", { exact: true })).toBeVisible();

    expect((await reporterPage.request.get("/api/tickets/DCC-148")).status()).toBe(404);
    expect((await reporterPage.request.get("/attachments/00000000-0000-0000-0000-000000000148")).status()).toBe(404);
    await reporterPage.reload();
    await expect(reporterPage.getByText("No projects assigned.", { exact: false })).toBeVisible();
  } finally {
    await first.context.close();
    await second.context.close();
  }
});

test("deactivating a reporter invalidates an existing session", async ({ browser, page: adminPage }) => {
  await loginViaUI(adminPage);
  const username = `disabled-reporter-${Date.now()}`;
  await addReporter(adminPage, username, projectOne);
  const reporter = await loginReporter(browser, username);
  try {
    await adminPage.goto("/admin/users");
    adminPage.once("dialog", (dialog) => dialog.accept());
    await userRow(adminPage, username).getByRole("button", { name: "Deactivate" }).click();
    await expect(userRow(adminPage, username).getByText("Inactive", { exact: true })).toBeVisible();
    expect((await reporter.page.request.get("/api/session")).status()).toBe(401);
  } finally {
    await reporter.context.close();
  }
});
