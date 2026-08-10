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

function database(options: { enabled?: boolean; ticketStatus?: string; missingStored?: boolean; verifiedHash?: string; attempt?: Record<string, unknown> } = {}) {
  const queries: Array<{ sql: string; values?: unknown[] }> = [];
  const ticket = options.ticketStatus ? { id: "ticket-id", status: options.ticketStatus } : null;
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    queries.push({ sql, values });
    if (sql.includes("FROM pull_request_merge_settings")) return { rows: [{ require_fresh_policy_binding: options.enabled ?? true }], rowCount: 1 };
    if (sql.includes("FROM pull_requests pr") && !sql.includes("pull_request_policy_snapshots") && !sql.includes("JOIN tickets t")) return { rows: [{
      id: "pr-id", github_owner: "acme", github_repository: "widgets", number: 42,
      ticket_id: "ticket-id", ticket_status: "PR Approved",
    }], rowCount: 1 };
    if (sql.includes("FROM pull_requests pr") && sql.includes("pull_request_policy_snapshots")) return { rows: options.missingStored ? [] : [{
      id: "pr-id", github_owner: "acme", github_repository: "widgets", number: 42,
      expected_snapshot_id: "expected-snapshot", expected_head_sha: "head-sha", expected_material_hash: "same-hash",
    }], rowCount: options.missingStored ? 0 : 1 };
    if (sql.includes("FROM pull_request_merge_attempts")) return { rows: options.attempt ? [options.attempt] : [], rowCount: options.attempt ? 1 : 0 };
    if (sql.includes("FROM pull_requests pr JOIN tickets t") && sql.includes("FOR UPDATE")) return { rows: ticket ? [{
      id: "pr-id", ticket_id: ticket.id, ticket_status: ticket.status,
    }] : [], rowCount: ticket ? 1 : 0 };
    if (sql.includes("UPDATE tickets SET status=$2") && ticket) {
      ticket.status = values?.[1] as string;
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO pull_request_policy_snapshots")) return { rows: [{ id: "verified-snapshot", material_hash: options.verifiedHash ?? "same-hash" }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  });
  const client = { query, release: vi.fn() };
  return { query, connect: vi.fn(async () => client), queries } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  github.getPullRequest.mockResolvedValue({ merged: false, head: { sha: "head-sha" } });
  github.getPullRequestPolicyInputs.mockResolvedValue(policy());
  github.mergePullRequest.mockResolvedValue({ merged: true, sha: "merge-sha", message: "merged" });
  syncPullRequest.mockResolvedValue(undefined);
});

test("merges a matching head and records cached PR and ticket completion when policy binding is disabled", async () => {
  const db = database({ enabled: false, ticketStatus: "PR Approved" });

  await expect(approveAndMergePullRequest(db, { ...expected, expectedPolicySnapshotId: undefined })).resolves.toEqual({
    mergedSha: "merge-sha", mergedHeadSha: "head-sha", policySnapshotId: null,
  });

  expect(github.getPullRequest).toHaveBeenCalledWith("acme", "widgets", 42);
  expect(github.getPullRequestPolicyInputs).not.toHaveBeenCalled();
  expect(syncPullRequest).not.toHaveBeenCalled();
  expect(github.mergePullRequest).toHaveBeenCalledWith("acme", "widgets", 42, "squash", "head-sha");
  expect(db.queries.some(({ sql, values }: any) => sql.includes("pull_request_merge_attempts")
    && values?.includes(null))).toBe(true);
  expect(db.queries.some(({ sql }) => sql.includes("state='merged'") && sql.includes("merge_commit_sha"))).toBe(true);
  expect(db.queries.filter(({ sql }) => sql.includes("INSERT INTO ticket_status_history")).map(({ values }) => values?.[2]))
    .toEqual(["Merged", "Completed"]);
});

test("reconciles a verified disabled merge without another provider merge", async () => {
  const db = database({
    enabled: false,
    ticketStatus: "PR Approved",
    attempt: { state: "verified", expected_head_sha: "head-sha", verified_policy_snapshot_id: null },
  });
  github.getPullRequest.mockResolvedValue({ merged: true, head: { sha: "head-sha" }, merge_commit_sha: "merge-sha" });

  await expect(approveAndMergePullRequest(db, { ...expected, expectedPolicySnapshotId: undefined })).resolves.toEqual({
    mergedSha: "merge-sha", mergedHeadSha: "head-sha", policySnapshotId: null,
  });

  expect(github.mergePullRequest).not.toHaveBeenCalled();
  expect(github.getPullRequestPolicyInputs).not.toHaveBeenCalled();
  expect(syncPullRequest).not.toHaveBeenCalled();
  expect(db.queries.some(({ sql }) => sql.includes("state='merged'") && sql.includes("merge_commit_sha"))).toBe(true);
});

