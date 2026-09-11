import { inTransaction, removeArtifactFile } from "@dcc/database";
import type { QueryClient } from "@dcc/domain";

export async function expireUnclaimedUploads(client: QueryClient, roots: { primary: string; legacy: string }): Promise<number> {
  const candidates = (await client.query(
    `SELECT u.id FROM uploads u WHERE u.claim_expires_at IS NOT NULL
       AND u.claim_expires_at<now()-interval '23 hours'
       AND NOT EXISTS(SELECT 1 FROM attachments a WHERE a.upload_id=u.id AND a.ticket_id IS NOT NULL)
     ORDER BY u.claim_expires_at LIMIT 100`,
  )).rows;
  let removed = 0;
  for (const candidate of candidates) {
    const artifact = await inTransaction(async (tx) => {
      const attachment = (await tx.query("SELECT id,ticket_id FROM attachments WHERE upload_id=$1 FOR UPDATE", [candidate.id])).rows[0];
      if (!attachment || attachment.ticket_id) return null;
      const upload = (await tx.query(
        "SELECT id,claim_expires_at FROM uploads WHERE id=$1 AND claim_expires_at<now()-interval '23 hours' FOR UPDATE", [candidate.id],
      )).rows[0];
      if (!upload) return null;
      const row = (await tx.query("SELECT id,storage_root,storage_path FROM artifacts WHERE upload_id=$1 FOR UPDATE", [candidate.id])).rows[0];
      if (!row) return null;
      await tx.query("UPDATE artifacts SET status='abandoned' WHERE id=$1", [row.id]);
      return row;
    });
    if (!artifact) continue;
    try {
      const storageRoot: "primary" | "legacy" = artifact.storage_root === "legacy" ? "legacy" : "primary";
      await removeArtifactFile(roots[storageRoot], artifact.storage_path);
      await client.query(
        `UPDATE uploads SET claim_expires_at=NULL WHERE id=$1 AND claim_expires_at IS NOT NULL
         AND NOT EXISTS(SELECT 1 FROM attachments WHERE upload_id=$1 AND ticket_id IS NOT NULL)`, [candidate.id],
      );
      removed++;
    } catch {
      // Keep the deadline so a later maintenance pass retries controlled-path deletion.
    }
  }
  return removed;
}
