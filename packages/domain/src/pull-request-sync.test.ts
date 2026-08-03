import { beforeEach, expect, test, vi } from "vitest";

const database = vi.hoisted(() => ({ pool: { query: vi.fn() } }));
const github = vi.hoisted(() => ({ getPullRequest: vi.fn(), listPullRequests: vi.fn() }));

vi.mock("@dcc/database", () => ({ ...database, inTransaction: vi.fn() }));
vi.mock("../../github-provider/src/index.ts", () => github);

import { importGithubPullRequests, syncOpenPullRequests, syncPullRequest } from "./pull-request-sync.ts";

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

test("stops open pull-request iteration when lease ownership is lost mid-sync", async () => {
  database.pool.query.mockImplementation(async (sql: string) => {
    if (sql.includes("SELECT pr.id FROM pull_requests")) return { rows: [{ id: "pr-1" }, { id: "pr-2" }] };
    if (sql.includes("WHERE pr.id=$1")) return { rows: [{
      id: "pr-1", github_owner: "acme", github_repository: "widgets", number: 42, ticket_id: null,
    }] };
    return { rows: [] };
  });
  github.getPullRequest.mockResolvedValue(draftPullRequest);
  const assertOwned = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValue(new Error("lease lost"));

  await expect(syncOpenPullRequests(assertOwned)).rejects.toThrow("lease lost");
  expect(github.getPullRequest).toHaveBeenCalledTimes(1);
});

test("continues open pull-request iteration after an ordinary per-PR sync failure", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  database.pool.query.mockImplementation(async (sql: string, values?: unknown[]) => {
    if (sql.includes("SELECT pr.id FROM pull_requests")) return { rows: [{ id: "pr-1" }, { id: "pr-2" }] };
    if (sql.includes("WHERE pr.id=$1")) return { rows: [{
      id: values?.[0], github_owner: "acme", github_repository: "widgets", number: 42, ticket_id: null,
    }] };
    return { rows: [] };
  });
  github.getPullRequest.mockRejectedValueOnce(new Error("provider failed")).mockResolvedValueOnce(draftPullRequest);

  await expect(syncOpenPullRequests()).resolves.toBeUndefined();
  expect(github.getPullRequest).toHaveBeenCalledTimes(2);
  expect(log).toHaveBeenCalledOnce();
  log.mockRestore();
});
