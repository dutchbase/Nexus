import type pg from "pg";

export type PlanApprovalGate =
  | { valid: true; ticket: any; plan: any; planVersion: any }
  | { valid: false; code: string; message: string };

export async function checkPlanApprovalGate(
  client: pg.Pool | pg.PoolClient,
  ticketId: string,
): Promise<PlanApprovalGate> {
  const row = (await client.query(
    `SELECT t.*,p.id plan_id,p.current_version_id,p.potentially_stale,
            pv.id gate_plan_version_id,pv.content_hash current_content_hash,
            ais.id gate_snapshot_id,ais.ticket_id snapshot_ticket_id,ais.plan_version_id snapshot_plan_version_id
     FROM tickets t
     LEFT JOIN plan_versions pv ON pv.id=t.approved_plan_version_id
     LEFT JOIN plans p ON p.ticket_id=t.id
     LEFT JOIN approved_input_snapshots ais ON ais.id=t.approved_input_snapshot_id
     WHERE t.id=$1`,
    [ticketId],
  )).rows[0];
  if (!row) return { valid: false, code: "ticket_not_found", message: "ticket not found" };
  if (!["Plan Approved", "Execution Queued"].includes(row.status)) {
    return { valid: false, code: "plan_approval_status_invalid", message: "the ticket must be approved or queued for execution" };
  }
  if (!row.approved_plan_version_id || !row.gate_plan_version_id) {
    return { valid: false, code: "plan_approval_required", message: "a valid approved plan version is required" };
  }
  if (row.current_version_id !== row.approved_plan_version_id) {
    return { valid: false, code: "plan_approval_stale", message: "the current plan version must be approved" };
  }
  if (!row.approved_input_snapshot_id || !row.gate_snapshot_id
    || row.snapshot_ticket_id !== row.id || row.snapshot_plan_version_id !== row.approved_plan_version_id) {
    return { valid: false, code: "approved_snapshot_mismatch", message: "the approved input snapshot does not match this ticket and plan" };
  }
  if (!row.approved_plan_hash || row.approved_plan_hash !== row.current_content_hash) {
    return { valid: false, code: "plan_hash_mismatch", message: "the approved plan hash is invalid" };
  }
  if (row.potentially_stale) {
    return { valid: false, code: "plan_potentially_stale", message: "the plan is stale and must be reconfirmed" };
  }
  return {
    valid: true,
    ticket: row,
    plan: { id: row.plan_id, current_version_id: row.current_version_id, potentially_stale: false },
    planVersion: { id: row.gate_plan_version_id, content_hash: row.current_content_hash },
  };
}
