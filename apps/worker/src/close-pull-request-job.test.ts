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
const getPendingDeployments = vi.fn();
const checkImageExists = vi.fn();
const closePullRequest = vi.fn();

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
  mergeBranch, createPullRequest, findOpenPullRequestForHead, closePullRequest,
  getBranchHeadCommit, getCommitCheckStatus, getPullRequestsForCommit, updateBranchReference, getPendingDeployments, checkImageExists,
}));
vi.mock("../../../packages/git-runner/src/index.ts", () => ({
  assertRemoteBranchName: vi.fn(async () => {}),
  lsRemoteHeads: vi.fn(async () => new Map()),
  previewRemoteBranchMerge: vi.fn(),
}));

const { runProviderJob } = await import("./provider-jobs.ts");

beforeEach(() => vi.clearAllMocks());

type Query = { text: string; values?: unknown[] };
function db(queue: any[][]) {
  const queries: Query[] = [];
  let call = 0;
  return {
    queries,
    query: vi.fn(async (text: string, values?: unknown[]) => {
      queries.push({ text, values });
      const rows = queue[call] ?? [];
      call += 1;
      return { rows, rowCount: rows.length };
    }),
  };
}

test("closes an open pull request and records the outcome", async () => {
  const database = db([
    [{ id: "pr-1", number: 4, state: "open", github_owner: "acme", github_repository: "widgets" }],
    [],
    [],
  ]);

  await runProviderJob({
    id: "job-1",
    type: "github.close_pull_request",
    idempotency_key: "g07:github.close_pull_request:pr-1:once",
    payload_json: { actor_id: "admin-1", pull_request_id: "pr-1" },
  }, database as any);

  expect(closePullRequest).toHaveBeenCalledWith("acme", "widgets", 4);
  const updateCall = database.queries.find((q) => q.text.includes("UPDATE pull_requests"));
  expect(updateCall).toBeDefined();
  expect(updateCall!.values).toEqual(["pr-1"]);
  expect(updateCall!.text).toContain("state='closed'");
  const auditInsert = database.queries.find((q) => q.text.includes("audit_events"));
  expect(auditInsert).toBeDefined();
  expect(auditInsert!.values).toEqual([
    "admin", "admin-1", "github.close_pull_request", "pull_request", "pr-1",
    { job_id: "job-1", idempotency_key: "g07:github.close_pull_request:pr-1:once" },
  ]);
});

test("skips a pull request that is already closed or merged", async () => {
  const database = db([
    [{ id: "pr-1", number: 4, state: "merged", github_owner: "acme", github_repository: "widgets" }],
    [],
  ]);

  await runProviderJob({
    id: "job-2",
    type: "github.close_pull_request",
    idempotency_key: "g07:github.close_pull_request:pr-1:once",
    payload_json: { actor_id: "admin-1", pull_request_id: "pr-1" },
  }, database as any);

  expect(closePullRequest).not.toHaveBeenCalled();
  const resultUpdate = database.queries.find((q) => q.text.includes("result_json"));
  expect(resultUpdate).toBeDefined();
  expect(resultUpdate!.values![1]).toMatchObject({ outcome: "skipped", reason: "pull request state is merged, not open" });
  expect(database.queries.some((q) => q.text.includes("audit_events"))).toBe(false);
});

test("throws when the pull request is not found", async () => {
  const database = db([[]]);

  await expect(runProviderJob({
    id: "job-3",
    type: "github.close_pull_request",
    idempotency_key: "g07:github.close_pull_request:pr-1:once",
    payload_json: { actor_id: "admin-1", pull_request_id: "pr-1" },
  }, database as any)).rejects.toThrow("pull request not found");

  expect(closePullRequest).not.toHaveBeenCalled();
});
