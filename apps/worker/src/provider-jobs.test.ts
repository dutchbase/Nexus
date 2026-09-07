import { beforeEach, expect, test, vi } from "vitest";

const syncOpenPullRequests = vi.fn();
const syncPullRequest = vi.fn();
const importGithubPullRequests = vi.fn();
const approveAndMergePullRequest = vi.fn();
const mergeBranch = vi.fn();
const createPullRequest = vi.fn();
const findOpenPullRequestForHead = vi.fn();
const checkProductionHealth = vi.fn();
const evaluatePromotionEligibility = vi.fn();
const getBranchHeadCommit = vi.fn();
const getCommitCheckStatus = vi.fn();
const getPullRequestsForCommit = vi.fn();
const updateBranchReference = vi.fn();
const updateBranchReferencesIfMatches = vi.fn();
const getPendingDeployments = vi.fn();
const checkImageExists = vi.fn();
const compareCommits = vi.fn();
class GitHubProviderError extends Error {
  constructor(public code: string, message: string, public status?: number) { super(message); }
}

vi.mock("@dcc/domain", () => {
  class PullRequestMergeError extends Error {
    code: string;
    constructor(message: string, code = "merge_failed") { super(message); this.code = code; }
  }
  return {
    syncOpenPullRequests, syncPullRequest, importGithubPullRequests, approveAndMergePullRequest, PullRequestMergeError,
    checkProductionHealth, evaluatePromotionEligibility,
  };
});
vi.mock("@dcc/github-provider", () => ({
  mergeBranch, createPullRequest, findOpenPullRequestForHead,
  getBranchHeadCommit, getCommitCheckStatus, getPullRequestsForCommit, updateBranchReference, updateBranchReferencesIfMatches,
  getPendingDeployments, checkImageExists, compareCommits, GitHubProviderError,
}));
const previewRemoteBranchMerge = vi.fn();
const lsRemoteHeads = vi.fn(async () => new Map());
vi.mock("../../../packages/git-runner/src/index.ts", () => ({
  assertRemoteBranchName: vi.fn(async () => {}),
  lsRemoteHeads,
  previewRemoteBranchMerge,
}));

const { runProviderJob } = await import("./provider-jobs.ts");

beforeEach(() => {
  vi.resetAllMocks();
  lsRemoteHeads.mockResolvedValue(new Map());
  compareCommits.mockResolvedValue({ status: "diverged", aheadBy: 0, behindBy: 0 });
});

type Query = { text: string; values?: unknown[] };
function db(rows: any[] = []) {
  const queries: Query[] = [];
  return {
    queries,
    query: vi.fn(async (text: string, values?: unknown[]) => {
      queries.push({ text, values });
      return { rows, rowCount: rows.length };
    }),
  };
}

test("records the source job and initiating admin after a pull-request merge", async () => {
  const database = db([{ id: "pr-1", repository: "acme/widgets", number: 4, base_branch: "main", is_draft: false }]);
  await runProviderJob({
    id: "job-1",
    type: "github.merge_pull_request",
    idempotency_key: "g07:github.merge_pull_request:pr-1:once",
    payload_json: {
      actor_id: "admin-1", pull_request_id: "pr-1",
      expected_head_sha: "head-sha", policy_snapshot_id: "snapshot-1",
    },
  }, database as any);

  expect(approveAndMergePullRequest).toHaveBeenCalledWith(
    database,
    {
      pullRequestId: "pr-1", jobId: "job-1", actor: { type: "admin", id: "admin-1" },
      expectedHeadSha: "head-sha", expectedPolicySnapshotId: "snapshot-1",
    },
    expect.any(Function),
  );
  expect(database.queries.at(-1)).toEqual(expect.objectContaining({
    values: ["admin", "admin-1", "github.merge_pull_request", "pull_request", "pr-1", {
      job_id: "job-1",
      idempotency_key: "g07:github.merge_pull_request:pr-1:once",
      expected_head_sha: "head-sha",
      policy_snapshot_id: "snapshot-1",
    }],
  }));
});

