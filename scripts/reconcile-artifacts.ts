import path from "node:path";
import { fileURLToPath } from "node:url";
import { artifactDataRoot, legacyArtifactDataRoot, pool, reconcileArtifacts } from "../packages/database/src/index.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataRoot = artifactDataRoot(repoRoot);
const legacyDataRoot = legacyArtifactDataRoot(repoRoot);
const records = (await pool.query(
  "SELECT id,storage_path,status,expires_at,storage_root FROM artifacts WHERE status IN ('staged','finalized')",
)).rows as Array<{ id: string; storage_path: string; status: "staged" | "finalized" | "abandoned"; expires_at: Date | string | null; storage_root?: "primary" | "legacy" }>;
let finalized = 0;
let abandoned = 0;

try {
  for (const storageRoot of ["primary", "legacy"] as const) {
    await reconcileArtifacts({
      root: storageRoot === "legacy" ? legacyDataRoot : dataRoot,
      records: records.filter((record) => (record.storage_root ?? "primary") === storageRoot),
      finalize: async (id, sha256) => {
        finalized += (await pool.query(
          "UPDATE artifacts SET status='finalized',sha256=$2,finalized_at=now(),expires_at=NULL WHERE id=$1 AND status='staged'",
          [id, sha256],
        )).rowCount ?? 0;
      },
      abandon: async (id, status) => {
        const changed = (await pool.query(
          "UPDATE artifacts SET status='abandoned',abandoned_at=now() WHERE id=$1 AND status=$2",
          [id, status],
        )).rowCount ?? 0;
        abandoned += changed;
        return changed > 0;
      },
    });
  }
  console.log(`artifact reconciliation: ${finalized} finalized, ${abandoned} abandoned`);
} finally {
  await pool.end();
}
