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
const findWorkflowRun = vi.fn();
const getWorkflowRunJobs = vi.fn();
const compareCommits = vi.fn();
const checkImageExistsDetailed = vi.fn();

class GitHubProviderError extends Error {
  code: string;
  status?: number;
  nonFastForward?: boolean;
  constructor(code: string, message: string, status?: number, retryAt?: string, endpoint?: string, nonFastForward?: boolean) {
    super(message);
    this.code = code;
    this.status = status;
    this.nonFastForward = nonFastForward;
  }
}

vi.mock("@dcc/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dcc/domain")>();
  class PullRequestMergeError extends Error {
    code: string;
    constructor(message: string, code = "merge_failed") { super(message); this.code = code; }
  }
  return {
    ...actual,
    syncOpenPullRequests, syncPullRequest, importGithubPullRequests, approveAndMergePullRequest, PullRequestMergeError,
    checkProductionHealth, evaluatePromotionEligibility,
  };
});
vi.mock("@dcc/github-provider", () => ({
  mergeBranch, createPullRequest, findOpenPullRequestForHead,
  getBranchHeadCommit, getCommitCheckStatus, getPullRequestsForCommit, updateBranchReference, getPendingDeployments, checkImageExists,
  findWorkflowRun, getWorkflowRunJobs, compareCommits, checkImageExistsDetailed, GitHubProviderError,
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

const actionsDeploymentConfig = {
  enabled: true,
  mechanism: "github_actions_jobs" as const,
  production_branch: "production",
  image: { registry: "ghcr.io", repository: "dutchbase/va-jobs-platform", tag_template: "sha-{{commit}}" },
  promotion: { require_e2e_gate_label: false },
  actions: { docker_image_job_name: "docker-image", migrations_job_name: "migrations-production", deploy_job_name: "deploy-production" },
};

const project = {
  id: "project-va",
  slug: "va-jobs-platform",
  github_owner: "dutchbase",
  github_repository: "va-jobs-platform",
  default_branch: "master",
  repository_path: "/PLACEHOLDER/set-a-real-local-clone-path-for-va-jobs-platform",
  config_json: { deployment: actionsDeploymentConfig },
};

const masterRun = {
  id: 111, name: "CI", headBranch: "master", headSha: "a".repeat(40), event: "push",
  status: "completed", conclusion: "success", createdAt: "2026-01-01T00:00:00Z", htmlUrl: "https://x/111",
};

function setUpHappyActionsStatus() {
  getBranchHeadCommit.mockImplementation(async (_owner: string, _repo: string, branch: string) => {
    if (branch === "master") return { sha: "a".repeat(40), committedAt: "2026-01-01T00:00:00Z", message: "ready" };
    if (branch === "production") return { sha: "b".repeat(40), committedAt: "2025-12-01T00:00:00Z", message: "old" };
    throw new Error(`unexpected branch ${branch}`);
  });
  findWorkflowRun.mockResolvedValue(masterRun);
  getWorkflowRunJobs.mockResolvedValue([{ name: "docker-image", status: "completed", conclusion: "success", htmlUrl: "https://x/job" }]);
  checkImageExistsDetailed.mockResolvedValue({ state: "exists", digest: "sha256:abc" });
  compareCommits.mockResolvedValue({ status: "ahead", aheadBy: 1, behindBy: 0 });
}

test("sync_status (github_actions_jobs mechanism) persists master workflow run id, docker-image job conclusion, and divergence", async () => {
  const database = db([project]);
  database.query.mockImplementation(async (text: string, values?: unknown[]) => {
    database.queries.push({ text, values });
    return { rows: [project], rowCount: 1 };
  });
  setUpHappyActionsStatus();

  await runProviderJob({
    id: "job-sync-1", type: "deployment.sync_status",
    idempotency_key: "g07:deployment.sync_status:project-va:once",
    payload_json: { actor_id: "admin-1", project_id: "project-va" },
  } as any, database as any);

  const snapshotUpsert = database.queries.find((q) => q.text.includes("deployment_status_snapshots"));
  expect(snapshotUpsert).toBeDefined();
  expect(snapshotUpsert!.values).toEqual([
    "project-va", "a".repeat(40), 111, "success", "success", true, "sha-" + "a".repeat(40), "b".repeat(40), "behind_master",
  ]);
  const resultUpdate = database.queries.find((q) => q.text.includes("result_json"));
  expect(resultUpdate!.values![1]).toMatchObject({ outcome: "synced", mechanism: "github_actions_jobs" });
});

test("promote_check (github_actions_jobs mechanism) reports ineligible with docker_image_job_missing when the job isn't in the run", async () => {
  const database = db([project]);
  setUpHappyActionsStatus();
  getWorkflowRunJobs.mockResolvedValue([{ name: "lint", status: "completed", conclusion: "success", htmlUrl: "https://x/job" }]);

  await runProviderJob({
    id: "job-check-1", type: "deployment.promote_check",
    idempotency_key: "g07:deployment.promote_check:project-va:once",
    payload_json: { actor_id: "admin-1", project_id: "project-va" },
  } as any, database as any);

  const resultUpdate = database.queries.find((q) => q.text.includes("result_json"));
  expect(resultUpdate!.values![1]).toMatchObject({ eligible: false, reasons: ["docker_image_job_missing"] });
});

test("promote_check ignores a GHCR failure — still eligible when Actions checks pass", async () => {
  const database = db([project]);
  setUpHappyActionsStatus();
  checkImageExistsDetailed.mockResolvedValue({ state: "unknown", reason: "rate limited" });

  await runProviderJob({
    id: "job-check-2", type: "deployment.promote_check",
    idempotency_key: "g07:deployment.promote_check:project-va:once2",
    payload_json: { actor_id: "admin-1", project_id: "project-va" },
  } as any, database as any);

  const resultUpdate = database.queries.find((q) => q.text.includes("result_json"));
  expect(resultUpdate!.values![1]).toMatchObject({ eligible: true });
});

test("promote (github_actions_jobs mechanism) refuses master_workflow_not_found when no run exists for the exact SHA/branch/event", async () => {
  const database = db([project]);
  const masterSha = "a".repeat(40);
  database.query.mockImplementation(async (text: string, values?: unknown[]) => {
    database.queries.push({ text, values });
    return { rows: [project], rowCount: 1 };
  });
  setUpHappyActionsStatus();
  findWorkflowRun.mockResolvedValue(null);

  await runProviderJob({
    id: "job-promote-1", type: "deployment.promote",
    idempotency_key: "g07:deployment.promote:project-va:once",
    payload_json: { actor_id: "admin-1", project_id: "project-va", commit_sha: masterSha, expected_master_sha: masterSha },
  } as any, database as any);

  const resultUpdate = database.queries.find((q) => q.text.includes("result_json"));
  expect(resultUpdate!.values![1]).toMatchObject({ outcome: "refused", refusal_code: "not_eligible", reasons: ["master_workflow_not_found"] });
  expect(updateBranchReference).not.toHaveBeenCalled();
});

test("promote (github_actions_jobs mechanism) still enforces master_moved before checking Actions eligibility", async () => {
  const database = db([project]);
  getBranchHeadCommit.mockResolvedValue({ sha: "d".repeat(40), committedAt: "2026-01-01T00:00:00Z", message: "newer commit" });

  await runProviderJob({
    id: "job-promote-2", type: "deployment.promote",
    idempotency_key: "g07:deployment.promote:project-va:once2",
    payload_json: {
      actor_id: "admin-1", project_id: "project-va",
      commit_sha: "e".repeat(40), expected_master_sha: "f".repeat(40),
    },
  } as any, database as any);

  expect(findWorkflowRun).not.toHaveBeenCalled();
  expect(updateBranchReference).not.toHaveBeenCalled();
  const resultUpdate = database.queries.find((q) => q.text.includes("result_json"));
  expect(resultUpdate!.values![1]).toMatchObject({ outcome: "refused", refusal_code: "master_moved" });
});

test("promote classifies a non-fast-forward 422 and sets non_fast_forward:true without retrying", async () => {
  const database = db([project]);
  const masterSha = "a".repeat(40);
  database.query.mockImplementation(async (text: string, values?: unknown[]) => {
    database.queries.push({ text, values });
    if (text.includes("INSERT INTO production_releases")) return { rows: [{ id: "release-nff" }], rowCount: 1 };
    return { rows: [project], rowCount: 1 };
  });
  setUpHappyActionsStatus();
  // production already equals master.sha so the pre-write diverged-check is skipped,
  // and the PATCH itself is what fails as non-fast-forward.
  getBranchHeadCommit.mockImplementation(async (_o: string, _r: string, branch: string) => {
    if (branch === "master") return { sha: masterSha, committedAt: "2026-01-01T00:00:00Z", message: "ready" };
    if (branch === "production") return { sha: "c".repeat(40), committedAt: "2025-12-01T00:00:00Z", message: "old" };
    throw new Error("unexpected");
  });
  compareCommits.mockResolvedValue({ status: "diverged", aheadBy: 1, behindBy: 1 });
  updateBranchReference.mockRejectedValue(new GitHubProviderError("http_error", "not a fast forward", 422, undefined, undefined, true));

  await runProviderJob({
    id: "job-promote-3", type: "deployment.promote",
    idempotency_key: "g07:deployment.promote:project-va:once3",
    payload_json: { actor_id: "admin-1", project_id: "project-va", commit_sha: masterSha, expected_master_sha: masterSha, force: true },
  } as any, database as any);

  const failedUpdate = database.queries.find((q) => q.text.includes("non_fast_forward=$3"));
  expect(failedUpdate).toBeDefined();
  expect(failedUpdate!.values).toEqual(["release-nff", "not a fast forward", true, true]);
  const resultUpdates = database.queries.filter((q) => q.text.includes("result_json"));
  const resultUpdate = resultUpdates[resultUpdates.length - 1];
  expect(resultUpdate!.values![1]).toMatchObject({ outcome: "refused", refusal_code: "non_fast_forward" });
});

test("promote re-reads the production ref after a successful PATCH and fails the release if it doesn't match", async () => {
  const database = db([project]);
  const masterSha = "a".repeat(40);
  database.query.mockImplementation(async (text: string, values?: unknown[]) => {
    database.queries.push({ text, values });
    if (text.includes("INSERT INTO production_releases")) return { rows: [{ id: "release-verify" }], rowCount: 1 };
    return { rows: [project], rowCount: 1 };
  });
  setUpHappyActionsStatus();
  let productionCallCount = 0;
  getBranchHeadCommit.mockImplementation(async (_o: string, _r: string, branch: string) => {
    if (branch === "master") return { sha: masterSha, committedAt: "2026-01-01T00:00:00Z", message: "ready" };
    if (branch === "production") {
      productionCallCount += 1;
      // first read (pre-flight/previousSha): behind master; post-write
      // verification read: returns a DIFFERENT sha than what was written.
      return { sha: productionCallCount === 1 ? "c".repeat(40) : "9".repeat(40), committedAt: "2025-12-01T00:00:00Z", message: "old" };
    }
    throw new Error("unexpected");
  });
  updateBranchReference.mockResolvedValue({ sha: masterSha });

  await runProviderJob({
    id: "job-promote-4", type: "deployment.promote",
    idempotency_key: "g07:deployment.promote:project-va:once4",
    payload_json: { actor_id: "admin-1", project_id: "project-va", commit_sha: masterSha, expected_master_sha: masterSha },
  } as any, database as any);

  const failedUpdate = database.queries.find((q) => q.text.includes("ref_verify_failed"));
  expect(failedUpdate).toBeDefined();
  const resultUpdates = database.queries.filter((q) => q.text.includes("result_json"));
  const resultUpdate = resultUpdates[resultUpdates.length - 1];
  expect(resultUpdate!.values![1]).toMatchObject({ outcome: "failed", refusal_code: "ref_verify_failed" });
});

test("promote with force:true is refused when the project is not on the allowlist's allowForce set", async () => {
  const database = db([project]);
  const otherProject = { ...project, id: "project-other", slug: "some-other-project" };
  database.query.mockImplementation(async (text: string, values?: unknown[]) => {
    database.queries.push({ text, values });
    return { rows: [otherProject], rowCount: 1 };
  });
  getBranchHeadCommit.mockResolvedValue({ sha: "a".repeat(40), committedAt: "2026-01-01T00:00:00Z", message: "ready" });

  await runProviderJob({
    id: "job-promote-5", type: "deployment.promote",
    idempotency_key: "g07:deployment.promote:project-other:once",
    payload_json: {
      actor_id: "admin-1", project_id: "project-other",
      commit_sha: "a".repeat(40), expected_master_sha: "a".repeat(40), force: true,
    },
  } as any, database as any);

  expect(updateBranchReference).not.toHaveBeenCalled();
  const resultUpdate = database.queries.find((q) => q.text.includes("result_json"));
  expect(resultUpdate!.values![1]).toMatchObject({ outcome: "refused", refusal_code: "force_not_allowed" });
});

test("promote with force:true still requires commit_sha === fresh master sha", async () => {
  const database = db([project]);
  const masterSha = "5".repeat(40);
  getBranchHeadCommit.mockResolvedValue({ sha: masterSha, committedAt: "2026-01-01T00:00:00Z", message: "ready" });

  await runProviderJob({
    id: "job-promote-6", type: "deployment.promote",
    idempotency_key: "g07:deployment.promote:project-va:once6",
    payload_json: {
      actor_id: "admin-1", project_id: "project-va",
      commit_sha: "6".repeat(40), expected_master_sha: masterSha, force: true,
    },
  } as any, database as any);

  expect(updateBranchReference).not.toHaveBeenCalled();
  const resultUpdate = database.queries.find((q) => q.text.includes("result_json"));
  expect(resultUpdate!.values![1]).toMatchObject({ outcome: "refused", refusal_code: "commit_not_master" });
});
