import { beforeEach, expect, test, vi } from "vitest";

const github = vi.hoisted(() => ({
  getPullRequest: vi.fn(),
  getPullRequestPolicyInputs: vi.fn(),
  mergePullRequest: vi.fn(),
}));
const syncPullRequest = vi.hoisted(() => vi.fn());

vi.mock("../../github-provider/src/index.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../github-provider/src/index.ts")>(),
  ...github,
}));
vi.mock("./pull-request-sync.ts", () => ({ syncPullRequest }));

const { approveAndMergePullRequest, PullRequestMergeError } = await import("./pr-merge.ts");
const { GitHubProviderError } = await import("../../github-provider/src/index.ts");

const expected = {
  pullRequestId: "pr-id",
  jobId: "job-id",
  actor: { type: "admin" as const, id: "admin-id" },
  expectedHeadSha: "head-sha",
  expectedPolicySnapshotId: "expected-snapshot",
};

function policy(overrides: Record<string, unknown> = {}) {
  return {
    pullRequest: {
      number: 42, html_url: "https://github.test/acme/widgets/pull/42", state: "open", draft: false,
      title: "Ready", head: { ref: "feature", sha: "head-sha" }, base: { ref: "main", sha: "base-sha" },
      created_at: "2026-08-04T10:00:00Z", updated_at: "2026-08-04T10:00:00Z",
    },
    protected: true,
    requiredApprovals: 1,
    reviews: [{ id: 1, reviewer: "reviewer", state: "APPROVED", commitSha: "head-sha", submittedAt: "2026-08-04T10:00:00Z", qualifies: true }],
    requestedReviewers: [],
    requiredChecks: [{ context: "build", appId: null }],
    checks: [{ context: "build", appId: null, state: "success", updatedAt: "2026-08-04T10:00:00Z" }],
    complete: true,
    fetchedAt: "2026-08-04T10:01:00Z",
    ...overrides,
  } as any;
}

function database(options: { verifiedHash?: string; attempt?: Record<string, unknown> } = {}) {
  const queries: Array<{ sql: string; values?: unknown[] }> = [];
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    queries.push({ sql, values });
    if (sql.includes("FROM pull_requests pr") && sql.includes("pull_request_policy_snapshots")) return { rows: [{
      id: "pr-id", github_owner: "acme", github_repository: "widgets", number: 42,
      expected_snapshot_id: "expected-snapshot", expected_head_sha: "head-sha", expected_material_hash: "same-hash",
    }], rowCount: 1 };
    if (sql.includes("FROM pull_request_merge_attempts")) return { rows: options.attempt ? [options.attempt] : [], rowCount: options.attempt ? 1 : 0 };
    if (sql.includes("INSERT INTO pull_request_policy_snapshots")) return { rows: [{ id: "verified-snapshot", material_hash: options.verifiedHash ?? "same-hash" }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  });
  const client = { query, release: vi.fn() };
  return { query, connect: vi.fn(async () => client), queries } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  github.getPullRequestPolicyInputs.mockResolvedValue(policy());
  github.mergePullRequest.mockResolvedValue({ merged: true, sha: "merge-sha", message: "merged" });
  syncPullRequest.mockResolvedValue(undefined);
});

test("refuses when GitHub's final head differs from the browser-bound head", async () => {
  const db = database();
  github.getPullRequestPolicyInputs.mockResolvedValue(policy({
    pullRequest: { ...policy().pullRequest, head: { ref: "feature", sha: "changed-head" } },
  }));

  await expect(approveAndMergePullRequest(db, expected)).rejects.toMatchObject({ code: "head_changed" });

  expect(github.mergePullRequest).not.toHaveBeenCalled();
  expect(db.queries.some(({ sql, values }: any) => sql.includes("pull_request_merge_attempts") && values?.includes("head_changed"))).toBe(true);
});

