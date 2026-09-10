// End-user journey: a visitor submits the public intake form and the ticket
// shows up for the administrator.
import { test, expect } from "@playwright/test";
import { loginViaUI, queryOne, waitFor } from "./helpers";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+3MxZ5wAAAABJRU5ErkJggg==", "base64");

test("public form submission creates a ticket the admin can see", async ({ page }) => {
  const title = `E2E public intake ${Date.now()}`;

  await page.goto("/f/website-feedback");
  await page.locator('select[name="project_id"]').selectOption({ index: 1 });
  await page.locator('input[name="title"]').fill(title);
  await page.locator('textarea[name="description"]').fill("Submitted by the e2e journey suite through the real public form.");
  await page.locator('input[name="submitter_email"]').fill("e2e@example.test");
  await page.locator('button[type="submit"]').click();

  // Confirmation page shows the ticket reference (DCC-xxx).
  await page.waitForURL("**/submitted**");
  const refText = await page.locator("body").innerText();
  const match = refText.match(/DCC-\d+/);
  expect(match, `confirmation page should show a ticket reference, got: ${refText.slice(0, 300)}`).toBeTruthy();
  const ticketNumber = match![0];

  // Ground truth: the ticket exists with status Submitted.
  let row: any;
  await waitFor(async () => {
    row = await queryOne("select * from tickets where ticket_number = $1", [ticketNumber]);
    return !!row;
  });
  expect(row.title).toBe(title);
  expect(row.status).toBe("Submitted");

  // The admin sees it in the tickets list.
  await loginViaUI(page);
  await page.goto(`/admin/tickets?search=${encodeURIComponent(title)}`);
  await expect(page.locator(".ticket-row", { hasText: ticketNumber })).toBeVisible();
});

test("honeypot-filled submission is silently dropped", async ({ page }) => {
  const title = `E2E honeypot ${Date.now()}`;
  await page.goto("/f/website-feedback");
  await page.locator('select[name="project_id"]').selectOption({ index: 1 });
  await page.locator('input[name="title"]').fill(title);
  await page.locator('textarea[name="description"]').fill("Spam bot filling every field including the hidden one.");
  await page.locator('input[name="website"]').fill("https://spam.example");
  await page.locator('button[type="submit"]').click();

  // Whatever the page shows, no ticket may exist for this title.
  await page.waitForTimeout(1_500);
  const row = await queryOne("select id from tickets where title = $1", [title]);
  expect(row).toBeNull();
});

test("public image fields upload when enabled and disappear when attachments are disabled", async ({ page }) => {
  const form = await queryOne("SELECT id,settings_json FROM forms WHERE slug='website-feedback'");
  await queryOne(`INSERT INTO form_fields(form_id,field_key,label,field_type,required,position)
    VALUES($1,'evidence','Screenshot','image_upload',false,999) RETURNING id`, [form.id]);
  try {
    await page.goto("/f/website-feedback");
    const upload = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/uploads"));
    await page.locator("[data-image-picker]").setInputFiles({ name: "public.png", mimeType: "image/png", buffer: png });
    expect((await upload).status()).toBe(201);
    await expect(page.getByRole("img", { name: "Screenshot preview" })).toBeVisible();

    await queryOne("UPDATE forms SET settings_json=jsonb_set(settings_json,'{allow_image_attachments}','false'::jsonb) WHERE id=$1 RETURNING id", [form.id]);
    await page.reload();
    await expect(page.getByRole("button", { name: "Paste", exact: true })).toBeDisabled();
    await expect(page.locator("[data-image-picker]")).toBeDisabled();
  } finally {
    await queryOne("DELETE FROM form_fields WHERE form_id=$1 AND field_key='evidence' RETURNING id", [form.id]);
    await queryOne("UPDATE forms SET settings_json=$2 WHERE id=$1 RETURNING id", [form.id, form.settings_json]);
  }
});
