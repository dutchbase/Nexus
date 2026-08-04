import { resolve } from "node:path";
import { artifactDataRoot, pool } from "../packages/database/src/index.ts";
import { removeManagedWorktree } from "../packages/git-runner/src/index.ts";

const dataRoot = artifactDataRoot(resolve());
const candidates = (await pool.query(
  `SELECT ea.id,ea.worktree_path,p.repository_path
   FROM execution_attempts ea
   JOIN tickets t ON t.id=ea.ticket_id
   JOIN projects p ON p.id=t.project_id
   WHERE ea.worktree_lifecycle_status='active'
     AND ea.worktree_expires_at <= now()
     AND ea.validation_status IN ('completed','published','failed','pr_creation_failed','cancelled','timed_out')
     AND NOT EXISTS (
       SELECT 1 FROM jobs j
       WHERE j.status IN ('queued','running')
         AND j.payload_json->>'execution_attempt_id'=ea.id::text
     )
   ORDER BY ea.worktree_expires_at
   LIMIT 50`,
)).rows;

let reclaimed = 0;
for (const attempt of candidates) {
  try {
    await removeManagedWorktree(attempt.repository_path, dataRoot, attempt.worktree_path);
    const updated = await pool.query(
      `UPDATE execution_attempts SET worktree_lifecycle_status='reclaimed',worktree_reclaimed_at=now()
       WHERE id=$1 AND worktree_lifecycle_status='active'
         AND NOT EXISTS (
           SELECT 1 FROM jobs j WHERE j.status IN ('queued','running')
             AND j.payload_json->>'execution_attempt_id'=execution_attempts.id::text
         )`,
      [attempt.id],
    );
    reclaimed += updated.rowCount ?? 0;
  } catch (error) {
    console.error(`worktree reclaim failed for ${attempt.id}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
console.log(`worktree cleanup reclaimed ${reclaimed}/${candidates.length} expired attempts`);
