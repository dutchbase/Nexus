import { describe, expect, it } from "vitest";
import { checkPlanApprovalGate } from "./plan-approval.ts";

const approved = {
  id: "ticket",
  status: "Plan Approved",
  approved_plan_version_id: "version",
  approved_input_snapshot_id: "snapshot",
  gate_snapshot_id: "snapshot",
  snapshot_ticket_id: "ticket",
  snapshot_plan_version_id: "version",
  gate_plan_version_id: "version",
  current_version_id: "version",
  approved_plan_hash: "approved-hash",
  current_content_hash: "approved-hash",
  potentially_stale: false,
  plan_id: "plan",
};

function clientWith(row: Record<string, unknown> | null) {
  return { query: async () => ({ rows: row ? [row] : [] }) } as any;
}

describe("plan approval gate", () => {
  it("accepts only the current non-stale version with its approved hash", async () => {
    expect((await checkPlanApprovalGate(clientWith(approved), "ticket")).valid).toBe(true);
    expect(await checkPlanApprovalGate(clientWith({ ...approved, potentially_stale: true }), "ticket"))
      .toMatchObject({ valid: false, code: "plan_potentially_stale" });
    expect(await checkPlanApprovalGate(clientWith({ ...approved, current_content_hash: "tampered" }), "ticket"))
      .toMatchObject({ valid: false, code: "plan_hash_mismatch" });
    expect(await checkPlanApprovalGate(clientWith({ ...approved, gate_plan_version_id: null }), "ticket"))
      .toMatchObject({ valid: false, code: "plan_approval_required" });
    expect(await checkPlanApprovalGate(clientWith({ ...approved, current_version_id: "new-version" }), "ticket"))
      .toMatchObject({ valid: false, code: "plan_approval_stale" });
    expect(await checkPlanApprovalGate(clientWith({ ...approved, status: "Cancelled" }), "ticket"))
      .toMatchObject({ valid: false, code: "plan_approval_status_invalid" });
    expect(await checkPlanApprovalGate(clientWith({ ...approved, snapshot_plan_version_id: "other-version" }), "ticket"))
      .toMatchObject({ valid: false, code: "approved_snapshot_mismatch" });
  });

  it("keeps the exact approved snapshot authorized from queueing through the worker recheck", async () => {
    const rows = [approved, { ...approved, status: "Execution Queued" }];
    const client = { query: async () => ({ rows: [rows.shift()] }) } as any;

    const beforeQueue = await checkPlanApprovalGate(client, "ticket");
    const workerRecheck = await checkPlanApprovalGate(client, "ticket");

    expect(beforeQueue).toMatchObject({ valid: true, ticket: { approved_input_snapshot_id: "snapshot" } });
    expect(workerRecheck).toMatchObject({ valid: true, ticket: { approved_input_snapshot_id: "snapshot" }, planVersion: { id: "version" } });
  });
});
