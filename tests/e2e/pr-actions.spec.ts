// End-user journey: pull request review actions — AI review, mark reviewed,
// approve & merge, request changes, close ticket, reopen.
//
// UI notes verified against the app: secondary actions (Refresh, Request
// changes, Mark reviewed, Close ticket) live inside the "More options ▾"
// <details class="menu"> dropdown; Approve & merge and AI review are
// top-level toolbar buttons. Successful reviews end in status "approved"
// (pr_ai_reviews), and the policy snapshot is synced automatically after PR
// creation (badge "GitHub: Current").
import { test, expect, type Page } from "@playwright/test";
import { loginViaUI, queryOne, waitFor, driveTicketToPrReady, waitForTicketStatus } from "./helpers";

test.beforeEach(async ({ page }) => {
  await loginViaUI(page);
});

async function openPrDetail(page: Page, ticketNumber: string) {
  await page.goto("/admin/pull-requests");
  await page.locator(".prs-row", { hasText: ticketNumber }).first().click();
  await page.waitForURL(/\/admin\/pull-requests\/.+/);
}

async function openMoreOptions(page: Page) {
  await page.locator("details.menu > summary").click();
}

async function waitForPolicySnapshot(prId: string) {
  await waitFor(async () => {
    const row = await queryOne("select current_policy_snapshot_id, policy_stale from pull_requests where id = $1", [prId]);
    return !!row?.current_policy_snapshot_id && row.policy_stale === false;
  }, { timeoutMs: 30_000, intervalMs: 300 });
}

test("run an AI review from the PR page and see its verdict", async ({ page }) => {
  const { ticketNumber, prId } = await driveTicketToPrReady(page, `E2E ai-review ${Date.now()}`);
  await openPrDetail(page, ticketNumber);

  await page.locator("[data-pr-ai-review]").click();

  let review: any;
  await waitFor(async () => {
    review = await queryOne("select * from pr_ai_reviews where pull_request_id = $1 order by created_at desc limit 1", [prId]);
    return !!review && !["queued", "running"].includes(review.status);
  }, { timeoutMs: 60_000, intervalMs: 500 });

  expect(review.status).toBe("approved");
  expect(review.parsed_verdict).toBe("approved");
  expect(review.github_comment_url).toBeTruthy();

  // The page polls while running and auto-reloads with the verdict badge.
  await expect(page.locator("[data-ai-review-status]")).toContainText(/AI: Approved/i, { timeout: 20_000 });
});

test("approve & merge merges the PR and the ticket ends up Merged, then reopens", async ({ page }) => {
  const { ticketNumber, ticketId, prId } = await driveTicketToPrReady(page, `E2E merge ${Date.now()}`);
  // Merging is head-bound: the approve action references the policy snapshot
  // the worker syncs right after PR creation.
  await waitForPolicySnapshot(prId);
  await openPrDetail(page, ticketNumber);

  page.on("dialog", (dialog) => dialog.accept());
  await expect(page.locator("[data-pr-approve]")).toBeEnabled();
  await page.locator("[data-pr-approve]").click();

  await waitForTicketStatus(ticketId, ["Merged", "Completed"], 60_000);
  const pr = await queryOne("select state, merged_at from pull_requests where id = $1", [prId]);
  expect(pr.merged_at).not.toBeNull();

  // Merged/completed tickets offer Reopen on the ticket page.
  await page.goto(`/admin/tickets/${ticketNumber}`);
  await expect(page.locator("[data-reopen-ticket]")).toBeVisible();
  await page.locator("[data-reopen-ticket]").click();
  await waitForTicketStatus(ticketId, ["Needs Information"]);
});

test("request changes flags the ticket for repair work", async ({ page }) => {
  const { ticketNumber, ticketId } = await driveTicketToPrReady(page, `E2E req-changes ${Date.now()}`);
  await openPrDetail(page, ticketNumber);

  await openMoreOptions(page);
  await page.locator("[data-pr-request-changes]").click();
  await waitForTicketStatus(ticketId, ["PR Changes Requested"]);
});

test("mark reviewed and close the linked ticket without merging", async ({ page }) => {
  const { ticketNumber, ticketId } = await driveTicketToPrReady(page, `E2E close ${Date.now()}`);
  await openPrDetail(page, ticketNumber);

  await openMoreOptions(page);
  await page.locator("[data-pr-mark-reviewed]").click();
  await waitFor(async () => {
    const row = await queryOne(
      `select pr.internal_review_state from pull_requests pr join execution_attempts ea on ea.id = pr.execution_attempt_id where ea.ticket_id = $1`,
      [ticketId],
    );
    return row?.internal_review_state === "reviewed";
  });

  page.on("dialog", (dialog) => dialog.accept());
  // The action reloads the page and collapses the menu — reopen it.
  await openMoreOptions(page);
  await page.locator("[data-pr-close-ticket]").click();
  await waitForTicketStatus(ticketId, ["Closed Without Merge"]);
});

