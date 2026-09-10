import { expect, test, type Browser } from "@playwright/test";
import { loginViaUI, queryOne, waitFor } from "./helpers";

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
    await reporter.getByLabel("Jam link").fill("https://jam.dev/c/delayed-capture?utm_source=test");
    await reporter.getByRole("button", { name: "Submit ticket" }).click();
    await expect(reporter.getByRole("heading", { name: "Jam delayed import" })).toBeVisible();
    await expect(reporter.getByText("Import pending")).toBeVisible();
    await expect(reporter.getByText("Details imported")).toBeVisible({ timeout: 15_000 });

    const ref = new URL(reporter.url()).pathname.split("/").at(-1)!;
    const scoped = await reporter.request.get(`/api/tickets/${ref}`);
    expect(JSON.stringify(await scoped.json())).not.toContain("delayed-capture save failed");
    expect((await reporter.request.get(`/api/admin/tickets/${ref}`)).status()).toBe(403);
    expect((await reporter.request.get(`/api/admin/tickets/${ref}/prompt-preview`)).status()).toBe(403);

    await admin.goto(`/admin/tickets/${ref}`);
    await expect(admin.getByText("Mock Browser", { exact: false })).toBeVisible();
    await expect(admin.getByText("delayed-capture save failed", { exact: false })).toBeVisible();
    await expect(admin.getByText("Unavailable sections", { exact: true })).toBeVisible();
    await expect(admin.getByText("Truncated sections", { exact: true })).toBeVisible();
    const preview = await admin.request.get(`/api/admin/tickets/${ref}/prompt-preview`);
    expect(await preview.text()).toContain("delayed-capture save failed");
  } finally { await context.close(); }
});

