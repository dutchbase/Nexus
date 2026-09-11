import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { loginViaUI, queryOne } from "./helpers";

const password = "image-paste-test-password";
const projectOne = "VA Jobs Platform";
const projectTwo = "Corporate Site";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+3MxZ5wAAAABJRU5ErkJggg==", "base64");

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
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const page = await context.newPage();
  await page.goto("/login");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await Promise.all([page.waitForURL("**/tickets"), page.getByRole("button", { name: "Sign in" }).click()]);
  return { context, page };
}

async function copyPng(page: Page) {
  await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 4;
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((value) => resolve(value!), "image/png"));
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
  });
}

async function openCreate(page: Page, project = projectOne) {
  await page.goto("/tickets");
  await page.getByRole("button", { name: "New ticket" }).click();
  await page.getByLabel("Project").nth(1).selectOption({ label: project });
}

test("required source-form images survive edits and only detach after validation allows it", async ({ browser, page: adminPage }) => {
  await loginViaUI(adminPage);
  const suffix = Date.now();
  const ownerName = `image-owner-${suffix}`;
  const editorName = `image-editor-${suffix}`;
  await addReporter(adminPage, ownerName, projectOne);
  await addReporter(adminPage, editorName, projectOne);
  const reporter = await loginReporter(browser, ownerName);
  const editor = await loginReporter(browser, editorName);
  const publicContext = await browser.newContext();
  await publicContext.grantPermissions(["clipboard-read", "clipboard-write"]);
  const publicPage = await publicContext.newPage();
  try {
    const form = await queryOne(`WITH project AS (SELECT id FROM projects WHERE name=$1), created AS (
      INSERT INTO forms(name,slug,title,status,fixed_project_id,settings_json)
      SELECT $2,$3,'Required evidence','published',id,'{"notify_on_submission":false}'::jsonb FROM project RETURNING id,slug)
      INSERT INTO form_fields(form_id,field_key,field_type,label,required,position)
      SELECT id,'title','short_text','Korte samenvatting',true,1 FROM created UNION ALL
      SELECT id,'description','long_text','Wat gaat er mis of wat mist er?',true,2 FROM created UNION ALL
      SELECT id,'evidence','image_upload','Required screenshot',true,3 FROM created RETURNING form_id`,
      [projectOne, `Required image ${suffix}`, `required-image-${suffix}`]);
    expect(form).toBeTruthy();
    await publicPage.goto(`/f/required-image-${suffix}`);
    await copyPng(publicPage);
    let uploads = 0;
    publicPage.on("request", (request) => {
      if (request.method() === "POST" && request.url().endsWith("/uploads")) uploads++;
    });
    const upload = publicPage.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/uploads"));
    await publicPage.getByRole("button", { name: "Paste", exact: true }).click();
    expect((await upload).status()).toBe(201);
    await expect(publicPage.getByRole("img", { name: "Screenshot preview" })).toBeVisible();
    expect(uploads).toBe(1);

    await publicPage.getByRole("button", { name: "Melding versturen" }).click();
    await expect(publicPage.getByLabel("Korte samenvatting", { exact: true })).toBeFocused();
    await publicPage.getByLabel("Korte samenvatting", { exact: true }).fill(`Clipboard evidence ${suffix}`);
    await publicPage.getByLabel("Wat gaat er mis of wat mist er?", { exact: true }).fill("The pasted image should be retained.");
    await publicPage.getByRole("button", { name: "Melding versturen" }).click();
    await publicPage.waitForURL("**/submitted**");
    expect(uploads).toBe(1);

    const ticketNumber = (await queryOne("SELECT ticket_number FROM tickets WHERE title=$1", [`Clipboard evidence ${suffix}`])).ticket_number;
    await reporter.page.goto(`/tickets/${ticketNumber}`);
    const attachment = await queryOne(`SELECT a.id,a.upload_id FROM attachments a JOIN tickets t ON t.id=a.ticket_id WHERE t.ticket_number=$1`, [ticketNumber]);
    expect(attachment).toBeTruthy();
    await reporter.page.getByLabel("Wat gaat er mis of wat mist er?", { exact: true }).fill("Unrelated edit keeps required evidence.");
    await reporter.page.getByRole("button", { name: "Save changes" }).click();
    await expect(reporter.page.getByRole("heading", { name: `Clipboard evidence ${suffix}` })).toBeVisible();
    expect((await queryOne("SELECT ticket_id FROM attachments WHERE id=$1", [attachment.id])).ticket_id).toBeTruthy();

    await editor.page.goto(`/tickets/${ticketNumber}`);
    await editor.page.getByRole("button", { name: "Save changes" }).click();
    expect((await queryOne("SELECT ticket_id FROM attachments WHERE id=$1", [attachment.id])).ticket_id).toBeTruthy();
    await editor.page.getByRole("button", { name: "Remove", exact: true }).click();
    await editor.page.getByRole("button", { name: "Save changes" }).click();
    await expect(editor.page.getByText("Add at least one image.", { exact: true })).toBeVisible();
    expect((await queryOne("SELECT ticket_id FROM attachments WHERE id=$1", [attachment.id])).ticket_id).toBeTruthy();
    const serverValidation = await editor.page.evaluate(async ({ ticketNumber }) => {
      const csrf = sessionStorage.getItem("dccCsrf") ?? "";
      const submission_revision = Number((document.querySelector('[name="submission_revision"]') as HTMLInputElement).value);
      const response = await fetch(`/api/tickets/${encodeURIComponent(ticketNumber)}`, {
        method: "PATCH", headers: { "content-type": "application/json", "x-csrf-token": csrf },
        body: JSON.stringify({ submission_revision, attachment_upload_ids: { evidence: [] } }),
      });
      return { status: response.status, body: await response.json() };
    }, { ticketNumber });
    expect(serverValidation).toEqual({ status: 422, body: { error: "validation failed", fields: { evidence: "required" } } });

    await queryOne("UPDATE form_fields SET required=false WHERE form_id=$1 AND field_key='evidence' RETURNING id", [form.form_id]);
    await editor.page.goto(`/tickets/${ticketNumber}`);
    await editor.page.getByRole("button", { name: "Remove", exact: true }).click();
    await editor.page.getByRole("button", { name: "Save changes" }).click();
    await expect(editor.page.getByText("No images attached.", { exact: true })).toBeVisible();
    expect((await queryOne("SELECT ticket_id FROM attachments WHERE id=$1", [attachment.id])).ticket_id).toBeNull();
  } finally {
    await reporter.context.close();
    await editor.context.close();
    await publicContext.close();
  }
});

