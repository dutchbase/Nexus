import type pg from "pg";
import { getPullRequestPolicyInputs, GitHubProviderError } from "../../github-provider/src/index.ts";
import { transaction } from "./db-transaction.ts";
import { evaluatePullRequestPolicy } from "./pull-request-policy.ts";

export type EnsurePolicySnapshotResult =
  | { outcome: "synced"; snapshotId: string }
  | { outcome: "error"; errorCode: string; retryAfter: string | null };

// Reuses the exact same snapshot-insert / pull_requests-update shape as the
// merge-time re-verification in pr-merge.ts (lines 245-268) so the two
// snapshot-writing code paths never drift apart.
export async function ensurePolicySnapshot(
  db: pg.Pool,
  input: { pullRequestId: string; owner: string; repo: string; number: number },
): Promise<EnsurePolicySnapshotResult> {
  let inputs;
  try {
    inputs = await getPullRequestPolicyInputs(input.owner, input.repo, input.number);
  } catch (error) {
    const code = error instanceof GitHubProviderError ? error.code : "unknown_error";
    const retryAfter = error instanceof GitHubProviderError ? error.retryAt ?? null : null;
    await db.query(
      `UPDATE pull_requests SET policy_stale=true,policy_error_code=$2,policy_retry_after=$3,
       policy_last_attempted_at=now(),updated_at=now() WHERE id=$1`,
      [input.pullRequestId, code, retryAfter],
    );
    return { outcome: "error", errorCode: code, retryAfter };
  }

  const evaluated = evaluatePullRequestPolicy(inputs);
  const remote = inputs.pullRequest;
  const snapshotId = await transaction(db, async (client) => {
    const snapshot = (await client.query(
      `INSERT INTO pull_request_policy_snapshots
       (pull_request_id,material_json,material_hash,head_sha,base_ref,base_sha,review_state,check_state,
        refusal_codes,complete,incomplete_reason,source,fetched_at)
       VALUES ($1,$2,encode(digest(canonical_jsonb($2::jsonb),'sha256'),'hex'),$3,$4,$5,$6,$7,$8::jsonb,$9,$10,'github',$11)
       RETURNING id`,
      [input.pullRequestId, evaluated.material, remote.head.sha, remote.base.ref, remote.base.sha ?? null,
       evaluated.reviewState, evaluated.checkState, JSON.stringify(evaluated.refusalCodes), inputs.complete,
       inputs.incompleteReason ?? null, inputs.fetchedAt],
    )).rows[0];
    await client.query(
      `UPDATE pull_requests SET current_policy_snapshot_id=$2,head_sha=$3,base_branch=$4,review_state=$5,
       check_state=$6,policy_complete=$7,policy_stale=false,policy_synced_at=$8,
       policy_last_attempted_at=$8,policy_error_code=NULL,policy_retry_after=NULL,updated_at=now()
       WHERE id=$1`,
      [input.pullRequestId, snapshot.id, remote.head.sha, remote.base.ref,
       evaluated.reviewState, evaluated.checkState, inputs.complete, inputs.fetchedAt],
    );
    return snapshot.id as string;
  });
  return { outcome: "synced", snapshotId };
}
