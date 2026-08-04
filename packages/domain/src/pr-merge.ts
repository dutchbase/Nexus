import type pg from "pg";
import {
  getPullRequest, getPullRequestPolicyInputs, GitHubProviderError, mergePullRequest,
} from "../../github-provider/src/index.ts";
import { evaluatePullRequestPolicy } from "./pull-request-policy.ts";
import { syncPullRequest } from "./pull-request-sync.ts";

export class PullRequestMergeError extends Error {
  constructor(message: string, public code = "merge_failed") {
    super(message);
    this.name = "PullRequestMergeError";
  }
}

type MergeInput = {
  pullRequestId: string;
  jobId: string;
  actor: { type: "worker" | "admin"; id: string };
  expectedHeadSha: string;
  expectedPolicySnapshotId: string;
};

async function transaction<T>(db: pg.Pool, work: (client: pg.PoolClient) => Promise<T>) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function resultFor(row: any) {
  return {
    mergedSha: row.merged_sha,
    mergedHeadSha: row.merged_head_sha,
    policySnapshotId: row.verified_policy_snapshot_id,
  };
}

async function recordMerged(
  db: pg.Pool,
  input: MergeInput,
  policySnapshotId: string,
  mergedSha: string,
  providerResponse: unknown,
) {
  await transaction(db, async (client) => {
    await client.query(
      `UPDATE pull_request_merge_attempts
       SET state='merged',refusal_code=NULL,verified_policy_snapshot_id=$2,merged_head_sha=$3,merged_sha=$4,
         provider_response=$5,merged_at=now(),completed_at=now(),updated_at=now()
       WHERE job_id=$1`,
      [input.jobId, policySnapshotId, input.expectedHeadSha, mergedSha, providerResponse],
    );
    await client.query(
      "UPDATE pull_requests SET internal_review_state='approved',updated_at=now() WHERE id=$1",
      [input.pullRequestId],
    );
  });
}

async function recordProviderRefusal(db: pg.Pool, input: MergeInput, code: string, response: unknown) {
  await db.query(
    `UPDATE pull_request_merge_attempts SET state='refused',refusal_code=$2,provider_response=$3,
     refused_at=now(),completed_at=now(),updated_at=now() WHERE job_id=$1`,
    [input.jobId, code, response],
  );
}