test("imports every configured project when the job has no project target", async () => {
  const database = db([
    { id: "project-1", github_owner: "acme", github_repository: "widgets" },
    { id: "project-2", github_owner: "acme", github_repository: "api" },
  ]);
  importGithubPullRequests.mockResolvedValue({ imported: 3 });

  await runProviderJob({
    id: "job-2",
    type: "github.import",
    idempotency_key: "g07:github.import:all:once",
    payload_json: { actor_id: "admin-1" },
  }, database as any);

  expect(importGithubPullRequests).toHaveBeenCalledTimes(2);
  expect(database.queries.at(-1)?.values).toEqual([
    "admin", "admin-1", "github.import", "project", null,
    { job_id: "job-2", idempotency_key: "g07:github.import:all:once", imported: 6 },
  ]);
});

test("preserves the requested source and destination branches on branch merge audit", async () => {
  const headSha = "a".repeat(40);
  const baseSha = "b".repeat(40);
  lsRemoteHeads.mockResolvedValue(new Map([["release", headSha], ["main", baseSha]]));
  const database = db([{ id: "project-1", repository_path: "/repos/widgets", github_owner: "acme", github_repository: "widgets" }]);
  mergeBranch.mockResolvedValue({ outcome: "merged", sha: "c".repeat(40) });

  await runProviderJob({
    id: "job-3",
    type: "github.merge_branches",
    idempotency_key: "g07:github.merge_branches:project-1:once",
    payload_json: { actor_id: "admin-1", project_id: "project-1", head: "release", base: "main", expected_head_sha: headSha, expected_base_sha: baseSha },
  }, database as any);

  expect(mergeBranch).toHaveBeenCalledWith("acme", "widgets", expect.stringMatching(/^nexus\/merge-/), headSha);
  expect(database.queries.at(-1)?.values).toEqual([
    "admin", "admin-1", "project.merge_branches", "project", "project-1",
    {
      job_id: "job-3",
      idempotency_key: "g07:github.merge_branches:project-1:once",
      head: "release",
      base: "main",
      outcome: "merged",
      sha: "c".repeat(40),
    },
  ]);
});

test("dispatches sync jobs with their initiating admin", async () => {
  const database = db();
  await runProviderJob({
    id: "job-4",
    type: "github.sync_one",
    idempotency_key: "g07:github.sync_one:pr-1:once",
    payload_json: { actor_id: "admin-1", pull_request_id: "pr-1" },
  }, database as any);
  await runProviderJob({
    id: "job-5",
    type: "github.sync_open",
    idempotency_key: "g07:github.sync_open:all:once",
    payload_json: { actor_id: "admin-1" },
  }, database as any);

  expect(syncPullRequest).toHaveBeenCalledWith("pr-1", "admin", "admin-1", expect.any(Function));
  expect(syncOpenPullRequests).toHaveBeenCalledWith(expect.any(Function));
  expect(database.queries.at(-1)?.values).toEqual([
    "admin", "admin-1", "github.sync_open", "pull_request", null,
    { job_id: "job-5", idempotency_key: "g07:github.sync_open:all:once" },
  ]);
});

test("fences provider side effects before dispatch", async () => {
  const database = db([{ id: "pr-1", repository: "acme/widgets", number: 4 }]);
  const fence = vi.fn().mockRejectedValue(new Error("lease lost"));

  await expect(runProviderJob({
    id: "job-6",
    type: "github.merge_pull_request",
    idempotency_key: "g07:github.merge_pull_request:pr-1:once",
    payload_json: { actor_id: "admin-1", pull_request_id: "pr-1", expected_head_sha: "head-sha", policy_snapshot_id: "snapshot-1" },
  }, database as any, fence)).rejects.toThrow("lease lost");

  expect(approveAndMergePullRequest).not.toHaveBeenCalled();
});

test("allows a merge job without a policy snapshot binding", async () => {
  const database = db([{ id: "pr-1" }]);

  await runProviderJob({
    id: "job-7", type: "github.merge_pull_request",
    idempotency_key: "g07:github.merge_pull_request:pr-1:once",
    payload_json: { actor_id: "admin-1", pull_request_id: "pr-1", expected_head_sha: "head-sha" },
  }, database as any);

  expect(approveAndMergePullRequest).toHaveBeenCalledWith(
    database,
    expect.objectContaining({ expectedHeadSha: "head-sha", expectedPolicySnapshotId: undefined }),
    expect.any(Function),
  );
  expect(database.queries.at(-1)?.values?.[5]).toEqual(expect.objectContaining({ expected_head_sha: "head-sha" }));
  expect(database.queries.at(-1)?.values?.[5]).not.toHaveProperty("policy_snapshot_id");
});

