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
  getBranchHeadCommit, getCommitCheckStatus, getPullRequestsForCommit, updateBranchReference, getPendingDeployments, checkImageExists,
}));
const previewRemoteBranchMerge = vi.fn();
const lsRemoteHeads = vi.fn(async () => new Map());
vi.mock("../../../packages/git-runner/src/index.ts", () => ({
  assertRemoteBranchName: vi.fn(async () => {}),
  lsRemoteHeads,
  previewRemoteBranchMerge,
}));

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

const deploymentConfig = {
  enabled: true,
  production_branch: "production",
  image: { registry: "ghcr.io", repository: "acme/widgets", tag_template: "sha-{{commit}}" },
  health: { host: "https://widgets.example", health_path: "/health", version_path: "/version" },
  promotion: { require_e2e_gate_label: false },
};

const project = {
  id: "project-1",
  github_owner: "acme",
  github_repository: "widgets",
  default_branch: "main",
  repository_path: "/repos/widgets",
  config_json: { deployment: deploymentConfig },
};

test("deployment.sync_status happy path writes a status snapshot", async () => {
  const database = db([project]);
  // No release is in flight — route the production_releases lookup to an empty
  // result so this test only exercises the snapshot-write path.
  database.query.mockImplementation(async (text: string, values?: unknown[]) => {
    database.queries.push({ text, values });
    if (text.includes("FROM production_releases")) return { rows: [], rowCount: 0 };
    return { rows: [project], rowCount: 1 };
  });
  getBranchHeadCommit.mockResolvedValue({ sha: "a".repeat(40), committedAt: "2026-01-01T00:00:00Z", message: "fix things" });
  getCommitCheckStatus.mockResolvedValue({ sha: "a".repeat(40), checks: [], overallState: "success", fetchedAt: "2026-01-01T00:00:00Z" });
  checkImageExists.mockResolvedValue({ exists: true, checkedAt: "2026-01-01T00:00:00Z", authRequired: false });
  checkProductionHealth.mockResolvedValue({ state: "healthy", healthy: true, commit_sha: "a".repeat(40), raw: { commit: "a".repeat(40) } });

  await runProviderJob({
    id: "job-1", type: "deployment.sync_status",
    idempotency_key: "g11:deployment.sync_status:project-1:once",
    payload_json: { actor_id: "admin-1", project_id: "project-1" },
  } as any, database as any);

  const snapshotInsert = database.queries.find((q) => q.text.includes("deployment_status_snapshots"));
  expect(snapshotInsert).toBeDefined();
  expect(snapshotInsert!.values).toEqual([
    "project-1", "a".repeat(40), "success", true, null, "sha-" + "a".repeat(40), true,
    "a".repeat(40), "healthy", JSON.stringify({ commit: "a".repeat(40) }),
  ]);
  const resultUpdate = database.queries.find((q) => q.text.includes("result_json"));
  expect(resultUpdate!.values![1]).toMatchObject({ outcome: "synced" });
});

test("deployment.promote_check reports ineligible with reasons when CI is red", async () => {
  const database = db([project]);
  getBranchHeadCommit.mockResolvedValue({ sha: "b".repeat(40), committedAt: "2026-01-01T00:00:00Z", message: "broken build" });
  getCommitCheckStatus.mockResolvedValue({ sha: "b".repeat(40), checks: [], overallState: "failure", fetchedAt: "2026-01-01T00:00:00Z" });
  checkImageExists.mockResolvedValue({ exists: false, checkedAt: "2026-01-01T00:00:00Z", authRequired: false });
  checkProductionHealth.mockResolvedValue({ state: "healthy", healthy: true, commit_sha: "c".repeat(40), raw: null });
  evaluatePromotionEligibility.mockReturnValue({ eligible: false, reasons: ["ci_not_green", "image_not_built"] });
  lsRemoteHeads.mockResolvedValue(new Map([["production", "c".repeat(40)]]));

  await runProviderJob({
    id: "job-2", type: "deployment.promote_check",
    idempotency_key: "g11:deployment.promote_check:project-1:once",
    payload_json: { actor_id: "admin-1", project_id: "project-1" },
  } as any, database as any);

  expect(evaluatePromotionEligibility).toHaveBeenCalledWith({
    ciState: "failure", imageExists: false, e2eGateRequired: false, e2eGateSatisfied: true,
  });
  const resultUpdate = database.queries.find((q) => q.text.includes("result_json"));
  expect(resultUpdate!.values![1]).toMatchObject({
    eligible: false, reasons: ["ci_not_green", "image_not_built"], master_sha: "b".repeat(40),
  });
});

