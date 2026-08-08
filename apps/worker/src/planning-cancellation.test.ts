import { expect, test } from "vitest";

import { finalizePlanningCancellation, isPlanningCancellation } from "./workflow-state.ts";

test("terminalizes a cancelled planning invocation as cancelled", async () => {
  let runStatus = "running";
  let ticketStatus = "Planning";
  const history: Array<{ previous: string; next: string; reason: string }> = [];
  const pool = {
    query: async (sql: string, values: unknown[]) => {
      expect(sql).toContain("UPDATE agent_runs SET status='cancelled'");
      expect(values).toEqual(["run-1", 1, "planning_cancelled", "Claude planning was cancelled"]);
      runStatus = "cancelled";
      return { rows: [], rowCount: 1 };
    },
  };
  const inTransaction = async (callback: (client: { query: (sql: string, values: unknown[]) => Promise<{ rows: any[]; rowCount: number }> }) => Promise<void>) => callback({
    query: async (sql, values) => {
      if (sql.includes("SELECT status FROM tickets")) return { rows: [{ status: ticketStatus }], rowCount: 1 };
      if (sql.includes("UPDATE tickets SET status='Cancelled'")) {
        ticketStatus = "Cancelled";
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO ticket_status_history")) {
        history.push({ previous: values[1] as string, next: "Cancelled", reason: values[2] as string });
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  });

  if (isPlanningCancellation({ cancelledBeforeStart: false, invocationCancelled: true, cancellationAborted: true, stopping: false })) {
    await finalizePlanningCancellation(pool as any, inTransaction as any, {
      runId: "run-1", ticketId: "ticket-1", jobId: "job-1", exitCode: 1,
      errorCode: "planning_cancelled", message: "Claude planning was cancelled",
    });
  }

  expect(runStatus).toBe("cancelled");
  expect(ticketStatus).toBe("Cancelled");
  expect(history).toEqual([{ previous: "Planning", next: "Cancelled", reason: "Planning cancelled" }]);
  expect(isPlanningCancellation({ cancelledBeforeStart: false, invocationCancelled: true, cancellationAborted: true, stopping: true })).toBe(false);
});
