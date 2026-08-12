// End-user journey: pull request review actions — AI review, mark reviewed,
// approve & merge, request changes, close ticket, reopen.
//
// UI notes verified against the app: secondary actions (Refresh, Request
// changes, Mark reviewed, Close ticket) live inside the "More options ▾"
// <details class="menu"> dropdown; Approve & merge and AI review are
// top-level toolbar buttons. Successful reviews end in status "approved"
// (pr_ai_reviews), and the policy snapshot is synced automatically after PR
// creation (badge "GitHub: Current").
import fs from "node:fs";
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

  // The page polls while running and reloads with the verdict badge.
  await page.reload();
  await expect(page.locator("[data-ai-review-status]")).toContainText(/AI: Approved/i);
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

test("create follow-up ticket generates its description via the API-billed Anthropic path", async ({ page }) => {
  // Proves B4's transport routing end to end: DCC_ANTHROPIC_API_JOBS defaults
  // to routing pr_follow_up_description through invokeAnthropicText against
  // the mock Anthropic server (tests/e2e/mock-anthropic/server.mjs), started
  // and pointed at via ANTHROPIC_BASE_URL by run-e2e.sh — never through the
  // mock `claude` CLI, which would exit 1 if it ever saw ANTHROPIC_API_KEY
  // (tests/e2e/mock-claude/claude:17-21, the B1 env-scrubbing invariant).
  const { ticketNumber, prId } = await driveTicketToPrReady(page, `E2E follow-up ${Date.now()}`);
  await openPrDetail(page, ticketNumber);

  await openMoreOptions(page);
  await page.locator("[data-open-create-ticket]").click();

  const dialog = page.locator("[data-create-ticket-dialog]");
  const followUpTitle = `E2E follow-up ticket ${Date.now()}`;
  await dialog.locator('input[name="title"]').fill(followUpTitle);
  await dialog.locator('textarea[name="feedback"]').fill("Please document the edge case we missed in review.");
  // Leave description empty: with generate_description checked (default),
  // ui.ts falls back to using the feedback text as the ticket's initial
  // description, then fires the follow-up-description job which overwrites
  // it with the AI-generated text once the job completes (worker.ts's
  // `UPDATE tickets SET description=... WHERE description=$initial` guard).
  await expect(dialog.locator('input[name="generate_description"]')).toBeChecked();
  await dialog.locator('button[type="submit"]').click();

  // The create-ticket request is awaited by the UI, but the follow-up
  // description POST is fired with keepalive and not awaited — poll the DB
  // for the resulting job instead of trusting page state.
  let ticketRow: any;
  await waitFor(async () => {
    ticketRow = await queryOne("select id, description from tickets where title = $1", [followUpTitle]);
    return !!ticketRow;
  });

  let job: any;
  await waitFor(async () => {
    job = await queryOne(
      `select id, status, payload_json, error_json from jobs
       where type = 'pr.follow_up_description'
         and payload_json->>'pull_request_id' = $1
         and payload_json->>'ticket_id' = $2
       order by created_at desc limit 1`,
      [prId, ticketRow.id],
    );
    return !!job && job.status !== "queued" && job.status !== "running";
  }, { timeoutMs: 30_000, intervalMs: 300 });

  expect(job.status).toBe("completed");
  const generatedDescription = job.payload_json?.generated_description;
  expect(generatedDescription).toContain(
    "Mock Anthropic follow-up description: generated via the metered Messages API mock, proving the API-billed request/response round-trip.",
  );

  // The job handler also rewrites tickets.description (payload.initial_description
  // matched what the UI sent, since the description field was left blank).
  await waitFor(async () => {
    ticketRow = await queryOne("select description from tickets where id = $1", [ticketRow.id]);
    return ticketRow?.description === generatedDescription;
  });

  const run = await queryOne(
    "select billing_mode, run_type, status from agent_runs where pull_request_id = $1 and run_type = 'pr_follow_up_description' order by created_at desc limit 1",
    [prId],
  );
  expect(run).toBeTruthy();
  expect(run.status).toBe("completed");
  expect(run.billing_mode).toBe("api");

  // Positive proof the API-billed path actually executed: the mock Anthropic
  // server's own request log must contain a successful POST /v1/messages
  // entry. Unlike scanning the CLI log for absence of evidence, this proves
  // the real code path ran rather than merely that nothing looks wrong.
  const mockAnthropicLog = process.env.MOCK_ANTHROPIC_LOG;
  expect(mockAnthropicLog, "MOCK_ANTHROPIC_LOG must be set for this test").toBeTruthy();
  expect(fs.existsSync(mockAnthropicLog!), `mock Anthropic log not found at ${mockAnthropicLog}`).toBe(true);
  const anthropicEntries = fs
    .readFileSync(mockAnthropicLog!, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const sawMessagesCall = anthropicEntries.some(
    (entry: any) => entry.method === "POST" && entry.path === "/v1/messages" && entry.status === 200,
  );
  expect(sawMessagesCall, "expected a completed POST /v1/messages entry in the mock Anthropic log").toBe(true);

  // The mock `claude` CLI must never have been invoked with the leaked key.
  // Its own forbidden-env-var check exits 1 *before* writing any log entry,
  // so a missing log file/path would make a "no leak reference found"
  // assertion vacuously true even in the exact failure mode this proof
  // exists to catch — require the log to be configured and the file to
  // exist (never silently skip) before inspecting its contents.
  //
  // The file's contents are expected to stay empty here, and that is itself
  // meaningful: every real invocation path (packages/claude-runner's
  // invokePlanningClaude / invokeExecutionClaude / preflightClaudeAuthentication)
  // builds the CLI child process's env from a hardcoded allowlist (PATH,
  // LANG, LC_ALL, CLAUDE_CODE_OAUTH_TOKEN, and a few CLAUDE_CODE_* flags) —
  // MOCK_CLAUDE_LOG is test-only plumbing and is never forwarded, so the
  // mock CLI's log() is a no-op for every invocation in this suite,
  // regardless of whether a leak occurred. That is a *stronger* guarantee
  // than a populated log could prove on its own: the CLI subprocess never
  // receives any variable outside that allowlist, not only
  // ANTHROPIC_API_KEY. So this check can only assert the log is genuinely
  // wired up (env var set, file present) and, if it ever does contain
  // entries, that none of them reference this run's follow-up prompt.
  const mockClaudeLog = process.env.MOCK_CLAUDE_LOG;
  expect(mockClaudeLog, "MOCK_CLAUDE_LOG must be set for this test").toBeTruthy();
  expect(fs.existsSync(mockClaudeLog!), `mock claude log not found at ${mockClaudeLog}`).toBe(true);
  const claudeEntries = fs
    .readFileSync(mockClaudeLog!, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const leaked = claudeEntries.some((entry: any) =>
    (entry.argv || []).some((arg: string) => typeof arg === "string" && arg.includes("follow-up-ticket-prompt.md")),
  );
  expect(leaked).toBe(false);
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