test("requires a merge job head binding", async () => {
  const database = db([{ id: "pr-1" }]);
  const payload: Record<string, unknown> = {
    actor_id: "admin-1", pull_request_id: "pr-1", expected_head_sha: "head-sha", policy_snapshot_id: "snapshot-1",
  };
  delete payload.expected_head_sha;

  await expect(runProviderJob({
    id: "job-7", type: "github.merge_pull_request",
    idempotency_key: "g07:github.merge_pull_request:pr-1:once", payload_json: payload,
  }, database as any)).rejects.toThrow("expected_head_sha is required");

  expect(approveAndMergePullRequest).not.toHaveBeenCalled();
});

test("merge_preview persists a read-only preview into result_json", async () => {
  const database = db([{ id: "proj-1", repository_path: "/repos/widgets", github_owner: "acme", github_repository: "widgets" }]);
  previewRemoteBranchMerge.mockResolvedValueOnce({
    branches: [{ name: "main", sha: "a".repeat(40) }], head: null, base: null,
    outcome: "branches_only", commits_ahead: null, conflicted_files: [],
  });

  await runProviderJob({
    id: "job-9", type: "github.merge_preview",
    idempotency_key: "g07:github.merge_preview:one", payload_json: { actor_id: "admin-1", project_id: "proj-1" },
  }, database as any);

  expect(previewRemoteBranchMerge).toHaveBeenCalledWith({ repositoryPath: "/repos/widgets", head: undefined, base: undefined });
  const resultUpdate = database.queries.find((q) => q.text.includes("result_json"));
  expect(resultUpdate).toBeDefined();
  expect(resultUpdate!.values![1]).toMatchObject({ outcome: "branches_only" });
});

test("merge_preview propagates a placeholder-path configuration error unchanged", async () => {
  const database = db([{ id: "proj-1", repository_path: "/PLACEHOLDER/set-a-real-local-clone-path-for-va-jobs-platform", github_owner: "dutchbase", github_repository: "va-jobs-platform" }]);
  previewRemoteBranchMerge.mockRejectedValueOnce(new Error("Project local repository path is not configured correctly. Set a real local clone path for this project on the Projects page before running merge pre-flight."));

  await expect(runProviderJob({
    id: "job-10", type: "github.merge_preview",
    idempotency_key: "g07:github.merge_preview:two", payload_json: { actor_id: "admin-1", project_id: "proj-1" },
  }, database as any)).rejects.toThrow(/local repository path is not configured correctly/i);

  expect(previewRemoteBranchMerge).toHaveBeenCalledWith({ repositoryPath: "/PLACEHOLDER/set-a-real-local-clone-path-for-va-jobs-platform", head: undefined, base: undefined });
  const resultUpdate = database.queries.find((q) => q.text.includes("result_json"));
  expect(resultUpdate).toBeUndefined();
});

test("merge_branches refuses without merging when a ref moved since the preview", async () => {
  lsRemoteHeads.mockResolvedValueOnce(new Map([["staging", "b".repeat(40)], ["main", "c".repeat(40)]]));
  const database = db([{ id: "proj-1", repository_path: "/repos/widgets", github_owner: "acme", github_repository: "widgets" }]);

  await runProviderJob({
    id: "job-10", type: "github.merge_branches",
    idempotency_key: "g07:github.merge_branches:once",
    payload_json: { actor_id: "admin-1", project_id: "proj-1", head: "staging", base: "main", expected_head_sha: "a".repeat(40), expected_base_sha: "c".repeat(40) },
  }, database as any);

  expect(mergeBranch).not.toHaveBeenCalled();
  const resultUpdate = database.queries.find((q) => q.text.includes("result_json"));
  expect(resultUpdate!.values![1]).toMatchObject({ outcome: "refused", refusal_code: "refs_changed" });
});

test("merge_branches refuses when an expected ref was deleted after preview", async () => {
  lsRemoteHeads.mockResolvedValueOnce(new Map([["main", "b".repeat(40)]]));
  const database = db([{ id: "proj-1", repository_path: "/repos/widgets", github_owner: "acme", github_repository: "widgets" }]);

  await runProviderJob({
    id: "job-ref-deleted", type: "github.merge_branches",
    idempotency_key: "g07:github.merge_branches:deleted",
    payload_json: { actor_id: "admin-1", project_id: "proj-1", head: "staging", base: "main", expected_head_sha: "a".repeat(40), expected_base_sha: "b".repeat(40) },
  }, database as any);

  expect(mergeBranch).not.toHaveBeenCalled();
  expect(database.queries.find((q) => q.text.includes("result_json"))!.values![1])
    .toMatchObject({ outcome: "refused", refusal_code: "refs_changed" });
});

