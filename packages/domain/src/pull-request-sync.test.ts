import { beforeEach, expect, test, vi } from "vitest";

const database = vi.hoisted(() => ({
  pool: { query: vi.fn() },
  inTransaction: vi.fn(async (run: (client: { query: typeof database.pool.query }) => unknown) => run(database.pool)),
}));
const github = vi.hoisted(() => ({
  getPullRequestPolicyInputs: vi.fn(),
  listPullRequests: vi.fn(),
  GitHubProviderError: class extends Error {
    constructor(public code: string, message: string, public status?: number, public retryAt?: string, public endpoint?: string) { super(message); }
  },
}));

vi.mock("@dcc/database", () => database);
vi.mock("../../github-provider/src/index.ts", () => github);

import { importGithubPullRequests, syncOpenPullRequests, syncPullRequest } from "./pull-request-sync.ts";

const pullRequest = {
  number: 42, html_url: "https://github.com/acme/widgets/pull/42", state: "open", draft: true,
  title: "Draft", head: { ref: "feature", sha: "head-sha" }, base: { ref: "main", sha: "base-sha" },
  created_at: "2026-08-03", updated_at: "2026-08-04",
};

const policyInputs = {
  pullRequest,
  protected: false,
  requiredApprovals: 0,
  reviews: [],
  requestedReviewers: [],
  requiredChecks: [],
  checks: [],
  complete: true,
  fetchedAt: "2026-08-04T12:00:00Z",
};

beforeEach(() => {
  vi.resetAllMocks();
  database.inTransaction.mockImplementation(async (run: (client: { query: typeof database.pool.query }) => unknown) => run(database.pool));
});

test("syncs evaluated policy truth and points to its immutable snapshot atomically", async () => {
  database.pool.query
    .mockResolvedValueOnce({ rows: [{ id: "pr-id", github_owner: "acme", github_repository: "widgets", number: 42, ticket_id: null }] })
    .mockResolvedValueOnce({ rows: [], rowCount: 1 })
    .mockResolvedValueOnce({ rows: [{ id: "snapshot-id" }] })
    .mockResolvedValueOnce({ rows: [], rowCount: 1 });
  github.getPullRequestPolicyInputs.mockResolvedValue({
    ...policyInputs,
    requestedReviewers: [{ type: "team", name: "platform" }],
  });

  await syncPullRequest("pr-id");

  expect(database.inTransaction).toHaveBeenCalledOnce();
  expect(database.pool.query.mock.calls[2][0]).toContain("INSERT INTO pull_request_policy_snapshots");
  expect(database.pool.query.mock.calls[3][0]).toContain("current_policy_snapshot_id");
  expect(database.pool.query.mock.calls[3][0]).toContain("requested_reviewers");
  expect(database.pool.query.mock.calls[3][1]).toContain('[{"type":"team","name":"platform"}]');
  expect(database.pool.query.mock.calls[3][1]).toEqual(expect.arrayContaining(["snapshot-id", "not_required", "not_required", "head-sha"]));
});