test("retry, removal races, picker limits, and clipboard failures keep the form usable", async ({ browser, page: adminPage }) => {
  await loginViaUI(adminPage);
  const username = `image-errors-${Date.now()}`;
  await addReporter(adminPage, username, projectOne);
  const reporter = await loginReporter(browser, username);
  try {
    await openCreate(reporter.page);
    let attempts = 0;
    await reporter.page.route("**/uploads", async (route) => {
      attempts++;
      if (attempts === 1) await route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"temporary"}' });
      else await route.continue();
    });
    await reporter.page.locator("[data-image-picker]").setInputFiles({ name: "retry.png", mimeType: "image/png", buffer: png });
    await expect(reporter.page.getByText("One or more images could not be uploaded.")).toBeVisible();
    const retried = reporter.page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/uploads") && response.status() === 201);
    await reporter.page.getByRole("button", { name: "Retry" }).click();
    await retried;
    await expect(reporter.page.locator('[data-status="ready"]')).toHaveCount(1);

    await reporter.page.unroute("**/uploads");
    await reporter.page.route("**/uploads", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      await route.continue().catch(() => {});
    });
    await reporter.page.locator("[data-image-picker]").setInputFiles({ name: "remove.png", mimeType: "image/png", buffer: png });
    await reporter.page.locator('[data-status="uploading"]').getByRole("button", { name: "Remove" }).click();
    await expect(reporter.page.getByText("remove.png")).toHaveCount(0);
    await reporter.page.unroute("**/uploads");

    await reporter.page.locator("[data-image-picker]").setInputFiles(Array.from({ length: 5 }, (_, index) => ({ name: `${index}.png`, mimeType: "image/png", buffer: png })));
    await expect(reporter.page.locator('[data-status="ready"]')).toHaveCount(5);
    await copyPng(reporter.page);
    await reporter.page.getByRole("button", { name: "Paste", exact: true }).click();
    await expect(reporter.page.getByText("You can add at most 5 images.")).toBeVisible();

    await reporter.page.getByRole("button", { name: "Remove", exact: true }).last().click();
    await reporter.page.locator("[data-image-picker]").setInputFiles({ name: "too-big.png", mimeType: "image/png", buffer: Buffer.alloc(5 * 1024 * 1024 + 1) });
    await expect(reporter.page.getByText("Each image must be 5 MB or smaller.")).toBeVisible();

    await reporter.page.evaluate(async () => navigator.clipboard.writeText("https://example.test/not-an-image.png"));
    await reporter.page.getByRole("button", { name: "Paste", exact: true }).click();
    await expect(reporter.page.getByText("No image found on your clipboard.")).toBeVisible();
    await reporter.page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { read: async () => { throw new DOMException("denied", "NotAllowedError"); } } }));
    await reporter.page.getByRole("button", { name: "Paste", exact: true }).click();
    await expect(reporter.page.getByText("Could not read your clipboard. Allow access or choose an image file.")).toBeVisible();
    await expect(reporter.page.getByText("Choose files")).toBeVisible();
  } finally {
    await reporter.context.close();
  }
});