test("merge_branches sends the reviewed head SHA instead of a moving branch name", async () => {
  lsRemoteHeads.mockResolvedValueOnce(new Map([["staging", "a".repeat(40)], ["main", "b".repeat(40)]]));
  mergeBranch.mockResolvedValueOnce({ outcome: "merged", sha: "c".repeat(40) });
  const database = db([{ id: "proj-1", repository_path: "/repos/widgets", github_owner: "acme", github_repository: "widgets" }]);

  await runProviderJob({
    id: "job-pinned-head", type: "github.merge_branches",
    idempotency_key: "g07:github.merge_branches:pinned",
    payload_json: { actor_id: "admin-1", project_id: "proj-1", head: "staging", base: "main", expected_head_sha: "a".repeat(40), expected_base_sha: "b".repeat(40) },
  }, database as any);

  expect(mergeBranch).toHaveBeenCalledWith("acme", "widgets", expect.stringMatching(/^nexus\/merge-/), "a".repeat(40));
});

test("merge_branches rejects a concurrent base move at the atomic publication step", async () => {
  lsRemoteHeads
    .mockResolvedValueOnce(new Map([["staging", "a".repeat(40)], ["main", "b".repeat(40)]]))
    .mockResolvedValueOnce(new Map([["staging", "a".repeat(40)], ["main", "d".repeat(40)]]));
  updateBranchReferencesIfMatches
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error("beforeOid mismatch"))
    .mockResolvedValueOnce(undefined);
  mergeBranch.mockResolvedValueOnce({ outcome: "merged", sha: "c".repeat(40) });
  getBranchHeadCommit.mockResolvedValueOnce({ sha: "c".repeat(40) });
  const database = db([{ id: "proj-1", repository_path: "/repos/widgets", github_owner: "acme", github_repository: "widgets" }]);

  await runProviderJob({
    id: "job-concurrent-base", type: "github.merge_branches",
    idempotency_key: "g07:github.merge_branches:concurrent",
    payload_json: { actor_id: "admin-1", project_id: "proj-1", head: "staging", base: "main", expected_head_sha: "a".repeat(40), expected_base_sha: "b".repeat(40) },
  }, database as any);

  expect(updateBranchReferencesIfMatches.mock.calls[1][2]).toEqual(expect.arrayContaining([
    { branch: "main", beforeSha: "b".repeat(40), afterSha: "c".repeat(40) },
    { branch: "staging", beforeSha: "a".repeat(40), afterSha: "a".repeat(40) },
  ]));
  expect(updateBranchReferencesIfMatches.mock.calls[2][2]).toEqual([
    { branch: expect.stringMatching(/^nexus\/merge-/), beforeSha: "c".repeat(40), afterSha: "0".repeat(40) },
  ]);
  expect(database.queries.find((q) => q.text.includes("result_json"))?.values?.[1])
    .toMatchObject({ outcome: "refused", refusal_code: "refs_changed" });
});

test("merge_branches reconciles when the atomic mutation response is lost after application", async () => {
  lsRemoteHeads
    .mockResolvedValueOnce(new Map([["staging", "a".repeat(40)], ["main", "b".repeat(40)]]))
    .mockResolvedValueOnce(new Map([["staging", "a".repeat(40)], ["main", "c".repeat(40)]]));
  updateBranchReferencesIfMatches
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error("connection closed before response"));
  mergeBranch.mockResolvedValueOnce({ outcome: "merged", sha: "c".repeat(40) });
  getBranchHeadCommit.mockRejectedValueOnce(new GitHubProviderError("not_found", "missing", 404));
  compareCommits.mockResolvedValueOnce({ status: "ahead", aheadBy: 1, behindBy: 0 });
  const database = db([{ id: "proj-1", repository_path: "/repos/widgets", github_owner: "acme", github_repository: "widgets" }]);

  await runProviderJob({
    id: "job-lost-cas-response", type: "github.merge_branches",
    idempotency_key: "g07:github.merge_branches:lost-cas-response",
    payload_json: { actor_id: "admin-1", project_id: "proj-1", head: "staging", base: "main", expected_head_sha: "a".repeat(40), expected_base_sha: "b".repeat(40) },
  }, database as any);

  expect(database.queries.find((query) => query.text.startsWith("UPDATE jobs"))?.values?.[1])
    .toMatchObject({ outcome: "already_up_to_date", reconciled: true, sha: "c".repeat(40) });
});

