import path from "node:path";
import { pool, reconcileArtifacts } from "../packages/database/src/index.ts";

const dataRoot = path.resolve(process.env.DCC_DATA_ROOT ?? ".", "data");
const records = (await pool.query(
  "SELECT id,storage_path,status,expires_at FROM artifacts WHERE status IN ('staged','finalized')",
)).rows as Array<{ id: string; storage_path: string; status: "staged" | "finalized" | "abandoned"; expires_at: Date | string | null }>;
let finalized = 0;
let abandoned = 0;

try {
  await reconcileArtifacts({
    root: dataRoot,
    records,
    finalize: async (id, sha256) => {
      finalized += (await pool.query(
        "UPDATE artifacts SET status='finalized',sha256=$2,finalized_at=now(),expires_at=NULL WHERE id=$1 AND status='staged'",
        [id, sha256],
      )).rowCount ?? 0;
    },
    abandon: async (id) => {
      abandoned += (await pool.query(
        "UPDATE artifacts SET status='abandoned',abandoned_at=now() WHERE id=$1 AND status IN ('staged','finalized')",
        [id],
      )).rowCount ?? 0;
    },
  });
  console.log(`artifact reconciliation: ${finalized} finalized, ${abandoned} abandoned`);
} finally {
  await pool.end();
}