test("retains the last snapshot and marks policy stale on a rate limit", async () => {
  database.pool.query
    .mockResolvedValueOnce({ rows: [{ id: "pr-id", current_policy_snapshot_id: "old-snapshot", github_owner: "acme", github_repository: "widgets", number: 42, ticket_id: null }] })
    .mockResolvedValueOnce({ rows: [], rowCount: 1 })
    .mockResolvedValueOnce({ rows: [], rowCount: 1 });
  github.getPullRequestPolicyInputs.mockRejectedValue(new github.GitHubProviderError("rate_limited", "limited", 429, "2026-08-04T12:01:00Z"));

  await expect(syncPullRequest("pr-id")).rejects.toMatchObject({ code: "rate_limited" });

  expect(database.pool.query.mock.calls[2][0]).toContain("policy_stale=true");
  expect(database.pool.query.mock.calls[2][1]).toEqual(["pr-id", "rate_limited", "2026-08-04T12:01:00Z", expect.any(String)]);
  expect(database.pool.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO pull_request_policy_snapshots"))).toBe(false);
});

test("retains the last snapshot and marks policy stale on a non-rate-limited 403", async () => {
  database.pool.query
    .mockResolvedValueOnce({ rows: [{ id: "pr-id", current_policy_snapshot_id: "old-snapshot", github_owner: "acme", github_repository: "widgets", number: 42, ticket_id: null }] })
    .mockResolvedValueOnce({ rows: [], rowCount: 1 })
    .mockResolvedValueOnce({ rows: [], rowCount: 1 });
  github.getPullRequestPolicyInputs.mockRejectedValue(new github.GitHubProviderError(
    "http_error", "forbidden", 403, "2026-08-04T12:15:00Z", "https://api.github.com/repos/acme/widgets/branches/main/protection",
  ));

  await expect(syncPullRequest("pr-id")).rejects.toMatchObject({ code: "http_error", status: 403 });

  expect(database.pool.query.mock.calls[2][0]).toContain("policy_stale=true");
  expect(database.pool.query.mock.calls[2][1]).toEqual(["pr-id", "http_error", "2026-08-04T12:15:00Z", expect.any(String)]);
});

test("excludes pull requests still in their retry cooldown from the sync batch", async () => {
  database.pool.query.mockResolvedValue({ rows: [] });

  await syncOpenPullRequests();

  const select = database.pool.query.mock.calls.find(([sql]) => String(sql).includes("SELECT pr.id FROM pull_requests"));
  expect(String(select?.[0])).toContain("policy_retry_after");
});

test("logs the failing endpoint when a per-PR sync fails with a GitHub provider error", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  database.pool.query.mockImplementation(async (sql: string, values?: unknown[]) => {
    if (sql.includes("SELECT pr.id FROM pull_requests")) return { rows: [{ id: "pr-1" }] };
    if (sql.includes("WHERE pr.id=$1")) return { rows: [{ id: values?.[0], github_owner: "acme", github_repository: "widgets", number: 42, ticket_id: null }] };
    return { rows: [], rowCount: 1 };
  });
  github.getPullRequestPolicyInputs.mockRejectedValue(new github.GitHubProviderError(
    "http_error", "forbidden", 403, "2026-08-04T12:15:00Z", "https://api.github.com/repos/acme/widgets/branches/main/protection",
  ));

  await syncOpenPullRequests();

  expect(log).toHaveBeenCalledWith(expect.stringContaining("https://api.github.com/repos/acme/widgets/branches/main/protection"), expect.anything());
  log.mockRestore();
});

test("rejects a superseded sync instead of replacing newer freshness", async () => {
  database.pool.query.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM pull_requests pr")) return { rows: [{
      id: "pr-id", github_owner: "acme", github_repository: "widgets", number: 42, ticket_id: null,
    }] };
    if (sql.includes("SET policy_sync_token=")) return { rows: [], rowCount: 1 };
    if (sql.includes("INSERT INTO pull_request_policy_snapshots")) return { rows: [{ id: "old-snapshot" }], rowCount: 1 };
    if (sql.includes("current_policy_snapshot_id=")) return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 1 };
  });
  github.getPullRequestPolicyInputs.mockResolvedValue(policyInputs);

  await expect(syncPullRequest("pr-id")).rejects.toThrow("superseded");

  const update = database.pool.query.mock.calls.find(([sql]) => String(sql).includes("current_policy_snapshot_id="));
  expect(String(update?.[0])).toContain("policy_sync_token");
});