test("merge_branches cleans its temporary ref when the lease is lost after creation", async () => {
  lsRemoteHeads.mockResolvedValue(new Map([["staging", "a".repeat(40)], ["main", "b".repeat(40)]]));
  updateBranchReferencesIfMatches.mockResolvedValue(undefined);
  getBranchHeadCommit.mockResolvedValueOnce({ sha: "b".repeat(40) });
  const assertOwned = vi.fn()
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error("lease lost"));
  const database = db([{ id: "proj-1", repository_path: "/repos/widgets", github_owner: "acme", github_repository: "widgets" }]);

  await expect(runProviderJob({
    id: "job-lease-loss", type: "github.merge_branches",
    idempotency_key: "g07:github.merge_branches:lease-loss",
    payload_json: { actor_id: "admin-1", project_id: "proj-1", head: "staging", base: "main", expected_head_sha: "a".repeat(40), expected_base_sha: "b".repeat(40) },
  }, database as any, assertOwned)).rejects.toThrow("lease lost");

  expect(updateBranchReferencesIfMatches).toHaveBeenCalledTimes(2);
  expect(updateBranchReferencesIfMatches.mock.calls[1][2]).toEqual([
    { branch: expect.stringMatching(/^nexus\/merge-/), beforeSha: "b".repeat(40), afterSha: "0".repeat(40) },
  ]);
});

test("merge_branches exposes the owned temporary ref when cleanup fails", async () => {
  lsRemoteHeads.mockResolvedValue(new Map([["staging", "a".repeat(40)], ["main", "b".repeat(40)]]));
  updateBranchReferencesIfMatches
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error("provider unavailable"));
  mergeBranch.mockRejectedValueOnce(new Error("merge request failed"));
  getBranchHeadCommit.mockResolvedValueOnce({ sha: "b".repeat(40) });
  const database = db([{ id: "proj-1", repository_path: "/repos/widgets", github_owner: "acme", github_repository: "widgets" }]);

  await expect(runProviderJob({
    id: "job-cleanup-failure", type: "github.merge_branches",
    idempotency_key: "g07:github.merge_branches:cleanup-failure",
    payload_json: { actor_id: "admin-1", project_id: "proj-1", head: "staging", base: "main", expected_head_sha: "a".repeat(40), expected_base_sha: "b".repeat(40) },
  }, database as any)).rejects.toThrow(/cleanup failed for nexus\/merge-[0-9a-f]+: provider unavailable/);

  expect(database.queries.find((query) => query.text.startsWith("UPDATE jobs"))?.values?.[1])
    .toMatchObject({ outcome: "failed", error: expect.stringContaining("nexus/merge-") });
});

test("merge_branches reconciles a retry after remote CAS succeeded but result persistence failed", async () => {
  lsRemoteHeads
    .mockResolvedValueOnce(new Map([["staging", "a".repeat(40)], ["main", "b".repeat(40)]]))
    .mockResolvedValueOnce(new Map([["staging", "a".repeat(40)], ["main", "c".repeat(40)]]));
  updateBranchReferencesIfMatches.mockResolvedValue(undefined);
  mergeBranch.mockResolvedValueOnce({ outcome: "merged", sha: "c".repeat(40) });
  compareCommits.mockResolvedValueOnce({ status: "ahead", aheadBy: 1, behindBy: 0 });
  let persistFailures = 1;
  const queries: Query[] = [];
  const database = {
    queries,
    query: vi.fn(async (text: string, values?: unknown[]) => {
      queries.push({ text, values });
      if (text.startsWith("SELECT * FROM projects")) return { rows: [{ id: "proj-1", repository_path: "/repos/widgets", github_owner: "acme", github_repository: "widgets" }], rowCount: 1 };
      if (text.startsWith("UPDATE jobs") && persistFailures-- > 0) throw new Error("result persistence failed");
      return { rows: [], rowCount: 0 };
    }),
  };
  const job = {
    id: "job-persist-retry", type: "github.merge_branches" as const,
    idempotency_key: "g07:github.merge_branches:persist-retry",
    payload_json: { actor_id: "admin-1", project_id: "proj-1", head: "staging", base: "main", expected_head_sha: "a".repeat(40), expected_base_sha: "b".repeat(40) },
  };

  await expect(runProviderJob(job, database as any)).rejects.toThrow("result persistence failed");
  await expect(runProviderJob(job, database as any)).resolves.toBeUndefined();

  expect(mergeBranch).toHaveBeenCalledTimes(1);
  expect(database.queries.filter((query) => query.text.startsWith("UPDATE jobs")).at(-1)?.values?.[1])
    .toMatchObject({ outcome: "already_up_to_date", reconciled: true, sha: "c".repeat(40) });
});

