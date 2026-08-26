import type pg from "pg";
import {
  approveAndMergePullRequest, importGithubPullRequests, PullRequestMergeError, syncOpenPullRequests, syncPullRequest,
} from "@dcc/domain";
import { createPullRequest, findOpenPullRequestForHead, mergeBranch } from "@dcc/github-provider";
import { assertRemoteBranchName, lsRemoteHeads, previewRemoteBranchMerge } from "../../../packages/git-runner/src/index.ts";

export const providerJobTypes = [
  "github.sync_open",
  "github.sync_one",
  "github.import",
  "github.merge_pull_request",
  "github.merge_branches",
  "github.merge_preview",
  "github.open_pull_request",
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

  throw new Error(`unknown provider job type: ${job.type}`);
}

// Terminal outcome written onto the job row so the admin UI (and agents) can
// report the truth instead of assuming success.
async function persistJobResult(db: Database, jobId: string, result_json: Record<string, unknown>) {
  await db.query("UPDATE jobs SET result_json=$2,updated_at=now() WHERE id=$1", [jobId, result_json]);
}