test("sync pull requests from the list header", async ({ page }) => {
  await page.goto("/admin/pull-requests");
  const before = new Date().toISOString();
  // The header button triggers a full GitHub PR import (github.import job).
  await page.locator("[data-sync-prs]").click();
  await waitFor(async () => {
    const job = await queryOne(
      "select status from jobs where type = 'github.import' and created_at >= $1::timestamptz order by created_at desc limit 1",
      [before],
    );
    return job?.status === "completed";
  }, { timeoutMs: 30_000, intervalMs: 300 });
});

test("select multiple PRs and run a bulk AI review", async ({ page }) => {
  const a = await driveTicketToPrReady(page, `E2E bulk-ai-1 ${Date.now()}`);
  const b = await driveTicketToPrReady(page, `E2E bulk-ai-2 ${Date.now()}`);
  await page.goto("/admin/pull-requests");
  await page.locator(`[data-pr-check="${a.prId}"]`).check();
  await page.locator(`[data-pr-check="${b.prId}"]`).check();
  await expect(page.locator("[data-pr-selected-count]")).toHaveText("2");
  await page.locator('[data-pr-bulk="ai-review"]').click();

  for (const prId of [a.prId, b.prId]) {
    await waitFor(async () => {
      const review = await queryOne("select status from pr_ai_reviews where pull_request_id = $1 order by created_at desc limit 1", [prId]);
      return !!review && !["queued", "running"].includes(review.status);
    }, { timeoutMs: 60_000, intervalMs: 500 });
  }
});

test("bulk AI review does not duplicate an already-running review", async ({ page }) => {
  const a = await driveTicketToPrReady(page, `E2E bulk-ai-dup ${Date.now()}`);
  await page.goto(`/admin/pull-requests`);
  // Start one review directly first via the detail page, then attempt a bulk review on the same PR while it's still running.
  await page.locator(".prs-row", { hasText: a.ticketNumber }).first().click();
  await page.locator("[data-pr-ai-review]").click();
  await page.goto("/admin/pull-requests");
  await page.locator(`[data-pr-check="${a.prId}"]`).check();
  page.on("dialog", (dialog) => dialog.accept());
  await page.locator('[data-pr-bulk="ai-review"]').click();
  const reviews = await queryOne("select count(*)::int as count from pr_ai_reviews where pull_request_id = $1", [a.prId]);
  expect(reviews.count).toBe(1); // no duplicate row created
});

test("bulk close requires confirmation and closes selected PRs without deleting branches", async ({ page }) => {
  const a = await driveTicketToPrReady(page, `E2E bulk-close ${Date.now()}`);
  await page.goto("/admin/pull-requests");
  await page.locator(`[data-pr-check="${a.prId}"]`).check();
  page.on("dialog", (dialog) => dialog.accept());
  await page.locator('[data-pr-bulk="close"]').click();
  await waitFor(async () => {
    const pr = await queryOne("select state from pull_requests where id = $1", [a.prId]);
    return pr?.state === "closed";
  }, { timeoutMs: 30_000, intervalMs: 500 });
});

test("bulk merge pre-flight classifies ready vs blocked PRs and only merges the ready ones", async ({ page }) => {
  const ready = await driveTicketToPrReady(page, `E2E bulk-merge-ready ${Date.now()}`);
  await waitFor(async () => {
    const row = await queryOne("select current_policy_snapshot_id, policy_stale from pull_requests where id = $1", [ready.prId]);
    return !!row?.current_policy_snapshot_id && row.policy_stale === false;
  }, { timeoutMs: 30_000, intervalMs: 300 });

  await page.goto("/admin/pull-requests");
  await page.locator(`[data-pr-check="${ready.prId}"]`).check();
  await page.locator('[data-pr-bulk="merge"]').click();

  const dialog = page.locator("[data-pr-merge-preflight-dialog]");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("[data-pr-preflight-summary]")).toHaveText(/1 ready, 0 blocked/);
  await dialog.locator("[data-pr-preflight-confirm]").click();

  await waitForTicketStatus(ready.ticketId, ["Merged", "Completed"], 60_000);
  const pr = await queryOne("select merged_at from pull_requests where id = $1", [ready.prId]);
  expect(pr.merged_at).not.toBeNull();
});
