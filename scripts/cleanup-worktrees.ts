import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { artifactDataRoot, pool } from "../packages/database/src/index.ts";
import { removeManagedWorktree } from "../packages/git-runner/src/index.ts";

type Client = { query: (sql: string, values?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }>; release: () => void };
type Database = { connect: () => Promise<Client> };

export async function reclaimExpiredWorktrees(input: {
  db: Database;
  dataRoot: string;
  remove: (repositoryPath: string, dataRoot: string, worktreePath: string) => Promise<void>;
}) {
  let reclaimed = 0;
  for (let count = 0; count < 50; count += 1) {
    const client = await input.db.connect();
    try {
      await client.query("BEGIN");
      const attempt = (await client.query(
        `SELECT ea.id,ea.worktree_path,p.repository_path
         FROM execution_attempts ea
         JOIN tickets t ON t.id=ea.ticket_id
         JOIN projects p ON p.id=t.project_id
         WHERE ea.worktree_lifecycle_status='active'
           AND ea.worktree_expires_at <= now()
           AND ea.validation_status IN ('completed','published','failed','pr_creation_failed','cancelled','timed_out')
           AND NOT EXISTS (
             SELECT 1 FROM jobs j WHERE j.status IN ('queued','running')
               AND (j.payload_json->>'execution_attempt_id'=ea.id::text
                 OR j.payload_json->>'source_execution_attempt_id'=ea.id::text)
           )
         ORDER BY ea.worktree_expires_at
         LIMIT 1 FOR UPDATE SKIP LOCKED`,
      )).rows[0];
      if (!attempt) { await client.query("COMMIT"); break; }
      await input.remove(attempt.repository_path, input.dataRoot, attempt.worktree_path);
      const updated = await client.query(
        `UPDATE execution_attempts SET worktree_lifecycle_status='reclaimed',worktree_reclaimed_at=now()
         WHERE id=$1 AND worktree_lifecycle_status='active'`,
        [attempt.id],
      );
      await client.query("COMMIT");
      reclaimed += updated.rowCount ?? 0;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      console.error(`worktree reclaim failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      client.release();
    }
  }
  return reclaimed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const reclaimed = await reclaimExpiredWorktrees({
    db: pool, dataRoot: artifactDataRoot(resolve()), remove: removeManagedWorktree,
  });
  console.log(`worktree cleanup reclaimed ${reclaimed} expired attempts`);
}
