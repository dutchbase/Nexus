import { inTransaction, pool } from "../packages/database/src/index.ts";

// ponytail: one-off operator repair for tickets stranded in Planning Queued /
// Plan Revision Queued by the worker BEFORE it was fixed to transition to
// Planning Failed on planning failure. Safe to re-run: remediated tickets no
// longer match the stranded-ticket query.

try {
  const stranded = (await pool.query(
    `SELECT t.id, t.status
     FROM tickets t
     WHERE t.status IN ('Planning Queued', 'Plan Revision Queued')
       AND NOT EXISTS (
         SELECT 1 FROM jobs j
         WHERE j.type IN ('planning.generate', 'planning.revise')
           AND j.payload_json->>'ticket_id' = t.id::text
           AND j.status IN ('queued', 'running')
       )`,
  )).rows;

  let remediated = 0;
  for (const ticket of stranded) {
    await inTransaction(async (client) => {
      await client.query("UPDATE tickets SET status='Planning Failed', updated_at=now() WHERE id=$1", [ticket.id]);
      await client.query(
        `INSERT INTO ticket_status_history (ticket_id, previous_status, new_status, reason, actor_type)
         VALUES ($1, $2, 'Planning Failed', 'Planning job failed (remediated by operator)', 'worker')`,
        [ticket.id, ticket.status],
      );
    });
    remediated++;
  }

  console.log(
    remediated > 0
      ? `✓ remediated ${remediated} stranded ticket(s)`
      : "✓ remediated 0 stranded tickets — none found",
  );
} catch (error) {
  console.error(
    `✗ remediation failed: ${error instanceof Error ? error.message : "unknown error"}`,
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
