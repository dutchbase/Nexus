import type pg from "pg";
import {
  approveAndMergePullRequest, importGithubPullRequests, PullRequestMergeError, syncOpenPullRequests, syncPullRequest,
  checkProductionHealth, evaluatePromotionEligibility,
  evaluateActionsPreflight, computeDivergence, findAllowlistEntry,
} from "@dcc/domain";
import {
  createPullRequest, findOpenPullRequestForHead, mergeBranch,
  getBranchHeadCommit, getCommitCheckStatus, getPullRequestsForCommit, updateBranchReference, getPendingDeployments, checkImageExists,
  findWorkflowRun, getWorkflowRunJobs, compareCommits, checkImageExistsDetailed, GitHubProviderError,
} from "@dcc/github-provider";
import type { DeploymentConfig } from "@dcc/project-config";
import { assertRemoteBranchName, lsRemoteHeads, previewRemoteBranchMerge } from "../../../packages/git-runner/src/index.ts";

export const providerJobTypes = [
  "github.sync_open",
  "github.sync_one",
  "github.import",
  "github.merge_pull_request",
  "github.merge_branches",
  "github.merge_preview",
  "github.open_pull_request",
  "deployment.sync_status",
  "deployment.promote_check",
  "deployment.promote",
  "deployment.rollback",
] as const;

type ProviderJobType = typeof providerJobTypes[number];
type ProviderJob = {
  id: string;
  type: ProviderJobType;
  idempotency_key: string;
  payload_json: Record<string, unknown>;
};
type Database = Pick<pg.Pool, "query">;