test("delayed Jam imports cannot restore replaced, cleared, or submitter-deleted evidence", async ({ browser, page: admin }) => {
  await loginViaUI(admin);
  const username = `jam-race-${Date.now()}`, password = "jam-reporter-password";
  await admin.goto("/admin/users");
  await admin.getByRole("button", { name: "Add user" }).click();
  const dialog = admin.getByRole("dialog");
  await dialog.getByLabel("Username").fill(username);
  await dialog.getByLabel("Initial password").fill(password);
  await dialog.getByLabel("VA Jobs Platform").check();
  await dialog.getByRole("button", { name: "Add user" }).click();
  const context = await browser.newContext(), reporter = await context.newPage();
  const create = async (title: string, jamId: string) => {
    await reporter.goto("/tickets");
    await reporter.getByRole("button", { name: "New ticket" }).click();
    await reporter.getByLabel("Korte samenvatting").fill(title);
    await reporter.getByLabel("Wat gaat er mis of wat mist er?").fill("Race boundary.");
    await reporter.getByLabel("Jam link").fill(`https://jam.dev/c/${jamId}`);
    await reporter.getByRole("button", { name: "Submit ticket" }).click();
    return new URL(reporter.url()).pathname.split("/").at(-1)!;
  };
  try {
    await reporter.goto("/login");
    await reporter.getByLabel("Username").fill(username); await reporter.getByLabel("Password").fill(password);
    await Promise.all([reporter.waitForURL("**/tickets"), reporter.getByRole("button", { name: "Sign in" }).click()]);

    const replaced = await create("Replace delayed Jam", "delayed-old");
    const replacedOldJob = await queryOne("SELECT j.id FROM jobs j JOIN tickets t ON t.id=(j.payload_json->>'ticket_id')::uuid WHERE t.ticket_number=$1 AND j.type='ticket.jam_enrich' ORDER BY j.created_at LIMIT 1", [replaced]);
    await reporter.getByLabel("Jam link").fill("https://jam.dev/c/replacement");
    await reporter.getByRole("button", { name: "Save changes" }).click();
    await expect(reporter.getByText("Details imported")).toBeVisible({ timeout: 15_000 });
    await waitFor(async () => ["completed", "failed"].includes((await queryOne("SELECT status FROM jobs WHERE id=$1", [replacedOldJob.id]))?.status));
    await admin.goto(`/admin/tickets/${replaced}`);
    await expect(admin.getByText("replacement save failed", { exact: false })).toBeVisible();
    await expect(admin.getByText("delayed-old save failed", { exact: false })).toHaveCount(0);

    const cleared = await create("Clear delayed Jam", "delayed-clear");
    const clearedOldJob = await queryOne("SELECT j.id FROM jobs j JOIN tickets t ON t.id=(j.payload_json->>'ticket_id')::uuid WHERE t.ticket_number=$1 AND j.type='ticket.jam_enrich' ORDER BY j.created_at LIMIT 1", [cleared]);
    await reporter.getByLabel("Jam link").fill("");
    await reporter.getByRole("button", { name: "Save changes" }).click();
    await waitFor(async () => ["completed", "failed"].includes((await queryOne("SELECT status FROM jobs WHERE id=$1", [clearedOldJob.id]))?.status));
    await waitFor(async () => !(await queryOne("SELECT c.ticket_id FROM ticket_jam_contexts c JOIN tickets t ON t.id=c.ticket_id WHERE t.ticket_number=$1", [cleared])));
    await admin.goto(`/admin/tickets/${cleared}`);
    await expect(admin.getByText("Jam technical evidence", { exact: true })).toHaveCount(0);

    const deleted = await create("Delete delayed Jam", "delayed-delete");
    const deletedOldJob = await queryOne("SELECT j.id FROM jobs j JOIN tickets t ON t.id=(j.payload_json->>'ticket_id')::uuid WHERE t.ticket_number=$1 AND j.type='ticket.jam_enrich' ORDER BY j.created_at LIMIT 1", [deleted]);
    await reporter.getByRole("button", { name: "Delete" }).click();
    await reporter.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
    await waitFor(async () => ["completed", "failed"].includes((await queryOne("SELECT status FROM jobs WHERE id=$1", [deletedOldJob.id]))?.status));
    const row = await queryOne("SELECT c.state,c.data_json FROM ticket_jam_contexts c JOIN tickets t ON t.id=c.ticket_id WHERE t.ticket_number=$1", [deleted]);
    expect(row.data_json).toBeNull(); expect(["queued", "fetching"]).toContain(row.state);
  } finally { await context.close(); }
});

test("public and transient Jam imports queue safely without exposing evidence", async ({ page }) => {
  await queryOne(`INSERT INTO form_fields(form_id,field_key,field_type,label,position)
    VALUES('00000000-0000-0000-0005-000000000001','jam_url','jam_link','Jam link',99)
    ON CONFLICT(form_id,field_key) DO UPDATE SET field_type='jam_link',label='Jam link' RETURNING id`);
  const title = `Public Jam ${Date.now()}`;
  await page.goto("/f/website-feedback");
  await page.locator('select[name="project_id"]').selectOption({ index: 1 });
  await page.locator('input[name="title"]').fill(title);
  await page.locator('textarea[name="description"]').fill("Public Jam evidence.");
  await page.getByLabel("Jam link").fill("https://jam.dev/c/transient-retry");
  await page.getByRole("button", { name: /submit|verstuur/i }).click();
  await expect(page).toHaveURL(/\/submitted/);
  await expect(page.getByText("transient-retry save failed", { exact: false })).toHaveCount(0);
  await waitFor(async () => (await queryOne("SELECT c.state FROM ticket_jam_contexts c JOIN tickets t ON t.id=c.ticket_id WHERE t.title=$1", [title]))?.state === "ready", { timeoutMs: 20_000 });
  expect((await queryOne("SELECT attempt FROM jobs j JOIN tickets t ON t.id=(j.payload_json->>'ticket_id')::uuid WHERE t.title=$1 AND j.type='ticket.jam_enrich'", [title])).attempt).toBe(2);
});