test("does not complete a terminal linked ticket when policy binding is disabled", async () => {
  const db = database({ enabled: false, ticketStatus: "Closed Without Merge" });

  await expect(approveAndMergePullRequest(db, { ...expected, expectedPolicySnapshotId: undefined })).resolves.toEqual({
    mergedSha: "merge-sha", mergedHeadSha: "head-sha", policySnapshotId: null,
  });

  expect(db.queries.some(({ sql }) => sql.includes("UPDATE tickets SET status=$2"))).toBe(false);
  expect(db.queries.some(({ sql }) => sql.includes("INSERT INTO ticket_status_history"))).toBe(false);
});

test("refuses a changed head before the merge request when policy binding is disabled", async () => {
  const db = database({ enabled: false });
  github.getPullRequest.mockResolvedValue({ merged: false, head: { sha: "changed-head" } });

  await expect(approveAndMergePullRequest(db, { ...expected, expectedPolicySnapshotId: undefined }))
    .rejects.toMatchObject({ code: "head_changed" });

  expect(github.getPullRequestPolicyInputs).not.toHaveBeenCalled();
  expect(github.mergePullRequest).not.toHaveBeenCalled();
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

test.each([
  ["HTTP", "provider_error", { code: "http_error", status: 422, message: "GitHub rejected the merge" }],
  ["merged:false", "provider_refused", { merged: false, sha: "", message: "Pull Request is not mergeable" }],
])("keeps a prior %s refusal terminal on retry", async (_kind, refusalCode, providerResponse) => {
  const db = database({ attempt: { state: "refused", refusal_code: refusalCode, provider_response: providerResponse } });

  await expect(approveAndMergePullRequest(db, expected)).rejects.toMatchObject({
    code: refusalCode,
    message: providerResponse.message,
  });

  expect(github.getPullRequestPolicyInputs).not.toHaveBeenCalled();
  expect(github.mergePullRequest).not.toHaveBeenCalled();
  expect(db.queries.some(({ sql }: { sql: string }) => /(?:INSERT|UPDATE) (?:INTO )?pull_request_merge_attempts/.test(sql))).toBe(false);
});

test.each(["transient", "invalid_response"])("reconciles a retry after an ambiguous %s merge error", async (code) => {
  const first = database();
  github.mergePullRequest.mockRejectedValueOnce(new GitHubProviderError(code, "ambiguous merge result"));

  await expect(approveAndMergePullRequest(first, expected)).rejects.toMatchObject({ code: "provider_error" });

  expect(first.queries.some(({ sql, values }: any) => sql.includes("INSERT INTO pull_request_merge_attempts")
    && values?.includes("verified"))).toBe(true);
  expect(first.queries.some(({ sql }: { sql: string }) => sql.includes("state='refused'"))).toBe(false);
  const retry = database({ attempt: {
    state: "verified", expected_head_sha: "head-sha", verified_policy_snapshot_id: "verified-snapshot",
  } });
  github.getPullRequest.mockResolvedValue({ merged: true, head: { sha: "head-sha" }, merge_commit_sha: "merge-sha" });

  await expect(approveAndMergePullRequest(retry, expected)).resolves.toEqual({
    mergedSha: "merge-sha", mergedHeadSha: "head-sha", policySnapshotId: "verified-snapshot",
  });
  expect(github.mergePullRequest).toHaveBeenCalledTimes(1);
  expect(retry.queries.some(({ sql, values }: any) => sql.includes("state='merged'")
    && values?.includes("verified-snapshot") && values?.includes("head-sha") && values?.includes("merge-sha"))).toBe(true);
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
  const db = database({ missingStored: true });

  await expect(approveAndMergePullRequest(db, expected)).rejects.toBeInstanceOf(PullRequestMergeError);
  expect(github.getPullRequestPolicyInputs).not.toHaveBeenCalled();
});
