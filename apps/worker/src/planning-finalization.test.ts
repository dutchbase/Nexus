import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";

import {
  finalizePlanningFailure, finalizePlanningSuccess, initializePlanningAttempt, recoverExpiredWorkflowState, type LeaseGuard,
} from "./workflow-state.ts";

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
        if (sql === "START run") state.run = "running";
        if (sql === "START ticket") state.ticket = "Planning";
        if (sql === "FAIL run") state.run = "failed";
        if (sql === "FAIL ticket") state.ticket = "Planning Failed";
        if (sql.includes("UPDATE jobs SET status='failed'")) {
          if (state.job !== "running") return { rows: [], rowCount: 0 };
          state.job = "failed";
          return { rows: [{ id: "job" }], rowCount: 1 };
        }
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

test("rolls back planning setup when its transition fails", async () => {
  const state: State = { job: "running", ticket: "Planning Queued", plan: false, run: "none" };

  await expect(initializePlanningAttempt(transaction(state) as any, lease, async (client) => {
    await client.query("START run");
    await client.query("START ticket");
    throw new Error("planning setup failed");
  })).rejects.toThrow("planning setup failed");

  expect(state).toEqual({ job: "running", ticket: "Planning Queued", plan: false, run: "none" });
});

test.each(["planning_failed", "planning_timeout"])("finalizes %s and its job atomically", async () => {
  const state: State = { job: "running", ticket: "Planning", plan: false, run: "running" };

  await finalizePlanningFailure(transaction(state) as any, lease, { jobId: "job", workerId: "worker", message: "planning failed" }, async (client) => {
    await client.query("FAIL run");
    await client.query("FAIL ticket");
  });

  expect(state).toEqual({ job: "failed", ticket: "Planning Failed", plan: false, run: "failed" });
});

test("rolls back a failed planning finalization before changing its job", async () => {
  const state: State = { job: "running", ticket: "Planning", plan: false, run: "running" };

  await expect(finalizePlanningFailure(transaction(state) as any, lease, { jobId: "job", workerId: "worker", message: "planning failed" }, async (client) => {
    await client.query("FAIL run");
    await client.query("FAIL ticket");
    throw new Error("notification failed");
  })).rejects.toThrow("notification failed");

  expect(state).toEqual({ job: "running", ticket: "Planning", plan: false, run: "running" });
});

test("binds planning failure history's previous status and terminal references", async () => {
  const worker = await readFile(new URL("./worker.ts", import.meta.url), "utf8");

  expect(worker).toContain("VALUES ($1,$2,'Planning Failed',$3,'worker',$4,$5)");
  expect(worker).toContain("[ticket.id, current.status, `Planning job failed: ${message.slice(0, 500)}`, job.id, runId]");
});

test("captures truncated raw stdout from a failed planning invocation into agent_runs metadata", async () => {
  const worker = await readFile(new URL("./worker.ts", import.meta.url), "utf8");

  expect(worker).toContain("(error as any)?.stdout");
  expect(worker).toContain("raw_stdout_on_failure");
});

test("classifies a cancelled planning run separately from a failed one", async () => {
  const worker = await readFile(new URL("./worker.ts", import.meta.url), "utf8");
  const planning = worker.slice(worker.indexOf("async function runPlanning"), worker.indexOf("async function runExecution"));

  // Cancellation must not route through finalizePlanningFailure (which hard-codes jobs.status='failed').
  // The stateful terminal outcome is covered by planning-cancellation.test.ts.
  expect(planning).toContain("isPlanningCancellation({");

  // The outer job-loop catch must recognize planning_cancelled the same way it already
  // recognizes execution_cancelled, so the job row lands on 'cancelled' not 'failed'.
  const jobLoop = worker.slice(worker.indexOf("if (job.type === \"project.validate\")"));
  expect(jobLoop).toContain("error.code === \"execution_cancelled\" || error.code === \"planning_cancelled\"");
});

