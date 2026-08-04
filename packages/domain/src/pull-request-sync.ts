import type pg from "pg";
import { randomUUID } from "node:crypto";
import { GitHubProviderError, getPullRequestPolicyInputs, listPullRequests } from "../../github-provider/src/index.ts";
import { inTransaction, pool } from "@dcc/database";
import { evaluatePullRequestPolicy } from "./pull-request-policy.ts";

const openPrStatuses = ["PR Ready for Review", "PR Changes Requested", "PR Approved"];

async function transition(
  client: pg.PoolClient,
  row: any,
  next: string,
  reason: string,
  actorType: "worker" | "admin",
  actorId?: string,
  assertOwned: () => Promise<void> = async () => {},
) {
  if (row.ticket_status === next) return;
  await assertOwned();
  await client.query("UPDATE tickets SET status=$2,updated_at=now() WHERE id=$1", [row.ticket_id, next]);
  await assertOwned();
  await client.query(
    `INSERT INTO ticket_status_history
     (ticket_id,previous_status,new_status,reason,actor_type,actor_id,related_pull_request_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [row.ticket_id, row.ticket_status, next, reason, actorType, actorId ?? null, row.id],
  );
  row.ticket_status = next;
}

export async function setPullRequestTicketStatus(
  pullRequestId: string,
  next: "PR Approved" | "PR Changes Requested" | "Completed" | "Closed Without Merge",
  reason: string,
  actorType: "worker" | "admin",
  actorId?: string,
  assertOwned: () => Promise<void> = async () => {},
) {
  return inTransaction(async (client) => {
    const row = (await client.query(
      `SELECT pr.id,pr.ticket_id,t.status ticket_status
       FROM pull_requests pr JOIN tickets t ON t.id=pr.ticket_id
       WHERE pr.id=$1 FOR UPDATE OF pr,t`,
      [pullRequestId],
    )).rows[0];
    if (!row) return null;
    if (next === "Completed") {
      if (!["Merged", "Completed"].includes(row.ticket_status)) {
        await transition(client, row, "Merged", reason, actorType, actorId, assertOwned);
      }
      if (row.ticket_status === "Merged") await transition(client, row, "Completed", reason, actorType, actorId, assertOwned);
    } else if (
      (next === "PR Approved" && ["PR Ready for Review", "PR Changes Requested"].includes(row.ticket_status))
      || (next === "PR Changes Requested" && ["PR Ready for Review", "PR Approved"].includes(row.ticket_status))
      || (next === "Closed Without Merge" && openPrStatuses.includes(row.ticket_status))
    ) {
      await transition(client, row, next, reason, actorType, actorId, assertOwned);
    }
    return row.ticket_status;
  });
}

export async function syncPullRequest(
  pullRequestId: string,
  actorType: "worker" | "admin" = "worker",
  actorId?: string,
  assertOwned: () => Promise<void> = async () => {},
) {
  const stored = (await pool.query(
    `SELECT pr.*,p.github_owner,p.github_repository,t.status ticket_status
     FROM pull_requests pr
     JOIN projects p ON p.id=pr.project_id
     LEFT JOIN tickets t ON t.id=pr.ticket_id
     WHERE pr.id=$1`,
    [pullRequestId],
  )).rows[0];
  if (!stored) return null;
  await assertOwned();
  const syncToken = randomUUID();
  if ((await pool.query(
    "UPDATE pull_requests SET policy_sync_token=$2,policy_last_attempted_at=now() WHERE id=$1",
    [stored.id, syncToken],
  )).rowCount !== 1) throw new Error("pull-request sync superseded");
  await assertOwned();
  let inputs;
  try {
    inputs = await getPullRequestPolicyInputs(stored.github_owner, stored.github_repository, stored.number);
  } catch (error) {
    if (error instanceof GitHubProviderError) {
      await assertOwned();
      await pool.query(
        `UPDATE pull_requests SET policy_stale=true,policy_sync_token=NULL,
         policy_error_code=$2,policy_retry_after=$3,updated_at=now()
         WHERE id=$1 AND policy_sync_token=$4::uuid`,
        [stored.id, error.code, error.retryAt ?? null, syncToken],
      );
    }
    throw error;
  }
  const remote = inputs.pullRequest;
  const evaluated = evaluatePullRequestPolicy(inputs);
  await assertOwned();
  await inTransaction(async (client) => {
    const snapshot = (await client.query(
      `INSERT INTO pull_request_policy_snapshots
       (pull_request_id,material_json,material_hash,head_sha,base_ref,base_sha,review_state,check_state,
        refusal_codes,complete,incomplete_reason,source,fetched_at)
       VALUES ($1,$2,encode(digest(canonical_jsonb($2::jsonb),'sha256'),'hex'),$3,$4,$5,$6,$7,$8::jsonb,$9,$10,'github',$11)
       RETURNING id`,
      [stored.id, evaluated.material, remote.head.sha, remote.base.ref, remote.base.sha ?? null,
       evaluated.reviewState, evaluated.checkState, JSON.stringify(evaluated.refusalCodes), inputs.complete,
       inputs.incompleteReason ?? null, inputs.fetchedAt],
    )).rows[0];
    await assertOwned();
    const updated = await client.query(
      `UPDATE pull_requests SET state=$2,review_state=$3,check_state=$4,is_draft=$5,
         title=$6,author=$7,head_branch=$8,base_branch=$9,updated_at_provider=$10,
         merged_at=$11,closed_at=$12,merge_commit_sha=$13,body=$14,merge_conflicts=$15,
         current_policy_snapshot_id=$16,head_sha=$17,policy_complete=$18,policy_stale=false,
         policy_synced_at=$19,policy_last_attempted_at=$19,policy_error_code=NULL,policy_retry_after=NULL,
         requested_reviewers=$20::jsonb,policy_sync_token=NULL,
         last_synced_at=now(),updated_at=now()
       WHERE id=$1 AND policy_sync_token=$21::uuid`,
      [stored.id, remote.state, evaluated.reviewState, evaluated.checkState, false,
       remote.title, remote.user?.login ?? null, remote.head.ref, remote.base.ref, remote.updated_at,
       remote.merged_at ?? null, remote.closed_at ?? null, remote.merge_commit_sha ?? null,
       remote.body ?? null, remote.mergeable_state === "dirty", snapshot.id, remote.head.sha,
       inputs.complete, inputs.fetchedAt, JSON.stringify(inputs.requestedReviewers), syncToken],
    );
    if (updated.rowCount !== 1) throw new Error("pull-request sync superseded");
  });
  await assertOwned();
  if (!stored.ticket_id || !openPrStatuses.includes(stored.ticket_status)) return remote;
  if (remote.merged === true || remote.merged_at) {
    await setPullRequestTicketStatus(stored.id, "Completed", "GitHub pull request merged", actorType, actorId, assertOwned);
  } else if (remote.state === "closed") {
    await setPullRequestTicketStatus(stored.id, "Closed Without Merge", "GitHub pull request closed without merge", actorType, actorId, assertOwned);
  } else if (evaluated.reviewState === "approved" && stored.ticket_status === "PR Ready for Review") {
    await setPullRequestTicketStatus(stored.id, "PR Approved", "GitHub pull request approved", actorType, actorId, assertOwned);
  } else if (
    evaluated.reviewState === "changes_requested"
    && ["PR Ready for Review", "PR Approved"].includes(stored.ticket_status)
  ) {
    await setPullRequestTicketStatus(stored.id, "PR Changes Requested", "GitHub changes requested", actorType, actorId, assertOwned);
  }
  return remote;
}

export async function importGithubPullRequests(
  pool: pg.Pool,
  project: any,
  assertOwned: () => Promise<void> = async () => {},
) {
  await assertOwned();
  const remote = await listPullRequests(project.github_owner, project.github_repository, "all");
  await assertOwned();
  for (const pr of remote.items) {
    await pool.query(
      `INSERT INTO pull_requests (project_id,provider,repository,number,url,title,author,state,is_draft,
         head_branch,base_branch,created_at_provider,updated_at_provider,merged_at,closed_at,merge_commit_sha,body,last_synced_at)
       VALUES ($1,'github',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,now())
       ON CONFLICT (project_id,number) DO UPDATE SET
         url=EXCLUDED.url,title=EXCLUDED.title,author=EXCLUDED.author,state=EXCLUDED.state,
         is_draft=EXCLUDED.is_draft,head_branch=EXCLUDED.head_branch,base_branch=EXCLUDED.base_branch,
         updated_at_provider=EXCLUDED.updated_at_provider,merged_at=EXCLUDED.merged_at,closed_at=EXCLUDED.closed_at,
         merge_commit_sha=EXCLUDED.merge_commit_sha,body=EXCLUDED.body,last_synced_at=now(),updated_at=now()`,
      [project.id, `${project.github_owner}/${project.github_repository}`, pr.number, pr.html_url, pr.title, pr.user?.login ?? null,
       pr.state, false, pr.head.ref, pr.base.ref,
       pr.created_at, pr.updated_at, pr.merged_at ?? null, pr.closed_at ?? null, pr.merge_commit_sha ?? null, pr.body ?? null],
    );
    await assertOwned();
  }
  await assertOwned();
  await pool.query(
    `INSERT INTO github_repository_sync_state
     (project_id,cursor,complete,last_attempted_at,last_completed_at,error_code,retry_after)
     VALUES ($1,$2,$3,$4,CASE WHEN $3 THEN $4::timestamptz END,$5,$6)
     ON CONFLICT (project_id) DO UPDATE SET cursor=EXCLUDED.cursor,complete=EXCLUDED.complete,
       last_attempted_at=EXCLUDED.last_attempted_at,
       last_completed_at=CASE WHEN EXCLUDED.complete THEN EXCLUDED.last_attempted_at ELSE github_repository_sync_state.last_completed_at END,
       error_code=EXCLUDED.error_code,retry_after=EXCLUDED.retry_after`,
    [project.id, remote.cursor, remote.complete, remote.fetchedAt, remote.errorCode ?? null, remote.retryAt ?? null],
  );
  return { imported: remote.items.length, complete: remote.complete, cursor: remote.cursor };
}

export async function syncOpenPullRequests(assertOwned: () => Promise<void> = async () => {}) {
  const rows = (await pool.query(
    `SELECT pr.id FROM pull_requests pr JOIN tickets t ON t.id=pr.ticket_id
     WHERE t.status=ANY($1::text[]) ORDER BY pr.last_synced_at NULLS FIRST`,
    [openPrStatuses],
  )).rows;
  for (const row of rows) {
    try {
      await syncPullRequest(row.id, "worker", undefined, assertOwned);
    } catch (error) {
      await assertOwned();
      console.error(`Pull-request sync failed for ${row.id}:`, error);
    }
  }
}
