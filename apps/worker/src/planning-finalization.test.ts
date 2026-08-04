import { expect, test } from "vitest";

import { finalizePlanningSuccess, recoverExpiredWorkflowState, type LeaseGuard } from "./workflow-state.ts";

type State = { job: "running" | "completed" | "failed"; ticket: string; plan: boolean; run: string };

function transaction(state: State) {
  return async (callback: (client: { query: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }> }) => Promise<unknown>) => {
    const before = structuredClone(state);
    const client = {
      query: async (sql: string, values?: unknown[]) => {
        if (sql.includes("UPDATE jobs SET status='completed'")) {
          if (state.job !== "running" || values?.[1] !== "worker") return { rows: [], rowCount: 0 };
          state.job = "completed";
          return { rows: [{ id: values?.[0] }], rowCount: 1 };
        }
        if (sql.includes("UPDATE jobs j") && sql.includes("lease_expires_at <= now()")) {
          if (state.job !== "running") return { rows: [], rowCount: 0 };
          state.job = "failed";
          return { rows: [{ id: "job", type: "planning.generate", status: "failed", payload_json: { ticket_id: "ticket" } }], rowCount: 1 };
        }
        if (sql === "INSERT plan") state.plan = true;
        if (sql === "UPDATE ticket") state.ticket = "Plan Ready for Review";
        if (sql === "UPDATE run") state.run = "completed";
        if (sql.includes("UPDATE notification_deliveries")) return { rows: [], rowCount: 0 };
        if (sql.includes("UPDATE agent_runs")) return { rows: [], rowCount: 0 };
        if (sql.includes("SELECT status FROM tickets")) return { rows: [{ status: state.ticket }], rowCount: 1 };
        if (sql.includes("UPDATE tickets SET status=$2")) state.ticket = values?.[1] as string;
        return { rows: [], rowCount: 1 };
      },
    };
    try { return await callback(client); }
    catch (error) { Object.assign(state, before); throw error; }
  };
}

const lease: LeaseGuard = { signal: new AbortController().signal, assertOwned: async () => undefined, run: async (action) => action() };

test("rolls back plan finalization before its owned job is completed", async () => {
  const state: State = { job: "running", ticket: "Planning", plan: false, run: "running" };

  await expect(finalizePlanningSuccess(transaction(state) as any, lease, { jobId: "job", workerId: "worker" }, async (client) => {
    await client.query("INSERT plan");
    await client.query("UPDATE ticket");
    await client.query("UPDATE run");
    throw new Error("pre-finalization failure");
  })).rejects.toThrow("pre-finalization failure");

  expect(state).toEqual({ job: "running", ticket: "Planning", plan: false, run: "running" });
});

test("completed planning finalization cannot be recovered into Planning Failed", async () => {
  const state: State = { job: "running", ticket: "Planning", plan: false, run: "running" };

  await finalizePlanningSuccess(transaction(state) as any, lease, { jobId: "job", workerId: "worker" }, async (client) => {
    await client.query("INSERT plan");
    await client.query("UPDATE ticket");
    await client.query("UPDATE run");
  });
  await expect(recoverExpiredWorkflowState(transaction(state) as any)).resolves.toEqual({ jobs: 0, deliveries: 0 });

  expect(state).toEqual({ job: "completed", ticket: "Plan Ready for Review", plan: true, run: "completed" });
});