export function approveAndMergePullRequest(
  db: pg.Pool,
  input: MergeInput,
  assertOwned?: () => Promise<void>,
): Promise<{ mergedSha: string; mergedHeadSha: string; policySnapshotId: string }>;
// Temporary compile-only compatibility for the disabled AI auto-merge branch;
// Task 4 removes that dead caller rather than extending this gate for it.
export function approveAndMergePullRequest(
  db: pg.Pool, pullRequest: unknown, targetBranch: string | undefined,
  actor: unknown, expectedHeadSha?: string, expectedBaseBranch?: string,
  expectedBaseSha?: string, assertOwned?: () => Promise<void>,
): Promise<void>;
export async function approveAndMergePullRequest(
  db: pg.Pool,
  input: any,
  assertOwned: any = async () => {},
  ..._legacy: unknown[]
): Promise<any> {
  if (typeof input.pullRequestId !== "string" || typeof input.jobId !== "string"
    || typeof input.expectedHeadSha !== "string" || typeof input.expectedPolicySnapshotId !== "string") {
    throw new PullRequestMergeError("legacy merge path is disabled", "stale_binding");
  }
  const mergeInput = input as MergeInput;
  const ownership = typeof assertOwned === "function" ? assertOwned : async () => {};
  const stored = (await db.query(
    `SELECT pr.id,p.github_owner,p.github_repository,pr.number,
       ps.id expected_snapshot_id,ps.head_sha expected_head_sha,ps.material_hash expected_material_hash
     FROM pull_requests pr
     JOIN projects p ON p.id=pr.project_id
     JOIN pull_request_policy_snapshots ps ON ps.id=$2 AND ps.pull_request_id=pr.id
     WHERE pr.id=$1`,
    [mergeInput.pullRequestId, mergeInput.expectedPolicySnapshotId],
  )).rows[0];
  if (!stored || stored.expected_head_sha !== mergeInput.expectedHeadSha) {
    throw new PullRequestMergeError("merge policy binding is missing or stale", "stale_binding");
  }

  const prior = (await db.query("SELECT * FROM pull_request_merge_attempts WHERE job_id=$1", [mergeInput.jobId])).rows[0];
  if (prior?.state === "merged") return resultFor(prior);

  const owner = stored.github_owner;
  const repo = stored.github_repository;
  if (prior?.state === "verified") {
    await ownership();
    const remote = await getPullRequest(owner, repo, stored.number);
    await ownership();
    if (remote.merged === true && remote.head.sha === mergeInput.expectedHeadSha && remote.merge_commit_sha) {
      const providerResponse = { reconciled: true, pull_request: remote };
      await recordMerged(db, mergeInput, prior.verified_policy_snapshot_id, remote.merge_commit_sha, providerResponse);
      return { mergedSha: remote.merge_commit_sha, mergedHeadSha: mergeInput.expectedHeadSha, policySnapshotId: prior.verified_policy_snapshot_id };
    }
  }

  await ownership();
  const inputs = await getPullRequestPolicyInputs(owner, repo, stored.number);
  await ownership();
  const evaluated = evaluatePullRequestPolicy(inputs);
  const remote = inputs.pullRequest;
  const verified = await transaction(db, async (client) => {
    const snapshot = (await client.query(
      `INSERT INTO pull_request_policy_snapshots
       (pull_request_id,material_json,material_hash,head_sha,base_ref,base_sha,review_state,check_state,
        refusal_codes,complete,incomplete_reason,source,fetched_at)
       VALUES ($1,$2,encode(digest(canonical_jsonb($2::jsonb),'sha256'),'hex'),$3,$4,$5,$6,$7,$8::jsonb,$9,$10,'github',$11)
       RETURNING id,material_hash`,
      [mergeInput.pullRequestId, evaluated.material, remote.head.sha, remote.base.ref, remote.base.sha ?? null,
       evaluated.reviewState, evaluated.checkState, JSON.stringify(evaluated.refusalCodes), inputs.complete,
       inputs.incompleteReason ?? null, inputs.fetchedAt],
    )).rows[0];
    const refusalCode = remote.head.sha !== mergeInput.expectedHeadSha
      ? "head_changed"
      : snapshot.material_hash !== stored.expected_material_hash
        ? "policy_changed"
        : evaluated.refusalCodes[0];
    await client.query(
      `UPDATE pull_requests SET current_policy_snapshot_id=$2,head_sha=$3,base_branch=$4,review_state=$5,
       check_state=$6,policy_complete=$7,policy_stale=false,policy_synced_at=$8,
       policy_last_attempted_at=$8,policy_error_code=NULL,policy_retry_after=NULL,updated_at=now()
       WHERE id=$1`,
      [mergeInput.pullRequestId, snapshot.id, remote.head.sha, remote.base.ref, evaluated.reviewState,
       evaluated.checkState, inputs.complete, inputs.fetchedAt],
    );
    await client.query(
      `INSERT INTO pull_request_merge_attempts
       (job_id,pull_request_id,expected_policy_snapshot_id,verified_policy_snapshot_id,expected_head_sha,
        state,refusal_code,actor_type,actor_id,verified_at,refused_at,completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),CASE WHEN $7::text IS NOT NULL THEN now() END,
        CASE WHEN $7::text IS NOT NULL THEN now() END)
       ON CONFLICT (job_id) DO UPDATE SET verified_policy_snapshot_id=EXCLUDED.verified_policy_snapshot_id,
        state=EXCLUDED.state,refusal_code=EXCLUDED.refusal_code,verified_at=now(),
        refused_at=EXCLUDED.refused_at,completed_at=EXCLUDED.completed_at,updated_at=now()`,
      [mergeInput.jobId, mergeInput.pullRequestId, mergeInput.expectedPolicySnapshotId, snapshot.id, mergeInput.expectedHeadSha,
       refusalCode ? "refused" : "verified", refusalCode ?? null, mergeInput.actor.type, mergeInput.actor.id],
    );
    return { snapshotId: snapshot.id as string, refusalCode };
  });

  if (verified.refusalCode) {
    throw new PullRequestMergeError(`merge refused: ${verified.refusalCode}`, verified.refusalCode);
  }

  await ownership();
  let providerResponse;
  try {
    providerResponse = await mergePullRequest(owner, repo, stored.number, "squash", mergeInput.expectedHeadSha);
  } catch (error) {
    const refused = error instanceof GitHubProviderError && error.code === "http_error";
    const code = error instanceof GitHubProviderError && error.status === 409 ? "provider_head_changed" : "provider_error";
    const response = error instanceof GitHubProviderError
      ? { code: error.code, status: error.status ?? null, message: error.message }
      : { message: error instanceof Error ? error.message : "merge failed" };
    if (refused) await recordProviderRefusal(db, mergeInput, code, response);
    throw new PullRequestMergeError(`${refused ? "merge refused" : "merge outcome unknown"}: ${code}`, code);
  }
  if (!providerResponse.merged || !providerResponse.sha) {
    await recordProviderRefusal(db, mergeInput, "provider_refused", providerResponse);
    throw new PullRequestMergeError("merge refused by GitHub", "provider_refused");
  }

  await recordMerged(db, mergeInput, verified.snapshotId, providerResponse.sha, providerResponse);
  try {
    await ownership();
    await syncPullRequest(mergeInput.pullRequestId, mergeInput.actor.type, mergeInput.actor.id, ownership);
  } catch {}
  return { mergedSha: providerResponse.sha, mergedHeadSha: mergeInput.expectedHeadSha, policySnapshotId: verified.snapshotId };
}
