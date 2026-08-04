import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("pull request list actions", () => {
  it("renders GitHub policy evidence and only a bound admin merge", async () => {
    const page = await readFile(new URL("./prs.ts", import.meta.url), "utf8");
    const script = await readFile(new URL("../ui.ts", import.meta.url), "utf8");

    expect(page).toContain('data-pr-id="${item.id}"');
    expect(page).toContain("GitHub: reviews");
    expect(page).toContain("GitHub: checks");
    expect(page).toContain("policy_synced_at");
    expect(page).toContain("policy_retry_after");
    expect(page).toContain("requested_reviewers");
    expect(page).toContain("current_policy_snapshot_id");
    expect(page).toContain("publication_id");
    expect(page).toContain("github_comment_id");
    expect(page).toContain("escapeHtml(r.raw_output");
    expect(page).not.toContain("data-pr-list-approve");
    expect(page).not.toContain("data-pr-list-ai-review-merge");
    expect(page).not.toContain("data-pr-ai-review-merge");
    expect(page).not.toContain("data-pr-target-branch");
    expect(page).toContain('class="pr-row-link"');
    expect(page).toContain("<span>Merge Status</span>");
    expect(page).toContain('class="card prs-card"');
    expect(page).not.toContain('return `<a class="ticket-row prs-row"');
    expect(script).toContain("expected_head_sha");
    expect(script).toContain("policy_snapshot_id");
    expect(script).not.toContain("review_and_merge");
  });
});
