// End-user journey: administrator manages a ticket's lifecycle from the UI —
// create, acknowledge, add a note, reject, archive.
//
// Semantics verified against the app: tickets created by an admin through the
// modal start in "Triage" (server.ts:1413); only public form submissions
// start in "Submitted", so the Acknowledge button applies to those.
import { test, expect } from "@playwright/test";
import { loginViaUI, queryOne, waitFor, createTicketViaUI, submitPublicTicket } from "./helpers";

test.beforeEach(async ({ page }) => {
  await loginViaUI(page);
});

test("create ticket via modal lands in Triage, ready for planning, and takes notes", async ({ page }) => {
  const title = `E2E lifecycle ${Date.now()}`;
  const ticketNumber = await createTicketViaUI(page, title);

  await expect(page.locator("[data-start-planning]")).toBeEnabled();
  await expect(page.locator("[data-acknowledge-ticket]")).toBeDisabled();

  const noteBody = `Note from the e2e suite ${Date.now()}`;
  const notesForm = page.locator("[data-notes-form]");
  await notesForm.locator('[name="body"]').fill(noteBody);
  await notesForm.locator('button[type="submit"]').click();
  await expect(page.locator("body")).toContainText(noteBody);
  void ticketNumber;
});

test("acknowledge a publicly submitted ticket from the detail page", async ({ page }) => {
  const title = `E2E acknowledge ${Date.now()}`;
  const ticketNumber = await submitPublicTicket(page, title);

  await page.goto(`/admin/tickets/${ticketNumber}`);
  await expect(page.locator("[data-acknowledge-ticket]")).toBeEnabled();
  await page.locator("[data-acknowledge-ticket]").click();

  await waitFor(async () => (await queryOne("select status from tickets where ticket_number = $1", [ticketNumber]))?.status === "Triage");
  await expect(page.locator("[data-acknowledge-ticket]")).toBeDisabled();
  await expect(page.locator("[data-start-planning]")).toBeEnabled();
});

test("reject an early-stage ticket, then archive it", async ({ page }) => {
  const title = `E2E reject ${Date.now()}`;
  const ticketNumber = await createTicketViaUI(page, title);

  page.on("dialog", (dialog) => dialog.accept());
  await expect(page.locator("[data-reject-ticket]")).toBeEnabled();
  await page.locator("[data-reject-ticket]").click();
  await waitFor(async () => (await queryOne("select status from tickets where ticket_number = $1", [ticketNumber]))?.status === "Rejected");

  // Rejected tickets can be archived from the danger zone.
  await expect(page.locator("[data-archive-ticket]")).toBeEnabled();
  await page.locator("[data-archive-ticket]").click();
  await waitFor(async () => (await queryOne("select status from tickets where ticket_number = $1", [ticketNumber]))?.status === "Archived");
});

test("lifecycle buttons are gated by status", async ({ page }) => {
  const title = `E2E gating ${Date.now()}`;
  const ticketNumber = await submitPublicTicket(page, title);
  await page.goto(`/admin/tickets/${ticketNumber}`);

  // A freshly submitted public ticket can be acknowledged or rejected, but
  // not ready to start planning, cancelled, or archived.
  await expect(page.locator("[data-acknowledge-ticket]")).toBeEnabled();
  await expect(page.locator("[data-reject-ticket]")).toBeEnabled();
  await expect(page.locator("[data-start-planning]")).toHaveCount(0);
  await expect(page.locator("[data-cancel-ticket]")).toBeDisabled();
  await expect(page.locator("[data-archive-ticket]")).toBeDisabled();
});
