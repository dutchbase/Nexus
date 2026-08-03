import { beforeEach, expect, test, vi } from "vitest";

const database = vi.hoisted(() => ({ pool: { query: vi.fn() } }));
const github = vi.hoisted(() => ({ getPullRequest: vi.fn(), listPullRequests: vi.fn() }));

vi.mock("@dcc/database", () => ({ ...database, inTransaction: vi.fn() }));
vi.mock("../../github-provider/src/index.ts", () => github);

import { importGithubPullRequests, syncPullRequest } from "./pull-request-sync.ts";

const draftPullRequest = {
  number: 42, html_url: "https://github.com/acme/widgets/pull/42", state: "open", draft: true,
  title: "Draft", head: { ref: "feature" }, base: { ref: "main" }, created_at: "2026-08-03", updated_at: "2026-08-03",
};

beforeEach(() => vi.clearAllMocks());

test("imports a remote draft as open locally", async () => {
  github.listPullRequests.mockResolvedValue([draftPullRequest]);
  const query = vi.fn().mockResolvedValue({ rows: [] });

  await importGithubPullRequests({ query } as any, { id: "project-id", github_owner: "acme", github_repository: "widgets" });

  expect(query.mock.calls[0][1][9]).toBe(false);
});

test("syncs a remote draft as open locally", async () => {
  database.pool.query
    .mockResolvedValueOnce({ rows: [{ id: "pr-id", github_owner: "acme", github_repository: "widgets", number: 42, ticket_id: null }] })
    .mockResolvedValueOnce({ rows: [] });
  github.getPullRequest.mockResolvedValue(draftPullRequest);

  await syncPullRequest("pr-id");

  expect(database.pool.query.mock.calls[1][1][4]).toBe(false);
});
