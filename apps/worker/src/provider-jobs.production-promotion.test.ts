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
    // No release is in flight — route the production_releases lookup to an
    // empty result so this test only exercises the base snapshot-write path
    // (Task 8b's production-run-tracking columns stay null).
    if (text.includes("FROM production_releases")) return { rows: [], rowCount: 0 };
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
    null, null, null, null,
  ]);
  expect(findWorkflowRun).toHaveBeenCalledTimes(1); // only the master-branch lookup — no release to anchor a production-branch lookup
  const resultUpdate = database.queries.find((q) => q.text.includes("result_json"));
  expect(resultUpdate!.values![1]).toMatchObject({ outcome: "synced", mechanism: "github_actions_jobs" });
});

test("sync_status (github_actions_jobs mechanism) tracks the production-branch run's migrations/deploy jobs distinctly from the master run at the same SHA", async () => {
  const database = db([project]);
  const masterSha = "a".repeat(40);
  const release = { id: "release-inflight", commit_sha: masterSha, status: "pending_approval", created_at: "2026-01-02T00:00:00Z", updated_at: new Date(Date.now() - 60_000).toISOString() };
  database.query.mockImplementation(async (text: string, values?: unknown[]) => {
    database.queries.push({ text, values });
    if (text.includes("FROM production_releases")) return { rows: [release], rowCount: 1 };
    return { rows: [project], rowCount: 1 };
  });
  setUpHappyActionsStatus();
  const productionRun = { id: 222, name: "CD", headBranch: "production", headSha: masterSha, event: "push", status: "in_progress", conclusion: null, createdAt: "2026-01-02T00:01:00Z", htmlUrl: "https://x/222" };
  findWorkflowRun.mockImplementation(async (_owner: string, _repo: string, filter: { branch: string; createdAfter?: string }) => {
    if (filter.branch === "master") return masterRun;
    if (filter.branch === "production") {
      expect(filter.createdAfter).toBe(release.created_at);
      return productionRun;
    }
    throw new Error(`unexpected branch ${filter.branch}`);
  });
  getWorkflowRunJobs.mockImplementation(async (_owner: string, _repo: string, runId: number) => {
    if (runId === masterRun.id) return [{ name: "docker-image", status: "completed", conclusion: "success", htmlUrl: "https://x/job" }];
    if (runId === productionRun.id) return [
      { name: "migrations-production", status: "completed", conclusion: "success", htmlUrl: "https://x/mj" },
      { name: "deploy-production", status: "in_progress", conclusion: null, htmlUrl: "https://x/dj" },
    ];
    throw new Error(`unexpected run ${runId}`);
  });

  await runProviderJob({
    id: "job-sync-2", type: "deployment.sync_status",
    idempotency_key: "g07:deployment.sync_status:project-va:once2",
    payload_json: { actor_id: "admin-1", project_id: "project-va" },
  } as any, database as any);

  const snapshotUpsert = database.queries.find((q) => q.text.includes("deployment_status_snapshots"));
  expect(snapshotUpsert!.values).toEqual([
    "project-va", masterSha, masterRun.id, "success", "success", true, "sha-" + masterSha, "b".repeat(40), "behind_master",
    productionRun.id, null, "success", null,
  ]);
  const releaseUpdate = database.queries.find((q) => q.text.includes("UPDATE production_releases") && q.text.includes("health_checked_at"));
  expect(releaseUpdate).toBeDefined();
  expect(releaseUpdate!.values).toEqual(["release-inflight", "deploying", productionRun.id]);
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

// The projects row is admin-editable (PATCH /api/admin/projects/:id allows
// github_owner, github_repository, default_branch and config_json), so these
// cover the allowlist entry — not the row — being the source of truth for
// which repository and branches a promotion may ever move a ref on.
test("promote refuses with allowlist_mismatch when the project row's github_repository was tampered with", async () => {
  const database = db([project]);
  const masterSha = "a".repeat(40);
  const tampered = { ...project, github_repository: "some-other-repo" };
  database.query.mockImplementation(async (text: string, values?: unknown[]) => {
    database.queries.push({ text, values });
    return { rows: [tampered], rowCount: 1 };
  });
  setUpHappyActionsStatus();

  await runProviderJob({
    id: "job-promote-7", type: "deployment.promote",
    idempotency_key: "g07:deployment.promote:project-va:once7",
    payload_json: { actor_id: "admin-1", project_id: "project-va", commit_sha: masterSha, expected_master_sha: masterSha },
  } as any, database as any);

  const resultUpdate = database.queries.find((q) => q.text.includes("result_json"));
  expect(resultUpdate!.values![1]).toMatchObject({ outcome: "refused", refusal_code: "allowlist_mismatch", mismatched_fields: ["github_repository"] });
  // Refused before any GitHub call is made against the tampered values.
  expect(getBranchHeadCommit).not.toHaveBeenCalled();
  expect(updateBranchReference).not.toHaveBeenCalled();
});

test("force promote refuses with allowlist_mismatch when production_branch was repointed away from the allowlisted target", async () => {
  const database = db([project]);
  const masterSha = "a".repeat(40);
  const tampered = {
    ...project,
    config_json: { deployment: { ...actionsDeploymentConfig, production_branch: "master" } },
  };
  database.query.mockImplementation(async (text: string, values?: unknown[]) => {
    database.queries.push({ text, values });
    return { rows: [tampered], rowCount: 1 };
  });
  setUpHappyActionsStatus();

  await runProviderJob({
    id: "job-promote-8", type: "deployment.promote",
    idempotency_key: "g07:deployment.promote:project-va:once8",
    payload_json: { actor_id: "admin-1", project_id: "project-va", commit_sha: masterSha, expected_master_sha: masterSha, force: true },
  } as any, database as any);

  const resultUpdate = database.queries.find((q) => q.text.includes("result_json"));
  expect(resultUpdate!.values![1]).toMatchObject({ outcome: "refused", refusal_code: "allowlist_mismatch", mismatched_fields: ["production_branch"] });
  expect(updateBranchReference).not.toHaveBeenCalled();
});

test("promote still proceeds when the project row matches its allowlist entry exactly", async () => {
  const database = db([project]);
  const masterSha = "a".repeat(40);
  database.query.mockImplementation(async (text: string, values?: unknown[]) => {
    database.queries.push({ text, values });
    if (text.includes("INSERT INTO production_releases")) return { rows: [{ id: "release-ok" }], rowCount: 1 };
    return { rows: [project], rowCount: 1 };
  });
  setUpHappyActionsStatus();
  updateBranchReference.mockResolvedValue({ sha: masterSha });
  let productionReads = 0;
  getBranchHeadCommit.mockImplementation(async (_o: string, _r: string, branch: string) => {
    if (branch === "master") return { sha: masterSha, committedAt: "2026-01-01T00:00:00Z", message: "ready" };
    if (branch === "production") {
      productionReads += 1;
      // pre-flight read: behind master; post-write verification read: the target.
      return { sha: productionReads === 1 ? "b".repeat(40) : masterSha, committedAt: "2025-12-01T00:00:00Z", message: "old" };
    }
    throw new Error("unexpected");
  });

  await runProviderJob({
    id: "job-promote-9", type: "deployment.promote",
    idempotency_key: "g07:deployment.promote:project-va:once9",
    payload_json: { actor_id: "admin-1", project_id: "project-va", commit_sha: masterSha, expected_master_sha: masterSha },
  } as any, database as any);

  expect(updateBranchReference).toHaveBeenCalledWith("dutchbase", "va-jobs-platform", "production", masterSha, false);
  const resultUpdates = database.queries.filter((q) => q.text.includes("result_json"));
  expect(resultUpdates[resultUpdates.length - 1]!.values![1]).toMatchObject({ outcome: "requested" });
});

test("sync_status reaps a release stuck at 'requested' instead of leaving it invisible in the single-flight slot", async () => {
  const database = db([project]);
  // A release that crashed between the INSERT and the post-PATCH status
  // update: still 'requested', still occupying
  // production_releases_project_inflight_idx, last touched 16 minutes ago.
  const stuck = {
    id: "release-stuck", commit_sha: "a".repeat(40), status: "requested",
    created_at: "2026-01-02T00:00:00Z", updated_at: new Date(Date.now() - 16 * 60 * 1000).toISOString(),
  };
  database.query.mockImplementation(async (text: string, values?: unknown[]) => {
    database.queries.push({ text, values });
    // Faithful to Postgres: the row only comes back if the handler's status
    // filter actually includes 'requested'.
    if (text.includes("FROM production_releases")) {
      return text.includes("'requested'") ? { rows: [stuck], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    return { rows: [project], rowCount: 1 };
  });
  setUpHappyActionsStatus();
  findWorkflowRun.mockImplementation(async (_owner: string, _repo: string, filter: { branch: string }) =>
    (filter.branch === "master" ? masterRun : null));

  await runProviderJob({
    id: "job-sync-3", type: "deployment.sync_status",
    idempotency_key: "g07:deployment.sync_status:project-va:once3",
    payload_json: { actor_id: "admin-1", project_id: "project-va" },
  } as any, database as any);

  const releaseUpdate = database.queries.find((q) => q.text.includes("UPDATE production_releases") && q.text.includes("health_checked_at"));
  expect(releaseUpdate).toBeDefined();
  expect(releaseUpdate!.text).toContain("stalled");
  // 'failed' is outside the partial unique index, so the slot is freed.
  expect(releaseUpdate!.values).toEqual(["release-stuck", "failed", null]);
});

test("rollback refuses cleanly for the github_actions_jobs mechanism instead of reading a nonexistent local clone", async () => {
  const database = db([project]);
  database.query.mockImplementation(async (text: string, values?: unknown[]) => {
    database.queries.push({ text, values });
    return { rows: [project], rowCount: 1 };
  });

  await runProviderJob({
    id: "job-rollback-1", type: "deployment.rollback",
    idempotency_key: "g07:deployment.rollback:project-va:once",
    payload_json: {
      actor_id: "admin-1", project_id: "project-va",
      target_commit_sha: "b".repeat(40), expected_production_sha: "a".repeat(40),
    },
  } as any, database as any);

  const resultUpdate = database.queries.find((q) => q.text.includes("result_json"));
  expect(resultUpdate!.values![1]).toMatchObject({ outcome: "refused", refusal_code: "rollback_unsupported_for_mechanism" });
  expect(lsRemoteHeads).not.toHaveBeenCalled();
  expect(checkImageExists).not.toHaveBeenCalled();
  expect(updateBranchReference).not.toHaveBeenCalled();
});
