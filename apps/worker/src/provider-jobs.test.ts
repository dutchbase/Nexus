import { beforeEach, expect, test, vi } from "vitest";

const syncOpenPullRequests = vi.fn();
const syncPullRequest = vi.fn();
const importGithubPullRequests = vi.fn();
const approveAndMergePullRequest = vi.fn();
const mergeBranch = vi.fn();

vi.mock("@dcc/domain", () => ({
  syncOpenPullRequests,
  syncPullRequest,
  importGithubPullRequests,
  approveAndMergePullRequest,
}));
vi.mock("@dcc/github-provider", () => ({ mergeBranch }));

const { runProviderJob } = await import("./provider-jobs.ts");

beforeEach(() => vi.clearAllMocks());

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
  const database = db([{ id: "project-1", github_owner: "acme", github_repository: "widgets" }]);
  mergeBranch.mockResolvedValue({ outcome: "merged", sha: "abc123" });

  await runProviderJob({
    id: "job-3",
    type: "github.merge_branches",
    idempotency_key: "g07:github.merge_branches:project-1:once",
    payload_json: { actor_id: "admin-1", project_id: "project-1", head: "release", base: "main" },
  }, database as any);

  expect(mergeBranch).toHaveBeenCalledWith("acme", "widgets", "main", "release");
  expect(database.queries.at(-1)?.values).toEqual([
    "admin", "admin-1", "project.merge_branches", "project", "project-1",
    {
      job_id: "job-3",
      idempotency_key: "g07:github.merge_branches:project-1:once",
      head: "release",
      base: "main",
      outcome: "merged",
      sha: "abc123",
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