test("transitionToPlanning refuses to un-cancel a ticket cancelled before planning started", async () => {
  const worker = await readFile(new URL("./worker.ts", import.meta.url), "utf8");
  const transition = worker.slice(worker.indexOf("async function transitionToPlanning"), worker.indexOf("async function storePlan"));

  expect(transition).toContain('if (ticket.status === "Cancelled") throw');
  expect(transition).toContain('code: "ticket_cancelled_before_planning"');

  // Ordering is the whole point: the guard has to run BEFORE the UPDATE, so the throw rolls the
  // initializePlanningAttempt transaction back instead of leaving the ticket flipped to Planning.
  expect(transition.indexOf('ticket.status === "Cancelled"'))
    .toBeLessThan(transition.indexOf("UPDATE tickets SET status='Planning'"));
});

test("distinguishes a real cancellation from a worker shutdown and from a genuine planning failure", async () => {
  const worker = await readFile(new URL("./worker.ts", import.meta.url), "utf8");
  const planning = worker.slice(worker.indexOf("async function runPlanning"), worker.indexOf("async function runExecution"));

  // transitionToPlanning's sentinel is a plain Error, so it is classified via its own flag only.
  expect(planning).toContain('const cancelledBeforeStart = (error as any)?.code === "ticket_cancelled_before_planning";');

  // A SIGTERM/lease loss aborts the same AbortSignal.any([...]) a real cancellation does, so the
  // invocation-level code alone is not trusted — the poll's own controller must have fired.
  expect(planning).toContain("const invocationCancelled = (error instanceof ClaudePlanningError && error.code === \"planning_cancelled\")");

  // The stateful cancellation test verifies that the shared classifier rejects a shutdown
  // even though the invocation cancellation signal fired.

  // `stopping` has to be the module-level shutdown flag those handlers set, not a local.
  expect(worker).toContain("let stopping = false;");
  expect(worker).toContain("stopping = true; activeExecutionCancellation?.abort(); activePlanningCancellation?.abort();");

  // A genuine (non-cancelled) OpenCode/DeepSeek failure must keep the generic "planning_failed"
  // code the ticket page's failure banner gates on, not leak the raw OpenCode code.
  // errorCode must be derived FROM `cancelled`, so an abort that is not treated as a cancellation
  // can never still report the ambiguous "planning_cancelled" code.
  expect(planning.indexOf("const cancelled =")).toBeLessThan(planning.indexOf("const errorCode ="));
  expect(planning).toContain('const errorCode = cancelled ? "planning_cancelled"');

  // Both engines fall back to the generic "planning_failed" the ticket page's failure banner gates
  // on when the run was NOT cancelled — Claude's ambiguous cancel code included, and every OpenCode
  // code (opencode_failed / opencode_no_output / opencode_timeout), which is Bug 2's regression.
  expect(planning).toContain('error instanceof ClaudePlanningError ? (error.code === "planning_cancelled" ? "planning_failed" : error.code)');
  expect(planning).toContain('error instanceof OpenCodeError ? "planning_failed"');
});

test("the outer job loop marks a pre-planning cancellation's job cancelled, not failed", async () => {
  const worker = await readFile(new URL("./worker.ts", import.meta.url), "utf8");
  const jobLoop = worker.slice(worker.indexOf("if (job.type === \"project.validate\")"));

  expect(jobLoop).toContain('|| (error as any)?.code === "ticket_cancelled_before_planning"');
  expect(jobLoop.indexOf('ticket_cancelled_before_planning'))
    .toBeLessThan(jobLoop.indexOf("UPDATE jobs SET status='cancelled'"));
});

test("storePlan and storeRevisedPlan never overwrite a ticket that was cancelled mid-flight", async () => {
  const worker = await readFile(new URL("./worker.ts", import.meta.url), "utf8");
  const storePlan = worker.slice(worker.indexOf("async function storePlan"), worker.indexOf("async function storeRevisedPlan"));
  const storeRevisedPlan = worker.slice(worker.indexOf("async function storeRevisedPlan"), worker.indexOf("async function runPlanning"));

  for (const fn of [storePlan, storeRevisedPlan]) {
    expect(fn).toContain('if (ticket.status !== "Cancelled") {');
  }
});