test("attachment reads follow project membership and revocation leaves uploads unclaimed", async ({ browser, page: adminPage }) => {
  await loginViaUI(adminPage);
  const suffix = Date.now();
  const ownerName = `image-scope-owner-${suffix}`;
  const outsiderName = `image-scope-outsider-${suffix}`;
  await addReporter(adminPage, ownerName, projectOne);
  await addReporter(adminPage, outsiderName, projectTwo);
  const owner = await loginReporter(browser, ownerName);
  const outsider = await loginReporter(browser, outsiderName);
  try {
    await openCreate(owner.page);
    const uploaded = owner.page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/uploads"));
    await owner.page.locator("[data-image-picker]").setInputFiles({ name: "private.png", mimeType: "image/png", buffer: png });
    const uploadId = (await (await uploaded).json()).upload_id;
    await owner.page.getByLabel("Korte samenvatting", { exact: true }).fill("Private image");
    await owner.page.getByLabel("Wat gaat er mis of wat mist er?", { exact: true }).fill("Project scoped evidence.");
    await owner.page.getByRole("button", { name: "Submit ticket" }).click();
    await expect(owner.page.getByRole("heading", { name: "Private image" })).toBeVisible();
    const attachment = await queryOne("SELECT id FROM attachments WHERE upload_id=$1", [uploadId]);
    expect((await owner.page.request.get(`/attachments/${attachment.id}`)).status()).toBe(200);
    expect((await outsider.page.request.get(`/attachments/${attachment.id}`)).status()).toBe(404);
    expect((await outsider.page.request.get(`/admin/attachments/${attachment.id}`)).status()).toBe(403);

    await openCreate(owner.page);
    const orphanResponse = owner.page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/uploads"));
    await owner.page.locator("[data-image-picker]").setInputFiles({ name: "orphan.png", mimeType: "image/png", buffer: png });
    const orphanId = (await (await orphanResponse).json()).upload_id;
    await adminPage.goto("/admin/users");
    const row = adminPage.locator("[data-user]", { has: adminPage.getByRole("heading", { name: ownerName }) });
    await row.getByText("Edit projects", { exact: true }).click();
    await row.getByLabel(projectOne).uncheck();
    await row.getByRole("button", { name: "Save projects" }).click();
    await owner.page.getByLabel("Korte samenvatting", { exact: true }).fill("Revoked before save");
    await owner.page.getByLabel("Wat gaat er mis of wat mist er?", { exact: true }).fill("Must not claim the upload.");
    const submission = owner.page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/api/tickets"));
    await owner.page.getByRole("button", { name: "Submit ticket" }).click();
    expect((await submission).status()).toBe(404);
    expect((await queryOne("SELECT ticket_id FROM attachments WHERE upload_id=$1", [orphanId])).ticket_id).toBeNull();
  } finally {
    await owner.context.close();
    await outsider.context.close();
  }
});
