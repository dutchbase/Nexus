import { beforeEach, expect, test, vi } from "vitest";

const query = vi.fn();
vi.mock("@dcc/database", () => ({ inTransaction: vi.fn(), pool: { query } }));

const prs = await import("./prs.ts");
const tickets = await import("./tickets.ts");
const session = { username: "admin", user_id: "admin" };
const pr = {
  id: "pr-1", project_id: "project-1", project_name: "Project", project_slug: "project", repository: "acme/project",
  number: 7, title: "Title", url: "https://github.test/acme/project/pull/7", state: "open", base_branch: "main", head_branch: "feature",
  head_sha: "head-sha", current_policy_snapshot_id: "snapshot-1", policy_complete: true, policy_stale: false,
  review_state: "approved", check_state: "success", requested_reviewers: [], created_at: "2026-08-04T10:00:00Z",
};

function mockPr(item: any, reviews: any[] = [], requireFreshPolicyBinding = true) {
  query.mockImplementation(async (sql: string) => {
    if (!sql) return { rows: [] };
    if (sql.includes("FROM pull_requests pr JOIN projects")) return { rows: [item] };
    if (sql.includes("FROM pr_ai_reviews")) return { rows: reviews };
    if (sql.includes("FROM pr_conflict_resolutions")) return { rows: [] };
    if (sql.includes("FROM pull_request_merge_settings")) return { rows: [{ require_fresh_policy_binding: requireFreshPolicyBinding }] };
    throw new Error(`unexpected query: ${sql}`);
  });
}

async function renderPr(item: any, reviews: any[] = [], requireFreshPolicyBinding = true) {
  mockPr(item, reviews, requireFreshPolicyBinding);
  return (await prs.render(new URL("http://test/admin/pull-requests/project/7"), session, {}))!.body;
}

beforeEach(() => query.mockReset());

test("renders a fresh GitHub binding and sends exactly its visible values", async () => {
  const body = await renderPr({ ...pr, policy_synced_at: "2026-08-04T10:05:00Z", requested_reviewers: [{ type: "team", name: "release" }] });

  expect(body).toContain("GitHub: Policies satisfied");
  expect(body).toContain("GitHub: reviews");
  expect(body).toContain("GitHub: checks");
  expect(body).toContain("Requested reviewers");
  expect(body).toContain("team release");
  expect(body).toContain("Policy snapshot");
  expect(body).toContain("snapshot-1");
  expect(body).toContain('data-pr-head-sha="head-sha" data-pr-policy-snapshot-id="snapshot-1"');
  expect(body).not.toContain('data-pr-approve disabled');
});

test("labels stale rate-limited evidence and disables merge with its exact reason", async () => {
  const body = await renderPr({ ...pr, policy_stale: true, policy_error_code: "rate_limited", policy_retry_after: "2026-08-04T10:10:00Z" });

  expect(body).toContain("GitHub: Stale: rate_limited; retry after");
  expect(body).toContain('data-pr-approve data-pr-head-sha="head-sha" data-pr-policy-snapshot-id="snapshot-1" disabled title="GitHub: Stale: rate_limited; retry after');
});

test("labels a missing snapshot as unavailable when enforcement mode is required", async () => {
  const body = await renderPr({
    ...pr, current_policy_snapshot_id: null, config_json: { github_policy: { enforcement: "required" } },
  });

  expect(body).toContain("GitHub: Unavailable: policy snapshot missing");
  expect(body).toContain("Policy snapshot</dt><dd class=\"mono\">Unavailable");
  expect(body).toContain('disabled title="GitHub: Unavailable: policy snapshot missing"');
});

test("labels a missing snapshot as no applicable policies when enforcement mode is auto and review/check states are not_required", async () => {
  const body = await renderPr({
    ...pr, current_policy_snapshot_id: "snap-1", policy_complete: true, policy_stale: false,
    review_state: "not_required", check_state: "not_required", config_json: {},
  });

  expect(body).toContain("GitHub: No applicable policies");
  expect(body).not.toContain('data-pr-approve disabled');
});

test("labels missing head SHA as unavailable regardless of enforcement mode", async () => {
  const body = await renderPr({ ...pr, head_sha: null });

  expect(body).toContain("GitHub: Unavailable: head SHA missing");
  expect(body).toContain('disabled title="GitHub: Unavailable: head SHA missing"');
});

test("omits the policy snapshot and allows a matching head when enforcement is disabled", async () => {
  const body = await renderPr({ ...pr, policy_stale: true }, [], false);

  expect(body).toContain('data-pr-approve data-pr-head-sha="head-sha" title=""');
  expect(body).not.toContain('data-pr-policy-snapshot-id="snapshot-1"');
});

test.each([
  [{ policy_complete: false }, "GitHub: Incomplete"],
  [{ review_state: "pending" }, "GitHub: Required: reviews pending"],
  [{ check_state: "failure" }, "GitHub: Required: checks failed"],
])("disables merge for %o with the exact policy reason", async (changes, status) => {
  const body = await renderPr({ ...pr, ...changes });

  expect(body).toContain(status);
  expect(body).toContain(`disabled title="${status}"`);
});

test("a protected repo with pending required checks still shows Approve & merge disabled", async () => {
  const body = await renderPr({
    ...pr, current_policy_snapshot_id: "snap-1", policy_complete: true, policy_stale: false,
    review_state: "approved", check_state: "pending", config_json: {},
  });

  expect(body).toContain("GitHub: Required: checks pending");
  expect(body).toContain('disabled title="GitHub: Required: checks pending"');
});

test("a protected repo with changes requested still shows Approve & merge disabled", async () => {
  const body = await renderPr({
    ...pr, current_policy_snapshot_id: "snap-1", policy_complete: true, policy_stale: false,
    review_state: "changes_requested", check_state: "success", config_json: {},
  });

  expect(body).toContain("GitHub: Required: changes requested");
  expect(body).toContain('disabled title="GitHub: Required: changes requested"');
});

test("escapes persisted review output and errors", async () => {
  const body = await renderPr(pr, [{ status: "error", mode: "review_only", model: "sonnet", reasoning_level: "high", created_at: "2026-08-04T10:00:00Z", publication_id: "publication", github_comment_id: 4, error_message: "<script>bad()</script>", raw_output: "<img src=x>" }]);

  expect(body).toContain("&lt;script&gt;bad()&lt;/script&gt;");
  expect(body).toContain("&lt;img src=x&gt;");
  expect(body).not.toContain("<script>bad()</script>");
  expect(body).not.toContain("<img src=x>");
});

test("ticket detail identifies stale GitHub review evidence and its timestamp", async () => {
  query.mockImplementation(async (sql: string) => {
    if (!sql) return { rows: [] };
    if (sql.includes("FROM tickets t JOIN projects")) return { rows: [{ id: "ticket-1", ticket_number: "T-1", project_id: "project-1", project_name: "Project", title: "Ticket", status: "PR Ready for Review", created_at: "2026-08-04T10:00:00Z" }] };
    if (sql.includes("FROM pull_requests WHERE ticket_id")) return { rows: [{ ...pr, policy_stale: true, policy_synced_at: "2026-08-04T10:05:00Z", policy_error_code: "rate_limited" }] };
    if (sql.includes("SELECT t.*,p.id plan_id")) return { rows: [] };
    return { rows: [] };
  });

  const page = await tickets.render(new URL("http://test/admin/tickets/T-1"), session, {});

  expect(page?.body).toContain("GitHub: Stale: rate_limited");
  expect(page?.body).toContain("2026");
});