function required(payload: Record<string, unknown>, key: string) {
  const value = payload[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(key + " is required");
  return value.trim();
}

async function audit(
  db: Database,
  job: ProviderJob,
  actorId: string | null,
  action: string,
  entityType: string,
  entityId: string | null,
  metadata: Record<string, unknown>,
) {
  await db.query(
    "INSERT INTO audit_events (actor_type,actor_id,action,entity_type,entity_id,metadata_json) VALUES ($1,$2,$3,$4,$5,$6)",
    ["admin", actorId, action, entityType, entityId, {
      job_id: job.id, idempotency_key: job.idempotency_key, ...metadata,
    }],
  );
}

async function fetchLiveDeploymentStatus(project: any, deployment: DeploymentConfig) {
  const master = await getBranchHeadCommit(project.github_owner, project.github_repository, project.default_branch);
  const ciStatus = await getCommitCheckStatus(project.github_owner, project.github_repository, master.sha);
  let e2eGateSatisfied = true;
  let e2eGatePrNumber: number | null = null;
  if (deployment.promotion.require_e2e_gate_label) {
    const prs = await getPullRequestsForCommit(project.github_owner, project.github_repository, master.sha);
    const mergedPr = prs.find((pr) => pr.merged);
    e2eGateSatisfied = mergedPr ? mergedPr.labels.includes(deployment.promotion.e2e_gate_label ?? "") : false;
    e2eGatePrNumber = mergedPr?.number ?? null;
  }
  const imageTag = deployment.image.tag_template.replace("{{commit}}", master.sha);
  const image = await checkImageExists(deployment.image.registry, deployment.image.repository, imageTag);
  // fetchLiveDeploymentStatus is only ever called on the "health_check" mechanism
  // path (see the mechanism branch below) — validateDeploymentConfig requires
  // `health` whenever mechanism is "health_check" (or absent), so it's always
  // present here even though the type now allows it to be omitted under the
  // "github_actions_jobs" mechanism.
  const health = await checkProductionHealth(deployment.health!);
  return { master, ciStatus, e2eGateSatisfied, e2eGatePrNumber, imageTag, image, health };
}

// Sibling of fetchLiveDeploymentStatus for the "github_actions_jobs"
// mechanism — used only when deployment.mechanism === "github_actions_jobs".
// fetchLiveDeploymentStatus above is untouched and still serves every other
// (health_check-mechanism) project.
async function fetchActionsPreflightStatus(project: any, deployment: DeploymentConfig) {
  const master = await getBranchHeadCommit(project.github_owner, project.github_repository, project.default_branch);
  const masterRun = await findWorkflowRun(project.github_owner, project.github_repository, {
    sha: master.sha, branch: project.default_branch, event: "push",
  });
  const masterJobs = masterRun ? await getWorkflowRunJobs(project.github_owner, project.github_repository, masterRun.id) : [];
  const imageTag = deployment.image.tag_template.replace("{{commit}}", master.sha);
  const ghcr = await checkImageExistsDetailed(deployment.image.registry, deployment.image.repository, imageTag);
  const preflight = evaluateActionsPreflight({
    masterWorkflowRun: masterRun, masterWorkflowJobs: masterJobs,
    dockerImageJobName: deployment.actions!.docker_image_job_name, ghcr,
  });
  // Production SHA read live from the API — NOT lsRemoteHeads(project.repository_path) —
  // so this mechanism has no dependency on a local git clone existing on disk,
  // matching the task's explicit GET .../git/ref/heads/{branch} spec.
  const production = await getBranchHeadCommit(project.github_owner, project.github_repository, deployment.production_branch).catch(() => null);
  const comparison = production ? await compareCommits(project.github_owner, project.github_repository, deployment.production_branch, project.default_branch).catch(() => null) : null;
  return { master, masterRun, masterJobs, imageTag, ghcr, preflight, production, divergence: computeDivergence(comparison) };
}

function loadDeploymentConfig(project: any): DeploymentConfig {
  const deployment = project.config_json?.deployment;
  if (!deployment?.enabled) throw new Error("project has no deployment configuration enabled");
  return deployment;
}

export async function runProviderJob(
  job: ProviderJob,
  db: Database,
  assertOwned: () => Promise<void> = async () => {},
): Promise<void> {
  // Worker-originated jobs (auto-merge after an approved AI review) have no
  // admin actor; audit rows keep actor_id NULL for them.
  const rawActorId = job.payload_json.actor_id;
  const actorId = typeof rawActorId === "string" && rawActorId.trim() ? rawActorId.trim() : null;

  if (job.type === "github.sync_open") {
    await assertOwned();
    await syncOpenPullRequests(assertOwned);
    await assertOwned();
    await audit(db, job, actorId, "github.sync_open", "pull_request", null, {});
    return;
  }

  if (job.type === "github.sync_one") {
    const pullRequestId = required(job.payload_json, "pull_request_id");
    await assertOwned();
    await syncPullRequest(pullRequestId, "admin", actorId ?? undefined, assertOwned);
    await assertOwned();
    await audit(db, job, actorId, "github.sync_one", "pull_request", pullRequestId, {});
    return;
  }

  if (job.type === "github.import") {
    const projectId = typeof job.payload_json.project_id === "string" && job.payload_json.project_id.trim()
      ? job.payload_json.project_id.trim() : undefined;
    const projects = (await db.query(
      projectId
        ? "SELECT * FROM projects WHERE id=$1 AND github_owner IS NOT NULL AND github_repository IS NOT NULL"
        : "SELECT * FROM projects WHERE github_owner IS NOT NULL AND github_repository IS NOT NULL",
      projectId ? [projectId] : [],
    )).rows;
    if (projectId && !projects[0]) throw new Error("project not found or has no GitHub repository configured");
    let imported = 0;
    for (const project of projects) {
      await assertOwned();
      imported += (await importGithubPullRequests(db as pg.Pool, project, assertOwned)).imported;
    }
    await assertOwned();
    await audit(db, job, actorId, "github.import", "project", projectId ?? null, { imported });
    return;
  }

  if (job.type === "github.merge_pull_request") {
    const pullRequestId = required(job.payload_json, "pull_request_id");
    const expectedHeadSha = required(job.payload_json, "expected_head_sha");
    const expectedPolicySnapshotId = typeof job.payload_json.policy_snapshot_id === "string" && job.payload_json.policy_snapshot_id.trim()
      ? job.payload_json.policy_snapshot_id.trim() : undefined;
    await assertOwned();
    try {
      const mergeResult = await approveAndMergePullRequest(
        db as pg.Pool,
        {
          pullRequestId, jobId: job.id, actor: { type: "admin", id: actorId },
          expectedHeadSha, expectedPolicySnapshotId,
        },
        assertOwned,
      );
      await persistJobResult(db, job.id, { outcome: "merged", ...(mergeResult ?? {}) });
      await audit(db, job, actorId, "github.merge_pull_request", "pull_request", pullRequestId, {
        expected_head_sha: expectedHeadSha,
        ...(mergeResult?.mergedSha ? { merged_sha: mergeResult.mergedSha } : {}),
        ...(expectedPolicySnapshotId ? { policy_snapshot_id: expectedPolicySnapshotId } : {}),
      });
    } catch (error) {
      const code = error instanceof PullRequestMergeError ? error.code : undefined;
      if (code) await persistJobResult(db, job.id, { outcome: "refused", refusal_code: code });
      throw error;
    }
    return;
  }

  if (job.type === "github.merge_branches") {
    const projectId = required(job.payload_json, "project_id");
    const head = required(job.payload_json, "head");
    const base = required(job.payload_json, "base");
    await assertRemoteBranchName(head);
    await assertRemoteBranchName(base);
    const project = (await db.query("SELECT * FROM projects WHERE id=$1", [projectId])).rows[0];
    if (!project?.github_owner || !project.github_repository) throw new Error("project has no GitHub repository configured");

    // Compare-and-swap: refuse when either ref moved since the preview the
    // user based their decision on. A stale pair merges something they never saw.
    if (typeof job.payload_json.expected_head_sha === "string"
      || typeof job.payload_json.expected_base_sha === "string") {
      await assertOwned();
      const heads = await lsRemoteHeads(project.repository_path);
      const liveHead = typeof job.payload_json.expected_head_sha === "string" ? heads.get(head) : undefined;
      const liveBase = typeof job.payload_json.expected_base_sha === "string" ? heads.get(base) : undefined;
      if ((liveHead && liveHead !== job.payload_json.expected_head_sha)
        || (liveBase && liveBase !== job.payload_json.expected_base_sha)) {
        await persistJobResult(db, job.id, { outcome: "refused", refusal_code: "refs_changed",
          message: "A branch moved since the pre-flight check — re-check before merging." });
        await audit(db, job, actorId, "project.merge_branches", "project", projectId,
          { head, base, outcome: "refused", refusal_code: "refs_changed" });
        return;
      }
    }

    await assertOwned();
    try {
      const result = await mergeBranch(project.github_owner, project.github_repository, base, head);
      await assertOwned();
      await persistJobResult(db, job.id, { outcome: result.outcome, ...("sha" in result ? { sha: result.sha } : {}) });
      await audit(db, job, actorId, "project.merge_branches", "project", projectId, {
        head, base, outcome: result.outcome, ...("sha" in result ? { sha: result.sha } : {}),
      });
    } catch (error) {
      await persistJobResult(db, job.id, { outcome: "failed", error: error instanceof Error ? error.message : String(error) }).catch(() => {});
      throw error;
    }
    return;
  }

  if (job.type === "github.merge_preview") {
    // Read-only pre-flight powering the merge workbench. Cheap enough to run
    // freely; results land in jobs.result_json for the UI to poll.
    const projectId = required(job.payload_json, "project_id");
    const head = typeof job.payload_json.head === "string" && job.payload_json.head.trim() ? job.payload_json.head.trim() : undefined;
    const base = typeof job.payload_json.base === "string" && job.payload_json.base.trim() ? job.payload_json.base.trim() : undefined;
    if (head) await assertRemoteBranchName(head);
    if (base) await assertRemoteBranchName(base);
    const project = (await db.query("SELECT * FROM projects WHERE id=$1", [projectId])).rows[0];
    if (!project?.repository_path) throw new Error("project has no local repository configured");
    await assertOwned();
    const preview = await previewRemoteBranchMerge({ repositoryPath: project.repository_path, head, base });
    await assertOwned();
    await persistJobResult(db, job.id, { ...preview, generated_at: new Date().toISOString() });
    return;
  }

  if (job.type === "github.open_pull_request") {
    // Non-destructive sibling of merge_branches: open a pull request for the
    // head→base pair instead of merging immediately. Opening is safe even
    // with conflicts or missing reviews — GitHub itself flags those — so the
    // only precondition is that both refs exist (verified by GitHub on
    // creation). A pre-existing open PR for the head is linked, not duplicated.
    const projectId = required(job.payload_json, "project_id");
    const head = required(job.payload_json, "head");
    const base = required(job.payload_json, "base");
    await assertRemoteBranchName(head);
    await assertRemoteBranchName(base);
    const project = (await db.query("SELECT * FROM projects WHERE id=$1", [projectId])).rows[0];
    if (!project?.github_owner || !project.github_repository) throw new Error("project has no GitHub repository configured");
    await assertOwned();
    const existing = await findOpenPullRequestForHead(project.github_owner, project.github_repository, head);
    if (existing) {
      await persistJobResult(db, job.id, { outcome: "already_open", number: existing.number, url: existing.html_url });
      await audit(db, job, actorId, "project.open_pull_request", "project", projectId, { head, base, outcome: "already_open", number: existing.number });
      return;
    }
    const title = typeof job.payload_json.title === "string" && job.payload_json.title.trim()
      ? job.payload_json.title.trim().slice(0, 200) : `${head} → ${base}`;
    const bodyText = typeof job.payload_json.body === "string" && job.payload_json.body.trim()
      ? job.payload_json.body.trim().slice(0, 10000)
      : `Opened from the Dev Control merge workbench to merge \`${head}\` into \`${base}\`.`;
    try {
      const created = await createPullRequest({ owner: project.github_owner, repository: project.github_repository, title, body: bodyText, head, base });
      await assertOwned();
      await persistJobResult(db, job.id, { outcome: "created", number: created.number, url: created.html_url, title });
      await audit(db, job, actorId, "project.open_pull_request", "project", projectId, { head, base, outcome: "created", number: created.number, url: created.html_url });
    } catch (error) {
      await persistJobResult(db, job.id, { outcome: "failed", error: error instanceof Error ? error.message : String(error) }).catch(() => {});
      throw error;
    }
    return;
  }

  if (job.type === "deployment.sync_status") {
    const projectId = required(job.payload_json, "project_id");
    const project = (await db.query("SELECT * FROM projects WHERE id=$1", [projectId])).rows[0];
    if (!project) throw new Error("project not found");
    const deployment = loadDeploymentConfig(project);
    await assertOwned();
    if (deployment.mechanism === "github_actions_jobs") {
      const actionsStatus = await fetchActionsPreflightStatus(project, deployment);
      const recentRelease = (await db.query(
        `SELECT * FROM production_releases WHERE project_id=$1 AND action='promote' AND status IN ('pending_approval','deploying','healthy') ORDER BY created_at DESC LIMIT 1`,
        [projectId],
      )).rows[0];
      let productionRun: Awaited<ReturnType<typeof findWorkflowRun>> = null;
      let productionJobs: Awaited<ReturnType<typeof getWorkflowRunJobs>> = [];
      if (recentRelease) {
        productionRun = await findWorkflowRun(project.github_owner, project.github_repository, {
          sha: recentRelease.commit_sha, branch: deployment.production_branch, event: "push", createdAfter: recentRelease.created_at,
        });
        if (productionRun) productionJobs = await getWorkflowRunJobs(project.github_owner, project.github_repository, productionRun.id);
      }
      const migrationsJob = productionJobs.find((j) => j.name === deployment.actions!.migrations_job_name);
      const deployJob = productionJobs.find((j) => j.name === deployment.actions!.deploy_job_name);
      await db.query(
        `INSERT INTO deployment_status_snapshots (project_id, master_commit_sha, master_workflow_run_id, master_workflow_conclusion, docker_image_job_conclusion, ghcr_checked, ghcr_verified, image_tag, production_commit_sha, divergence, production_workflow_run_id, production_workflow_conclusion, migrations_job_conclusion, deploy_job_conclusion, fetched_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,true,$6,$7,$8,$9,$10,$11,$12,$13,now(),now())
         ON CONFLICT (project_id) DO UPDATE SET master_commit_sha=$2, master_workflow_run_id=$3, master_workflow_conclusion=$4, docker_image_job_conclusion=$5, ghcr_checked=true, ghcr_verified=$6, image_tag=$7, production_commit_sha=$8, divergence=$9, production_workflow_run_id=$10, production_workflow_conclusion=$11, migrations_job_conclusion=$12, deploy_job_conclusion=$13, fetched_at=now(), updated_at=now()`,
        [projectId, actionsStatus.master.sha, actionsStatus.masterRun?.id ?? null, actionsStatus.masterRun?.conclusion ?? null,
         actionsStatus.preflight.dockerImageJobConclusion, actionsStatus.ghcr.state === "exists" ? true : actionsStatus.ghcr.state === "not_exists" ? false : null,
         actionsStatus.imageTag, actionsStatus.production?.sha ?? null, actionsStatus.divergence,
         productionRun?.id ?? null, productionRun?.conclusion ?? null, migrationsJob?.conclusion ?? null, deployJob?.conclusion ?? null],
      );
      // Reuse the existing in-flight release status machinery (above, in the
      // health_check branch) but drive "deploying"/"healthy"/"failed" from the
      // two named job conclusions instead of an HTTP health check.
      if (recentRelease && recentRelease.status !== "healthy") {
        const bothSucceeded = migrationsJob?.conclusion === "success" && deployJob?.conclusion === "success";
        const eitherFailed = migrationsJob?.conclusion === "failure" || deployJob?.conclusion === "failure" || migrationsJob?.conclusion === "cancelled" || deployJob?.conclusion === "cancelled";
        const stalled = !bothSucceeded && !eitherFailed && Date.now() - new Date(recentRelease.updated_at).getTime() > 15 * 60 * 1000;
        const nextStatus = bothSucceeded ? "healthy" : eitherFailed ? "failed" : stalled ? "failed" : "deploying";
        await db.query(
          `UPDATE production_releases SET status=$2, production_workflow_run_id=$3, health_checked_at=now(), updated_at=now()${stalled ? ",failure_reason='stalled — production workflow jobs did not resolve within 15 minutes'" : eitherFailed ? ",failure_reason='migrations-production or deploy-production job failed'" : ""} WHERE id=$1`,
          [recentRelease.id, nextStatus, productionRun?.id ?? null],
        );
      }
      await persistJobResult(db, job.id, { outcome: "synced", mechanism: "github_actions_jobs", ...actionsStatus, production_run: productionRun, migrations_job_conclusion: migrationsJob?.conclusion ?? null, deploy_job_conclusion: deployJob?.conclusion ?? null });
      return;
    }
    const live = await fetchLiveDeploymentStatus(project, deployment);
    await assertOwned();
    let releaseUpdate: { status: string } | null = null;
    const inFlight = (await db.query(
      `SELECT * FROM production_releases WHERE project_id=$1 AND status IN ('requested','pending_approval','deploying') ORDER BY created_at DESC LIMIT 1`,
      [projectId],
    )).rows[0];
    if (inFlight) {
      const pending = await getPendingDeployments(project.github_owner, project.github_repository, inFlight.commit_sha);
      const waitingApproval = pending.some((p) => p.waiting);
      const nowLive = live.health.commit_sha === inFlight.commit_sha && live.health.healthy;
      // An in-flight release (requested/pending_approval/deploying) that never
      // resolves to healthy within 15 minutes is stuck — mark it failed so it
      // stops occupying the single-flight slot for this project.
      const stalled = !nowLive && Date.now() - new Date(inFlight.updated_at).getTime() > 15 * 60 * 1000;
      const nextStatus = nowLive ? "healthy" : stalled ? "failed" : waitingApproval ? "pending_approval" : "deploying";
      await db.query(
        `UPDATE production_releases SET status=$2, health_checked_at=now(), health_detail_json=$3, updated_at=now()${stalled ? ", failure_reason=$4" : ""} WHERE id=$1`,
        stalled
          ? [inFlight.id, nextStatus, JSON.stringify(live.health), "stalled — no resolution within 15 minutes"]
          : [inFlight.id, nextStatus, JSON.stringify(live.health)],
      );
      releaseUpdate = { status: nextStatus };
    }
    // production_commit_sha has a DB CHECK constraint requiring a 40-char hex
    // SHA. A project's configured version_field can yield anything (short
    // SHA, semver, garbage) — normalize to null rather than let a
    // non-matching value throw a constraint violation and fail the whole sync.
    const normalizedProductionSha = live.health.commit_sha && /^[0-9a-f]{40}$/i.test(live.health.commit_sha)
      ? live.health.commit_sha.toLowerCase() : null;
    await db.query(
      `INSERT INTO deployment_status_snapshots (project_id, master_commit_sha, master_ci_state, master_ci_checked_at, e2e_gate_satisfied, e2e_gate_pr_number, image_tag, image_exists, image_checked_at, production_commit_sha, production_health, production_version_raw, production_checked_at, fetched_at, updated_at)
       VALUES ($1,$2,$3,now(),$4,$5,$6,$7,now(),$8,$9,$10,now(),now(),now())
       ON CONFLICT (project_id) DO UPDATE SET master_commit_sha=$2, master_ci_state=$3, master_ci_checked_at=now(), e2e_gate_satisfied=$4, e2e_gate_pr_number=$5, image_tag=$6, image_exists=$7, image_checked_at=now(), production_commit_sha=$8, production_health=$9, production_version_raw=$10, production_checked_at=now(), fetched_at=now(), updated_at=now()`,
      [projectId, live.master.sha, live.ciStatus.overallState === "none" ? "none" : live.ciStatus.overallState, live.e2eGateSatisfied, live.e2eGatePrNumber, live.imageTag, live.image.exists, normalizedProductionSha, live.health.state === "healthy" ? "healthy" : live.health.state, JSON.stringify(live.health.raw)],
    );
    await persistJobResult(db, job.id, { outcome: "synced", ...live, release: releaseUpdate });
    return;
  }

  if (job.type === "deployment.promote_check") {
    const projectId = required(job.payload_json, "project_id");
    const project = (await db.query("SELECT * FROM projects WHERE id=$1", [projectId])).rows[0];
    if (!project) throw new Error("project not found");
    const deployment = loadDeploymentConfig(project);
    await assertOwned();
    if (deployment.mechanism === "github_actions_jobs") {
      const actionsStatus = await fetchActionsPreflightStatus(project, deployment);
      await persistJobResult(db, job.id, {
        eligible: actionsStatus.preflight.eligible, reasons: actionsStatus.preflight.reasons,
        master_sha: actionsStatus.master.sha, master_commit_message: actionsStatus.master.message,
        image_tag: actionsStatus.imageTag, production_current_sha: actionsStatus.production?.sha ?? null,
        divergence: actionsStatus.divergence, master_workflow_run_url: actionsStatus.masterRun ? `https://github.com/${project.github_owner}/${project.github_repository}/actions/runs/${actionsStatus.masterRun.id}` : null,
      });
      return;
    }
    const live = await fetchLiveDeploymentStatus(project, deployment);
    const productionHeads = await lsRemoteHeads(project.repository_path);
    const eligibility = evaluatePromotionEligibility({
      ciState: live.ciStatus.overallState, imageExists: live.image.exists,
      e2eGateRequired: deployment.promotion.require_e2e_gate_label, e2eGateSatisfied: live.e2eGateSatisfied,
    });
    await persistJobResult(db, job.id, {
      eligible: eligibility.eligible, reasons: eligibility.reasons,
      master_sha: live.master.sha, master_commit_message: live.master.message,
      image_tag: live.imageTag,
      production_current_sha: productionHeads.get(deployment.production_branch) ?? null,
    });
    return;
  }

  if (job.type === "deployment.promote") {
    const projectId = required(job.payload_json, "project_id");
    const commitSha = required(job.payload_json, "commit_sha");
    const expectedMasterSha = required(job.payload_json, "expected_master_sha");
    const project = (await db.query("SELECT * FROM projects WHERE id=$1", [projectId])).rows[0];
    if (!project) throw new Error("project not found");
    const deployment = loadDeploymentConfig(project);
    await assertOwned();
    const freshMaster = await getBranchHeadCommit(project.github_owner, project.github_repository, project.default_branch);
    if (freshMaster.sha !== expectedMasterSha) {
      await persistJobResult(db, job.id, { outcome: "refused", refusal_code: "master_moved", current_sha: freshMaster.sha });
      await audit(db, job, actorId, "deployment.promote", "project", projectId, { outcome: "refused", refusal_code: "master_moved" });
      return;
    }
    // commit_sha and expected_master_sha are independent caller-supplied values;
    // without this, a caller could pass a valid expected_master_sha alongside an
    // arbitrary commit_sha and promote a commit the eligibility check never gated.
    if (commitSha !== freshMaster.sha) {
      await persistJobResult(db, job.id, { outcome: "refused", refusal_code: "commit_not_master", expected: freshMaster.sha, received: commitSha });
      await audit(db, job, actorId, "deployment.promote", "project", projectId, { outcome: "refused", refusal_code: "commit_not_master" });
      return;
    }
    const forceRequested = job.payload_json.force === true;
    let eligibilityOk = true;
    let eligibilityReasons: string[] = [];
    let imageTag: string;
    let actionsStatus: Awaited<ReturnType<typeof fetchActionsPreflightStatus>> | undefined;
    if (deployment.mechanism === "github_actions_jobs") {
      const allowlistEntry = findAllowlistEntry(project.slug, project);
      if (forceRequested && !allowlistEntry?.allowForce) {
        await persistJobResult(db, job.id, { outcome: "refused", refusal_code: "force_not_allowed" });
        await audit(db, job, actorId, "deployment.promote", "project", projectId, { outcome: "refused", refusal_code: "force_not_allowed" });
        return;
      }
      actionsStatus = await fetchActionsPreflightStatus(project, deployment);
      eligibilityOk = actionsStatus.preflight.eligible;
      eligibilityReasons = actionsStatus.preflight.reasons;
      imageTag = actionsStatus.imageTag;
      if (!forceRequested && actionsStatus.production && actionsStatus.production.sha !== commitSha) {
        // Non-fast-forward is only expected/allowed via the explicit force path;
        // if production is diverged and force wasn't requested, refuse before
        // ever attempting the PATCH so the UI can show the recovery flow instead
        // of a generic ref_update_failed.
        const comparison = await compareCommits(project.github_owner, project.github_repository, deployment.production_branch, commitSha).catch(() => null);
        if (comparison?.status === "diverged") {
          await persistJobResult(db, job.id, { outcome: "refused", refusal_code: "diverged_confirmation_required", production_sha: actionsStatus.production.sha });
          await audit(db, job, actorId, "deployment.promote", "project", projectId, { outcome: "refused", refusal_code: "diverged_confirmation_required" });
          return;
        }
      }
    } else {
      const live = await fetchLiveDeploymentStatus(project, deployment); // existing path, unchanged
      const eligibility = evaluatePromotionEligibility({
        ciState: live.ciStatus.overallState, imageExists: live.image.exists,
        e2eGateRequired: deployment.promotion.require_e2e_gate_label, e2eGateSatisfied: live.e2eGateSatisfied,
      });
      eligibilityOk = eligibility.eligible; eligibilityReasons = eligibility.reasons; imageTag = live.imageTag;
    }
    if (!eligibilityOk) {
      await persistJobResult(db, job.id, { outcome: "refused", refusal_code: "not_eligible", reasons: eligibilityReasons });
      await audit(db, job, actorId, "deployment.promote", "project", projectId, { outcome: "refused", reasons: eligibilityReasons });
      return;
    }

    let previousSha: string | null;
    if (deployment.mechanism === "github_actions_jobs") {
      // Read live from the GitHub API (already fetched above into
      // actionsStatus.production) rather than lsRemoteHeads(project.repository_path)
      // — this mechanism has no dependency on a local git clone existing on
      // disk (va-jobs-platform's repository_path is a placeholder; see
      // migration 059's comment).
      previousSha = actionsStatus!.production?.sha ?? null;
    } else {
      const productionHeads = await lsRemoteHeads(project.repository_path);
      previousSha = productionHeads.get(deployment.production_branch) ?? null;
    }
    if (previousSha === commitSha) {
      await persistJobResult(db, job.id, { outcome: "noop", message: "already live" });
      return;
    }
    await assertOwned();
    let releaseId: string;
    try {
      const inserted = await db.query(
        `INSERT INTO production_releases (project_id, action, commit_sha, previous_commit_sha, image_tag, status, triggered_by, job_id)
         VALUES ($1,'promote',$2,$3,$4,'requested',$5,$6) RETURNING id`,
        [projectId, commitSha, previousSha, imageTag, actorId, job.id],
      );
      releaseId = inserted.rows[0].id;
    } catch (error: any) {
      if (error?.code === "23505") { // unique_violation on production_releases_project_inflight_idx
        await persistJobResult(db, job.id, { outcome: "refused", refusal_code: "promotion_in_progress" });
        return;
      }
      throw error;
    }
    await assertOwned();
    if (process.env.DEPLOYMENT_DRY_RUN === "true") {
      // 'superseded', not 'pending_approval' — a dry run must not occupy the
      // single-flight slot, since the whole point of dry-run mode is repeatable
      // manual testing without permanently blocking future promotes/rollbacks.
      await db.query(`UPDATE production_releases SET status='superseded', updated_at=now(), failure_reason='dry run — no ref updated' WHERE id=$1`, [releaseId]);
      await persistJobResult(db, job.id, { outcome: "dry_run", commit_sha: commitSha, previous_commit_sha: previousSha, release_id: releaseId });
      return;
    }
    try {
      await updateBranchReference(project.github_owner, project.github_repository, deployment.production_branch, commitSha, deployment.mechanism === "github_actions_jobs" ? forceRequested : false);
    } catch (error) {
      if (deployment.mechanism === "github_actions_jobs") {
        const nonFastForward = error instanceof GitHubProviderError && error.nonFastForward === true;
        await db.query(
          `UPDATE production_releases SET status='failed', failure_reason=$2, non_fast_forward=$3, forced=$4, updated_at=now() WHERE id=$1`,
          [releaseId, error instanceof Error ? error.message : String(error), nonFastForward, forceRequested],
        );
        await persistJobResult(db, job.id, { outcome: "refused", refusal_code: nonFastForward ? "non_fast_forward" : "ref_update_failed", error: error instanceof Error ? error.message : String(error) });
        await audit(db, job, actorId, "deployment.promote", "project", projectId, { outcome: "refused", refusal_code: nonFastForward ? "non_fast_forward" : "ref_update_failed" });
        // IMPORTANT: do not rethrow for this mechanism. Rethrowing propagates
        // to the worker's retry machinery (enqueueJob defaults max_attempts to
        // 3) — the whole point of this task is that a 422/non-fast-forward
        // must NOT auto-retry. The route in Task 9 additionally passes
        // maxAttempts:1 at enqueue time as a second, independent safeguard.
        return;
      }
      // existing health_check path: unchanged, still rethrows so the worker's
      // normal retry/failure handling applies exactly as before this plan.
      await db.query(`UPDATE production_releases SET status='failed', failure_reason=$2, updated_at=now() WHERE id=$1`,
        [releaseId, error instanceof Error ? error.message : String(error)]);
      await persistJobResult(db, job.id, { outcome: "failed", refusal_code: "ref_update_failed", error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    if (deployment.mechanism === "github_actions_jobs") {
      // Post-write ref verification — re-read the ref rather than trusting the
      // PATCH response body. Additive: gated to the new mechanism only, so the
      // existing health_check promotion flow's behavior (below) is unchanged.
      const verifyRead = await getBranchHeadCommit(project.github_owner, project.github_repository, deployment.production_branch).catch(() => null);
      if (verifyRead?.sha !== commitSha) {
        await db.query(`UPDATE production_releases SET status='failed', failure_reason='ref_verify_failed — ref did not read back as the target SHA', updated_at=now() WHERE id=$1`, [releaseId]);
        await persistJobResult(db, job.id, { outcome: "failed", refusal_code: "ref_verify_failed" });
        await audit(db, job, actorId, "deployment.promote", "project", projectId, { outcome: "failed", refusal_code: "ref_verify_failed" });
        return;
      }
      await db.query(`UPDATE production_releases SET status='pending_approval', forced=$2, updated_at=now() WHERE id=$1`, [releaseId, forceRequested]);
    } else {
      await db.query(`UPDATE production_releases SET status='pending_approval', updated_at=now() WHERE id=$1`, [releaseId]);
    }
    await audit(db, job, actorId, "deployment.promote", "project", projectId, { commit_sha: commitSha, previous_commit_sha: previousSha, image_tag: imageTag, release_id: releaseId });
    await persistJobResult(db, job.id, { outcome: "requested", commit_sha: commitSha, previous_commit_sha: previousSha, release_id: releaseId });
    return;
  }

  if (job.type === "deployment.rollback") {
    const projectId = required(job.payload_json, "project_id");
    const targetCommitSha = required(job.payload_json, "target_commit_sha");
    const expectedProductionSha = required(job.payload_json, "expected_production_sha");
    const project = (await db.query("SELECT * FROM projects WHERE id=$1", [projectId])).rows[0];
    if (!project) throw new Error("project not found");
    const deployment = loadDeploymentConfig(project);
    await assertOwned();
    const productionHeads = await lsRemoteHeads(project.repository_path);
    const currentProductionSha = productionHeads.get(deployment.production_branch) ?? null;
    if (currentProductionSha !== expectedProductionSha) {
      await persistJobResult(db, job.id, { outcome: "refused", refusal_code: "production_moved", current_sha: currentProductionSha });
      await audit(db, job, actorId, "deployment.rollback", "project", projectId, { outcome: "refused", refusal_code: "production_moved" });
      return;
    }
    if (currentProductionSha === targetCommitSha) {
      await persistJobResult(db, job.id, { outcome: "noop", message: "already live" });
      return;
    }
    const imageTag = deployment.image.tag_template.replace("{{commit}}", targetCommitSha);
    const image = await checkImageExists(deployment.image.registry, deployment.image.repository, imageTag);
    if (!image.exists) {
      await persistJobResult(db, job.id, { outcome: "refused", refusal_code: "image_gone", image_tag: imageTag });
      await audit(db, job, actorId, "deployment.rollback", "project", projectId, { outcome: "refused", refusal_code: "image_gone" });
      return;
    }
    await assertOwned();
    let releaseId: string;
    try {
      const inserted = await db.query(
        `INSERT INTO production_releases (project_id, action, commit_sha, previous_commit_sha, image_tag, status, triggered_by, job_id)
         VALUES ($1,'rollback',$2,$3,$4,'requested',$5,$6) RETURNING id`,
        [projectId, targetCommitSha, expectedProductionSha, imageTag, actorId, job.id],
      );
      releaseId = inserted.rows[0].id;
    } catch (error: any) {
      if (error?.code === "23505") {
        await persistJobResult(db, job.id, { outcome: "refused", refusal_code: "promotion_in_progress" });
        return;
      }
      throw error;
    }
    await assertOwned();
    if (process.env.DEPLOYMENT_DRY_RUN === "true") {
      // 'superseded', not 'pending_approval' — see the matching comment in the
      // promote dry-run branch above.
      await db.query(`UPDATE production_releases SET status='superseded', updated_at=now(), failure_reason='dry run — no ref updated' WHERE id=$1`, [releaseId]);
      await persistJobResult(db, job.id, { outcome: "dry_run", commit_sha: targetCommitSha, previous_commit_sha: expectedProductionSha, release_id: releaseId });
      return;
    }
    try {
      // force:true — rollback moves the branch BACKWARD (target is an ancestor of the
      // current head in the normal case), which a fast-forward-only update would reject.
      await updateBranchReference(project.github_owner, project.github_repository, deployment.production_branch, targetCommitSha, true);
    } catch (error) {
      // See the matching catch in the promote block — a release row must never
      // be left at 'requested' forever, or it permanently deadlocks the
      // single-flight slot for this project.
      await db.query(`UPDATE production_releases SET status='failed', failure_reason=$2, updated_at=now() WHERE id=$1`,
        [releaseId, error instanceof Error ? error.message : String(error)]);
      await persistJobResult(db, job.id, { outcome: "failed", refusal_code: "ref_update_failed", error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    await db.query(`UPDATE production_releases SET status='pending_approval', updated_at=now() WHERE id=$1`, [releaseId]);
    await audit(db, job, actorId, "deployment.rollback", "project", projectId, { commit_sha: targetCommitSha, previous_commit_sha: expectedProductionSha, release_id: releaseId });
    await persistJobResult(db, job.id, { outcome: "requested", commit_sha: targetCommitSha, previous_commit_sha: expectedProductionSha, release_id: releaseId });
    return;
  }

  throw new Error(`unknown provider job type: ${job.type}`);
}

// Terminal outcome written onto the job row so the admin UI (and agents) can
// report the truth instead of assuming success.
async function persistJobResult(db: Database, jobId: string, result_json: Record<string, unknown>) {
  await db.query("UPDATE jobs SET result_json=$2,updated_at=now() WHERE id=$1", [jobId, result_json]);
}
