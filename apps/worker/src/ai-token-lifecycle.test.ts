import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { createAiInvocation, recordAiUnavailable, recordAiUsage } from "@dcc/domain";

function lifecycleDb() {
  const rows = new Map<string, any>();
  return {
    rows,
    query: async (sql: string, values: any[] = []) => {
      if (sql.includes("INSERT INTO agent_runs")) {
        const [id, ticketId, projectId, pullRequestId, runType, model, reasoningLevel, provider, taskPrompt, promptSnapshotId] = values;
        const row = { id, ticket_id: ticketId, project_id: projectId, pull_request_id: pullRequestId, run_type: runType, model, reasoning_level: reasoningLevel, provider, task_prompt: taskPrompt, prompt_snapshot_id: promptSnapshotId, status: "running", ai_usage_status: "pending" };
        rows.set(id, row);
        return { rows: [row] };
      }
      if (sql.includes("ai_usage_status='captured'")) {
        const row = rows.get(values[0]);
        if (!row || row.ai_usage_status !== "pending") return { rows: [] };
        Object.assign(row, { ai_usage_status: "captured", input_tokens: values[1], output_tokens: values[2], total_tokens: values[6], raw_usage_json: values[7] });
        return { rows: [row] };
      }
      if (sql.includes("ai_usage_status='unavailable'")) {
        const row = rows.get(values[0]);
        if (!row || row.ai_usage_status !== "pending") return { rows: [] };
        row.ai_usage_status = "unavailable";
        return { rows: [row] };
      }
      if (sql.includes("SELECT * FROM agent_runs")) return { rows: [rows.get(values[0])] };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

test("persists a captured PR invocation with its durable ticket context", async () => {
  const db = lifecycleDb();
  await createAiInvocation({
    id: "run-1", ticketId: "ticket-1", projectId: "project-1", pullRequestId: "pr-1",
    runType: "pr_ai_review", model: "sonnet", reasoningLevel: "high", taskPrompt: "Review this PR", promptSnapshotId: "snapshot-1",
  }, db);
  await recordAiUsage({ runId: "run-1", inputTokens: 12, outputTokens: 8, rawUsage: { input_tokens: 12, output_tokens: 8 } }, db);

  expect(db.rows.get("run-1")).toMatchObject({
    ticket_id: "ticket-1", pull_request_id: "pr-1", status: "running", ai_usage_status: "captured",
    input_tokens: 12, output_tokens: 8, total_tokens: 20, prompt_snapshot_id: "snapshot-1",
  });
});

test("persists unavailable usage when a provider returns no normalized usage", async () => {
  const db = lifecycleDb();
  await createAiInvocation({ id: "run-2", projectId: "project-1", runType: "planning", model: "haiku", reasoningLevel: "low" }, db);
  await recordAiUnavailable("run-2", db);

  expect(db.rows.get("run-2")).toMatchObject({ status: "running", ai_usage_status: "unavailable", provider: "anthropic" });
});

test("PR worker routes use the durable pull request ticket relation", async () => {
  const worker = await readFile(new URL("./worker.ts", import.meta.url), "utf8");
  for (const route of ["runPrAiReview", "runFollowUpDescription", "runPrConflictResolution"]) {
    const source = worker.slice(worker.indexOf(`async function ${route}`));
    expect(source).toContain("ticketId: pullRequest.ticket_id");
  }
});