test("imports each discovered PR once and records a completed repository sync", async () => {
  github.listPullRequests.mockResolvedValue(Object.assign([pullRequest, { ...pullRequest, number: 43 }], {
    items: [pullRequest, { ...pullRequest, number: 43 }], complete: true, cursor: null, fetchedAt: "2026-08-04T12:00:00Z",
  }));
  const query = vi.fn().mockResolvedValue({ rows: [] });

  await expect(importGithubPullRequests({ query } as any, { id: "project-id", github_owner: "acme", github_repository: "widgets" }))
    .resolves.toEqual({ imported: 2, complete: true, cursor: null });

  expect(query.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO pull_requests"))).toHaveLength(2);
  expect(query.mock.calls.at(-1)?.[0]).toContain("github_repository_sync_state");
});

test("imports partial pages and records the failed cursor without claiming completion", async () => {
  github.listPullRequests.mockResolvedValue(Object.assign([pullRequest], {
    items: [pullRequest], complete: false, cursor: "https://api.github.test/page=2", fetchedAt: "2026-08-04T12:00:00Z",
    errorCode: "rate_limited", retryAt: "2026-08-04T12:01:00Z",
  }));
  const query = vi.fn().mockResolvedValue({ rows: [] });

  await expect(importGithubPullRequests({ query } as any, { id: "project-id", github_owner: "acme", github_repository: "widgets" }))
    .resolves.toEqual({ imported: 1, complete: false, cursor: "https://api.github.test/page=2" });

  expect(query.mock.calls.at(-1)?.[1]).toEqual([
    "project-id", "https://api.github.test/page=2", false, "2026-08-04T12:00:00Z", "rate_limited", "2026-08-04T12:01:00Z",
  ]);
});

test("syncs policy inputs for an open imported pull request without a ticket", async () => {
  database.pool.query.mockImplementation(async (sql: string) => {
    if (sql.includes("SELECT pr.id FROM pull_requests")) {
      expect(sql).toContain("pr.state='open'");
      expect(sql).not.toContain("JOIN tickets");
      return { rows: [{ id: "unlinked-pr" }] };
    }
    if (sql.includes("WHERE pr.id=$1")) return { rows: [{
      id: "unlinked-pr", github_owner: "acme", github_repository: "widgets", number: 42, ticket_id: null,
    }] };
    if (sql.includes("INSERT INTO pull_request_policy_snapshots")) return { rows: [{ id: "snapshot-id" }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  });
  github.getPullRequestPolicyInputs.mockResolvedValue({
    ...policyInputs,
    requestedReviewers: [{ type: "user", name: "octocat" }],
  });

  await syncOpenPullRequests();

  const update = database.pool.query.mock.calls.find(([sql]) => String(sql).includes("current_policy_snapshot_id="));
  expect(update?.[1]).toEqual(expect.arrayContaining(["head-sha", '[{"type":"user","name":"octocat"}]']));
});

test("stops open pull-request iteration when lease ownership is lost mid-sync", async () => {
  database.pool.query.mockImplementation(async (sql: string) => {
    if (sql.includes("SELECT pr.id FROM pull_requests")) return { rows: [{ id: "pr-1" }, { id: "pr-2" }] };
    if (sql.includes("WHERE pr.id=$1")) return { rows: [{ id: "pr-1", github_owner: "acme", github_repository: "widgets", number: 42, ticket_id: null }] };
    if (sql.includes("SET policy_sync_token=")) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  });
  github.getPullRequestPolicyInputs.mockResolvedValue(policyInputs);
  const assertOwned = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValue(new Error("lease lost"));

  await expect(syncOpenPullRequests(assertOwned)).rejects.toThrow("lease lost");
  expect(github.getPullRequestPolicyInputs).not.toHaveBeenCalled();
});

test("continues open pull-request iteration after an ordinary per-PR sync failure", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  database.pool.query.mockImplementation(async (sql: string, values?: unknown[]) => {
    if (sql.includes("SELECT pr.id FROM pull_requests")) return { rows: [{ id: "pr-1" }, { id: "pr-2" }] };
    if (sql.includes("WHERE pr.id=$1")) return { rows: [{ id: values?.[0], github_owner: "acme", github_repository: "widgets", number: 42, ticket_id: null }] };
    if (sql.includes("INSERT INTO pull_request_policy_snapshots")) return { rows: [{ id: "snapshot-id" }] };
    return { rows: [], rowCount: 1 };
  });
  github.getPullRequestPolicyInputs.mockRejectedValueOnce(new Error("provider failed")).mockResolvedValueOnce(policyInputs);

  await expect(syncOpenPullRequests()).resolves.toBeUndefined();
  expect(github.getPullRequestPolicyInputs).toHaveBeenCalledTimes(2);
  expect(log).toHaveBeenCalledOnce();
  log.mockRestore();
});