test("open_pull_request creates a PR with a default title and records the result", async () => {
  const database = db([{ id: "proj-1", repository_path: "/repos/widgets", github_owner: "acme", github_repository: "widgets" }]);
  findOpenPullRequestForHead.mockResolvedValueOnce(null);
  createPullRequest.mockResolvedValueOnce({ number: 9, html_url: "https://github.example/acme/widgets/pull/9" });

  await runProviderJob({
    id: "job-11", type: "github.open_pull_request",
    idempotency_key: "g07:github.open_pull_request:once",
    payload_json: { actor_id: "admin-1", project_id: "proj-1", head: "feature", base: "main" },
  }, database as any);

  expect(createPullRequest).toHaveBeenCalledWith(expect.objectContaining({
    owner: "acme", repository: "widgets", head: "feature", base: "main", title: "feature → main",
  }));
  expect(findOpenPullRequestForHead).toHaveBeenCalledWith("acme", "widgets", "feature", "main");
  const resultUpdate = database.queries.find((q) => q.text.includes("result_json"));
  expect(resultUpdate!.values![1]).toMatchObject({ outcome: "created", number: 9, url: "https://github.example/acme/widgets/pull/9" });
  const auditInsert = database.queries.find((q) => q.text.includes("audit_events"));
  expect(auditInsert!.values![2]).toBe("project.open_pull_request");
  expect(auditInsert!.values![5]).toMatchObject({ head: "feature", base: "main", outcome: "created", number: 9 });
});

test("open_pull_request links the existing PR instead of duplicating it", async () => {
  const database = db([{ id: "proj-1", repository_path: "/repos/widgets", github_owner: "acme", github_repository: "widgets" }]);
  findOpenPullRequestForHead.mockResolvedValueOnce({ number: 4, html_url: "https://github.example/acme/widgets/pull/4" });

  await runProviderJob({
    id: "job-12", type: "github.open_pull_request",
    idempotency_key: "g07:github.open_pull_request:once",
    payload_json: { actor_id: "admin-1", project_id: "proj-1", head: "feature", base: "main" },
  }, database as any);

  expect(createPullRequest).not.toHaveBeenCalled();
  const resultUpdate = database.queries.find((q) => q.text.includes("result_json"));
  expect(resultUpdate!.values![1]).toMatchObject({ outcome: "already_open", number: 4, url: "https://github.example/acme/widgets/pull/4" });
});

test("open_pull_request records the failure and rethrows", async () => {
  const database = db([{ id: "proj-1", repository_path: "/repos/widgets", github_owner: "acme", github_repository: "widgets" }]);
  findOpenPullRequestForHead.mockResolvedValueOnce(null);
  createPullRequest.mockRejectedValueOnce(new Error("branch not found"));

  await expect(runProviderJob({
    id: "job-13", type: "github.open_pull_request",
    idempotency_key: "g07:github.open_pull_request:once",
    payload_json: { actor_id: "admin-1", project_id: "proj-1", head: "feature", base: "main" },
  }, database as any)).rejects.toThrow("branch not found");

  const resultUpdate = database.queries.find((q) => q.text.includes("result_json"));
  expect(resultUpdate!.values![1]).toMatchObject({ outcome: "failed", error: "branch not found" });
});

test("open_pull_request rejects a payload without branches", async () => {
  const database = db([]);
  await expect(runProviderJob({
    id: "job-14", type: "github.open_pull_request",
    idempotency_key: "g07:github.open_pull_request:once",
    payload_json: { actor_id: "admin-1", project_id: "proj-1" },
  }, database as any)).rejects.toThrow("head is required");
});
