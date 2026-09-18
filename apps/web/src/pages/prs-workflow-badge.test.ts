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

function baseRow(overrides: any) {
  return {
    id: "pr-1", number: 1, title: "PR", project_name: "Project", project_slug: "project",
    state: "open", is_draft: false, merge_conflicts: false, last_synced_at: null,
    ...overrides,
  };
}

test("renders the Workflows column header", async () => {
  mockList([]);
  const result = await prs.render(new URL("http://test/admin/pull-requests"), session, {});
  expect(result!.body).toContain("<span>Workflows</span>");
});

test("shows a muted 'Not started' badge when workflow_check_state is none or unset", async () => {
  mockList([baseRow({ workflow_check_state: "none" })]);
  const result = await prs.render(new URL("http://test/admin/pull-requests"), session, {});
  expect(result!.body).toContain('<span class="status muted" data-label="Workflows">Not started</span>');
});

test("shows a warn 'In progress' badge when workflow_check_state is in_progress", async () => {
  mockList([baseRow({ workflow_check_state: "in_progress" })]);
  const result = await prs.render(new URL("http://test/admin/pull-requests"), session, {});
  expect(result!.body).toContain('<span class="status warn" data-label="Workflows">In progress</span>');
});

test("shows an ok 'Passed' badge when workflow_check_state is success", async () => {
  mockList([baseRow({ workflow_check_state: "success" })]);
  const result = await prs.render(new URL("http://test/admin/pull-requests"), session, {});
  expect(result!.body).toContain('<span class="status ok" data-label="Workflows">Passed</span>');
});

test("shows a danger 'Failed' badge when workflow_check_state is failure", async () => {
  mockList([baseRow({ workflow_check_state: "failure" })]);
  const result = await prs.render(new URL("http://test/admin/pull-requests"), session, {});
  expect(result!.body).toContain('<span class="status danger" data-label="Workflows">Failed</span>');
});
