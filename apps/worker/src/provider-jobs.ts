import type pg from "pg";
import {
  approveAndMergePullRequest, importGithubPullRequests, syncOpenPullRequests, syncPullRequest,
} from "@dcc/domain";
import { mergeBranch } from "@dcc/github-provider";

export const providerJobTypes = [
  "github.sync_open",
  "github.sync_one",
  "github.import",
  "github.merge_pull_request",
  "github.merge_branches",
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
  actorId: string,
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
  const actorId = required(job.payload_json, "actor_id");

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
    await syncPullRequest(pullRequestId, "admin", actorId, assertOwned);
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
    const expectedPolicySnapshotId = required(job.payload_json, "policy_snapshot_id");
    await assertOwned();
    await approveAndMergePullRequest(
      db as pg.Pool,
      {
        pullRequestId, jobId: job.id, actor: { type: "admin", id: actorId },
        expectedHeadSha, expectedPolicySnapshotId,
      },
      assertOwned,
    );
    await assertOwned();
    await audit(db, job, actorId, "github.merge_pull_request", "pull_request", pullRequestId, {
      expected_head_sha: expectedHeadSha,
      policy_snapshot_id: expectedPolicySnapshotId,
    });
    return;
  }

  const projectId = required(job.payload_json, "project_id");
  const head = required(job.payload_json, "head");
  const base = required(job.payload_json, "base");
  const project = (await db.query("SELECT * FROM projects WHERE id=$1", [projectId])).rows[0];
  if (!project?.github_owner || !project.github_repository) throw new Error("project has no GitHub repository configured");
  await assertOwned();
  const result = await mergeBranch(project.github_owner, project.github_repository, base, head);
  await assertOwned();
  await audit(db, job, actorId, "project.merge_branches", "project", projectId, {
    head, base, outcome: result.outcome, ...("sha" in result ? { sha: result.sha } : {}),
  });
}
