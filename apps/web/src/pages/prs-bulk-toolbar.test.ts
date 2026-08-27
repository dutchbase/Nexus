import { beforeEach, expect, test, vi } from "vitest";

const query = vi.fn();
vi.mock("@dcc/database", () => ({ inTransaction: vi.fn(), pool: { query } }));

const prs = await import("./prs.ts");
const session = { username: "admin", user_id: "admin" };

function mockList(rows: any[]) {
  query.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM pull_requests pr JOIN projects")) return { rows };
    if (sql.includes("SELECT DISTINCT repository")) return { rows: [] };
    if (sql.includes("SELECT MAX(last_synced_at)")) return { rows: [{ synced: null }] };
    throw new Error(`unexpected query: ${sql}`);
  });
}

beforeEach(() => { query.mockReset(); });

test("renders the bulk toolbar and select-all checkbox, hidden until a selection exists", async () => {
  mockList([]);
  const result = await prs.render(new URL("http://test/admin/pull-requests"), session, {});
  expect(result!.body).toContain("data-pr-bulk-toolbar");
  expect(result!.body).toContain("data-pr-bulk-toolbar hidden");
  expect(result!.body).toContain("data-pr-check-all");
  expect(result!.body).toContain('data-pr-bulk="ai-review"');
  expect(result!.body).toContain('data-pr-bulk="close"');
  expect(result!.body).toContain('data-pr-bulk="merge"');
  expect(result!.body).toContain("data-pr-clear-selection");
});

test("renders a checkbox with the pull request id for an open PR row", async () => {
  mockList([{
    id: "pr-open-1", number: 12, title: "Open PR", project_name: "Project", project_slug: "project",
    state: "open", is_draft: false, merge_conflicts: false, last_synced_at: null,
  }]);
  const result = await prs.render(new URL("http://test/admin/pull-requests"), session, {});
  expect(result!.body).toContain('data-pr-check="pr-open-1"');
  expect(result!.body).toContain('value="pr-open-1"');
  expect(result!.body).toContain('data-pr-state="open"');
});

test("omits the checkbox input for a merged PR row", async () => {
  mockList([{
    id: "pr-merged-1", number: 13, title: "Merged PR", project_name: "Project", project_slug: "project",
    state: "merged", is_draft: false, merge_conflicts: false, last_synced_at: null,
  }]);
  const result = await prs.render(new URL("http://test/admin/pull-requests?tab=merged"), session, {});
  expect(result!.body).not.toContain('data-pr-check="pr-merged-1"');
  expect(result!.body).toContain('data-pr-state="merged"');
});

test("omits the checkbox input for a closed PR row", async () => {
  mockList([{
    id: "pr-closed-1", number: 14, title: "Closed PR", project_name: "Project", project_slug: "project",
    state: "closed", is_draft: false, merge_conflicts: false, last_synced_at: null,
  }]);
  const result = await prs.render(new URL("http://test/admin/pull-requests?tab=closed"), session, {});
  expect(result!.body).not.toContain('data-pr-check="pr-closed-1"');
  expect(result!.body).toContain('data-pr-state="closed"');
});
