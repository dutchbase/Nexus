import type pg from "pg";
import { getPullRequest } from "../../github-provider/src/index.ts";
import { inTransaction, pool } from "@dcc/database";

const openPrStatuses = ["PR Ready for Review", "PR Changes Requested", "PR Approved"];

async function transition(
  client: pg.PoolClient,
  row: any,
  next: string,
  reason: string,
  actorType: "worker" | "admin",
  actorId?: string,
) {
  if (row.ticket_status === next) return;
  await client.query("UPDATE tickets SET status=$2,updated_at=now() WHERE id=$1", [row.ticket_id, next]);
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
        await transition(client, row, "Merged", reason, actorType, actorId);
      }
      if (row.ticket_status === "Merged") await transition(client, row, "Completed", reason, actorType, actorId);
    } else if (
      (next === "PR Approved" && ["PR Ready for Review", "PR Changes Requested"].includes(row.ticket_status))
      || (next === "PR Changes Requested" && ["PR Ready for Review", "PR Approved"].includes(row.ticket_status))
      || (next === "Closed Without Merge" && openPrStatuses.includes(row.ticket_status))
    ) {
      await transition(client, row, next, reason, actorType, actorId);
    }
    return row.ticket_status;
  });
}

export async function syncPullRequest(pullRequestId: string, actorType: "worker" | "admin" = "worker", actorId?: string) {
  const stored = (await pool.query(
    `SELECT pr.*,p.github_owner,p.github_repository,t.status ticket_status
     FROM pull_requests pr
     JOIN projects p ON p.id=pr.project_id
     LEFT JOIN tickets t ON t.id=pr.ticket_id
     WHERE pr.id=$1`,
    [pullRequestId],
  )).rows[0];
  if (!stored) return null;
  const remote = await getPullRequest(stored.github_owner, stored.github_repository, stored.number);
  await pool.query(
    `UPDATE pull_requests SET state=$2,review_state=$3,check_state=$4,is_draft=$5,
       title=$6,author=$7,head_branch=$8,base_branch=$9,updated_at_provider=$10,
       merged_at=$11,closed_at=$12,merge_commit_sha=$13,last_synced_at=now(),updated_at=now()
     WHERE id=$1`,
    [
      stored.id, remote.state, remote.review_state ?? null, remote.check_state ?? null, remote.draft,
      remote.title, remote.user?.login ?? null, remote.head.ref, remote.base.ref, remote.updated_at,
      remote.merged_at ?? null, remote.closed_at ?? null, remote.merge_commit_sha ?? null,
    ],
  );
  if (!stored.ticket_id || !openPrStatuses.includes(stored.ticket_status)) return remote;
  if (remote.merged === true || remote.merged_at) {
    await setPullRequestTicketStatus(stored.id, "Completed", "GitHub pull request merged", actorType, actorId);
  } else if (remote.state === "closed") {
    await setPullRequestTicketStatus(stored.id, "Closed Without Merge", "GitHub pull request closed without merge", actorType, actorId);
  } else if (remote.review_state === "approved" && stored.ticket_status === "PR Ready for Review") {
    await setPullRequestTicketStatus(stored.id, "PR Approved", "GitHub pull request approved", actorType, actorId);
  } else if (
    remote.review_state === "changes_requested"
    && ["PR Ready for Review", "PR Approved"].includes(stored.ticket_status)
  ) {
    await setPullRequestTicketStatus(stored.id, "PR Changes Requested", "GitHub changes requested", actorType, actorId);
  }
  return remote;
}

export async function syncOpenPullRequests() {
  const rows = (await pool.query(
    `SELECT pr.id FROM pull_requests pr JOIN tickets t ON t.id=pr.ticket_id
     WHERE t.status=ANY($1::text[]) ORDER BY pr.last_synced_at NULLS FIRST`,
    [openPrStatuses],
  )).rows;
  for (const row of rows) {
    try {
      await syncPullRequest(row.id);
    } catch (error) {
      console.error(`Pull-request sync failed for ${row.id}:`, error);
    }
  }
}
