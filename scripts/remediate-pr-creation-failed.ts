import { inTransaction, pool } from "../packages/database/src/index.ts";

// ponytail: one-off operator repair for execution attempts left at
// pr_creation_failed by the race fixed in worker.ts (plain INSERT racing
// against the periodic pull_requests sync upsert). For each stuck attempt,
// if a pull_requests row already exists for that attempt's branch, claim it
// and restore the ticket to PR Ready for Review. Safe to re-run: remediated
// attempts no longer match the stuck-attempt query.

try {
  const stuck = (await pool.query(
    `SELECT ea.id AS attempt_id, ea.branch_name, ea.ticket_id,
            t.status AS ticket_status, t.project_id
     FROM execution_attempts ea
     JOIN tickets t ON t.id = ea.ticket_id
     WHERE ea.validation_status = 'pr_creation_failed'`,
  )).rows;

  let remediated = 0;
  let skipped = 0;
  for (const attempt of stuck) {
    const pr = (await pool.query(
      `SELECT id FROM pull_requests WHERE project_id=$1 AND head_branch=$2`,
      [attempt.project_id, attempt.branch_name],
    )).rows[0];
    if (!pr) {
      skipped++;
      continue;
    }
    await inTransaction(async (client) => {
      await client.query(
        `UPDATE pull_requests SET execution_attempt_id=$1, ticket_id=$2, updated_at=now() WHERE id=$3`,
        [attempt.attempt_id, attempt.ticket_id, pr.id],
      );
      await client.query(
        `UPDATE execution_attempts SET validation_status='completed', completed_at=now() WHERE id=$1`,
        [attempt.attempt_id],
      );
      await client.query(
        "UPDATE tickets SET status='PR Ready for Review', updated_at=now() WHERE id=$1",
        [attempt.ticket_id],
      );
      await client.query(
        `INSERT INTO ticket_status_history
         (ticket_id,previous_status,new_status,reason,actor_type,related_pull_request_id)
         VALUES ($1,$2,'PR Ready for Review','Pull request already existed on GitHub; remediated by operator after pr_creation_failed race',$3,$4)`,
        [attempt.ticket_id, attempt.ticket_status, 'worker', pr.id],
      );
    });
    remediated++;
  }

  console.log(
    `✓ remediated ${remediated} stuck attempt(s), skipped ${skipped} (no matching PR found yet)`,
  );
} catch (error) {
  console.error(
    `✗ remediation failed: ${error instanceof Error ? error.message : "unknown error"}`,
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
