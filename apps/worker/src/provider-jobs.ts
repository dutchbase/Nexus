import type pg from "pg";
import {
  approveAndMergePullRequest, importGithubPullRequests, PullRequestMergeError, syncOpenPullRequests, syncPullRequest,
  checkProductionHealth, evaluatePromotionEligibility,
} from "@dcc/domain";
import {
  createPullRequest, findOpenPullRequestForHead, mergeBranch,
  getBranchHeadCommit, getCommitCheckStatus, getPullRequestsForCommit, updateBranchReference, getPendingDeployments, checkImageExists,
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
  const health = await checkProductionHealth(deployment.health);
  return { master, ciStatus, e2eGateSatisfied, e2eGatePrNumber, imageTag, image, health };
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
    const live = await fetchLiveDeploymentStatus(project, deployment);
    const eligibility = evaluatePromotionEligibility({
      ciState: live.ciStatus.overallState, imageExists: live.image.exists,
      e2eGateRequired: deployment.promotion.require_e2e_gate_label, e2eGateSatisfied: live.e2eGateSatisfied,
    });
    if (!eligibility.eligible) {
      await persistJobResult(db, job.id, { outcome: "refused", refusal_code: "not_eligible", reasons: eligibility.reasons });
      await audit(db, job, actorId, "deployment.promote", "project", projectId, { outcome: "refused", reasons: eligibility.reasons });
      return;
    }
    const productionHeads = await lsRemoteHeads(project.repository_path);
    const previousSha = productionHeads.get(deployment.production_branch) ?? null;
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
        [projectId, commitSha, previousSha, live.imageTag, actorId, job.id],
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
      await updateBranchReference(project.github_owner, project.github_repository, deployment.production_branch, commitSha, false);
    } catch (error) {
      // If the ref write throws (422 non-fast-forward, 401/403, rate limit,
      // network error) the release row must not stay 'requested' forever — the
      // partial unique index would then permanently refuse every future
      // promote/rollback for this project with promotion_in_progress.
      await db.query(`UPDATE production_releases SET status='failed', failure_reason=$2, updated_at=now() WHERE id=$1`,
        [releaseId, error instanceof Error ? error.message : String(error)]);
      await persistJobResult(db, job.id, { outcome: "failed", refusal_code: "ref_update_failed", error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    await db.query(`UPDATE production_releases SET status='pending_approval', updated_at=now() WHERE id=$1`, [releaseId]);
    await audit(db, job, actorId, "deployment.promote", "project", projectId, { commit_sha: commitSha, previous_commit_sha: previousSha, image_tag: live.imageTag, release_id: releaseId });
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