test("refuses when protected policy material changed since browser approval", async () => {
  const db = database({ verifiedHash: "changed-hash" });

  await expect(approveAndMergePullRequest(db, expected)).rejects.toMatchObject({ code: "policy_changed" });
  expect(github.mergePullRequest).not.toHaveBeenCalled();
});

test.each([
  ["missing checks", { checks: [] }, "checks_pending"],
  ["failing checks", { checks: [{ context: "build", appId: null, state: "failure", updatedAt: "2026-08-04T10:00:00Z" }] }, "checks_failed"],
  ["missing reviews", { reviews: [] }, "reviews_pending"],
  ["changes-requested review", { reviews: [{ id: 2, reviewer: "reviewer", state: "CHANGES_REQUESTED", commitSha: "head-sha", submittedAt: "2026-08-04T10:00:00Z", qualifies: true }] }, "changes_requested"],
  ["incomplete policy", { complete: false, incompleteReason: "unsupported", reviews: [], checks: [] }, "policy_incomplete"],
])("refuses %s from the final fresh policy inputs", async (_name, overrides, refusalCode) => {
  const db = database();
  github.getPullRequestPolicyInputs.mockResolvedValue(policy(overrides));

  await expect(approveAndMergePullRequest(db, expected)).rejects.toMatchObject({ code: refusalCode });
  expect(github.mergePullRequest).not.toHaveBeenCalled();
});

test("sends the expected head to GitHub and durably records merge evidence", async () => {
  const db = database();

  await expect(approveAndMergePullRequest(db, expected)).resolves.toEqual({
    mergedSha: "merge-sha", mergedHeadSha: "head-sha", policySnapshotId: "verified-snapshot",
  });

  expect(github.mergePullRequest).toHaveBeenCalledWith("acme", "widgets", 42, "squash", "head-sha");
  expect(db.queries.some(({ sql, values }: any) => sql.includes("state='merged'")
    && values?.includes("verified-snapshot") && values?.includes("head-sha") && values?.includes("merge-sha"))).toBe(true);
  expect(syncPullRequest).toHaveBeenCalledWith("pr-id", "admin", "admin-id", expect.any(Function));
});

test("records GitHub's compare-and-swap rejection as a head-race refusal", async () => {
  const db = database();
  github.mergePullRequest.mockRejectedValue(new GitHubProviderError("http_error", "GitHub provider request failed with status 409", 409));

  await expect(approveAndMergePullRequest(db, expected)).rejects.toMatchObject({ code: "provider_head_changed" });

  expect(db.queries.some(({ sql, values }: any) => sql.includes("state='refused'") && values?.includes("provider_head_changed"))).toBe(true);
});

test("reconciles a retry after GitHub merged but the first worker missed durable completion", async () => {
  const db = database({ attempt: {
    state: "verified", expected_head_sha: "head-sha", verified_policy_snapshot_id: "verified-snapshot",
  } });
  github.getPullRequest.mockResolvedValue({ merged: true, head: { sha: "head-sha" }, merge_commit_sha: "merge-sha" });

  await expect(approveAndMergePullRequest(db, expected)).resolves.toEqual({
    mergedSha: "merge-sha", mergedHeadSha: "head-sha", policySnapshotId: "verified-snapshot",
  });

  expect(github.mergePullRequest).not.toHaveBeenCalled();
  expect(github.getPullRequestPolicyInputs).not.toHaveBeenCalled();
  expect(db.queries.some(({ sql }: { sql: string }) => sql.includes("state='merged'"))).toBe(true);
});

test("rejects a job whose expected snapshot is not the PR snapshot it names", async () => {
  const db = database();
  db.query.mockImplementationOnce(async () => ({ rows: [], rowCount: 0 }));

  await expect(approveAndMergePullRequest(db, expected)).rejects.toBeInstanceOf(PullRequestMergeError);
  expect(github.getPullRequestPolicyInputs).not.toHaveBeenCalled();
});