test("deployment.promote refuses with master_moved when the fresh master sha differs", async () => {
  const database = db([project]);
  getBranchHeadCommit.mockResolvedValue({ sha: "d".repeat(40), committedAt: "2026-01-01T00:00:00Z", message: "newer commit" });

  await runProviderJob({
    id: "job-3", type: "deployment.promote",
    idempotency_key: "g11:deployment.promote:project-1:once",
    payload_json: {
      actor_id: "admin-1", project_id: "project-1",
      commit_sha: "e".repeat(40), expected_master_sha: "f".repeat(40),
    },
  } as any, database as any);

  expect(updateBranchReference).not.toHaveBeenCalled();
  const resultUpdate = database.queries.find((q) => q.text.includes("result_json"));
  expect(resultUpdate!.values![1]).toMatchObject({ outcome: "refused", refusal_code: "master_moved", current_sha: "d".repeat(40) });
  const auditInsert = database.queries.find((q) => q.text.includes("audit_events"));
  expect(auditInsert!.values![5]).toMatchObject({ outcome: "refused", refusal_code: "master_moved" });
});

test("deployment.promote refuses with promotion_in_progress on a unique-violation insert", async () => {
  const database = db([project]);
  const masterSha = "1".repeat(40);
  getBranchHeadCommit.mockResolvedValue({ sha: masterSha, committedAt: "2026-01-01T00:00:00Z", message: "ready to ship" });
  getCommitCheckStatus.mockResolvedValue({ sha: masterSha, checks: [], overallState: "success", fetchedAt: "2026-01-01T00:00:00Z" });
  checkImageExists.mockResolvedValue({ exists: true, checkedAt: "2026-01-01T00:00:00Z", authRequired: false });
  checkProductionHealth.mockResolvedValue({ state: "healthy", healthy: true, commit_sha: "2".repeat(40), raw: null });
  evaluatePromotionEligibility.mockReturnValue({ eligible: true, reasons: [] });
  lsRemoteHeads.mockResolvedValue(new Map([["production", "2".repeat(40)]]));

  const uniqueViolation = Object.assign(new Error("duplicate key value"), { code: "23505" });
  database.query.mockImplementation(async (text: string, values?: unknown[]) => {
    database.queries.push({ text, values });
    if (text.includes("INSERT INTO production_releases")) throw uniqueViolation;
    return { rows: [project], rowCount: 1 };
  });

  await runProviderJob({
    id: "job-4", type: "deployment.promote",
    idempotency_key: "g11:deployment.promote:project-1:once",
    payload_json: {
      actor_id: "admin-1", project_id: "project-1",
      commit_sha: masterSha, expected_master_sha: masterSha,
    },
  } as any, database as any);

  expect(updateBranchReference).not.toHaveBeenCalled();
  const resultUpdate = database.queries.find((q) => q.text.includes("result_json"));
  expect(resultUpdate!.values![1]).toMatchObject({ outcome: "refused", refusal_code: "promotion_in_progress" });
});

test("deployment.rollback refuses with image_gone when the target image no longer exists", async () => {
  const database = db([project]);
  const productionSha = "3".repeat(40);
  lsRemoteHeads.mockResolvedValue(new Map([["production", productionSha]]));
  checkImageExists.mockResolvedValue({ exists: false, checkedAt: "2026-01-01T00:00:00Z", authRequired: false });

  await runProviderJob({
    id: "job-5", type: "deployment.rollback",
    idempotency_key: "g11:deployment.rollback:project-1:once",
    payload_json: {
      actor_id: "admin-1", project_id: "project-1",
      target_commit_sha: "4".repeat(40), expected_production_sha: productionSha,
    },
  } as any, database as any);

  expect(updateBranchReference).not.toHaveBeenCalled();
  const resultUpdate = database.queries.find((q) => q.text.includes("result_json"));
  expect(resultUpdate!.values![1]).toMatchObject({ outcome: "refused", refusal_code: "image_gone" });
  const auditInsert = database.queries.find((q) => q.text.includes("audit_events"));
  expect(auditInsert!.values![5]).toMatchObject({ outcome: "refused", refusal_code: "image_gone" });
});
