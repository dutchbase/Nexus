import { createHash, randomUUID } from "node:crypto";
import { inTransaction } from "@dcc/database";

type QueryClient = {
  query(sql: string, values?: unknown[]): Promise<unknown>;
};

type Transaction = (work: (client: QueryClient) => Promise<void>) => Promise<void>;

export async function persistConflictResolutionSuccess(input: {
  runId: string;
  resolutionId: string;
  summary: string;
  resolvedCommit: string;
  storagePath: string;
  exitCode: number;
}, transaction: Transaction = inTransaction as Transaction) {
  await transaction(async (client) => {
    await client.query(
      "UPDATE agent_runs SET status='completed',working_directory=NULL,finished_at=now(),exit_code=$2 WHERE id=$1",
      [input.runId, input.exitCode],
    );
    await client.query(
      `UPDATE pr_conflict_resolutions
       SET status='resolved',summary=$2,resolved_sha=$3,completed_at=now() WHERE id=$1`,
      [input.resolutionId, input.summary, input.resolvedCommit],
    );
    await client.query(
      `INSERT INTO artifacts (id,storage_path,artifact_type,status,sha256,finalized_at,agent_run_id)
       VALUES ($1,$2,'conflict_worktree','finalized',$3,now(),$4)`,
      [
        randomUUID(),
        input.storagePath,
        createHash("sha256").update(input.resolvedCommit).digest("hex"),
        input.runId,
      ],
    );
  });
}
