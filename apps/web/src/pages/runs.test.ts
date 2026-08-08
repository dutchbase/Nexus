import { beforeEach, expect, test, vi } from "vitest";

const query = vi.fn();
vi.mock("@dcc/database", () => ({ inTransaction: vi.fn(), pool: { query } }));

const runs = await import("./runs.ts");
const session = { username: "admin", user_id: "admin" };

const run = {
  id: "aaaaaaaa-0000-4000-8000-000000000002", ticket_id: "ticket-1", ticket_number: "T-1", project_name: "Project",
  run_type: "execution", model: "sonnet", reasoning_level: "high", status: "completed",
  metadata_json: {}, error_code: null, error_message: null, started_at: "2026-08-04T10:00:00Z",
  finished_at: "2026-08-04T10:05:00Z", claude_session_id: null, working_directory: null,
  ticket_status: "Completed",
};

beforeEach(() => query.mockReset());

// PRD G10-F04: execution_attempts.agent_run_id is mutated (last-writer-wins)
// by worker.ts on every retry of the same execution_attempt_id, while each
// retry's artifacts row keeps its OWN, never-updated agent_run_id. The
// attempt-log list must link through the artifact's own run id, or repeated
// attempts on one execution_attempt_id collapse onto the same (latest) log.
test("attempt-log list links each artifact to its own run, not the latest shared run", async () => {
  query.mockImplementation(async (sql: string) => {
    if (!sql) return { rows: [] };
    if (sql.includes("FROM agent_runs ar")) return { rows: [run] };
    if (sql.includes("FROM artifacts a JOIN execution_attempts ea")) {
      return {
        rows: [
          { id: "artifact-2", execution_attempt_id: "attempt-1", agent_run_id: "aaaaaaaa-0000-4000-8000-000000000002", attempt_number: 1, status: "staged", created_at: "2026-08-04T10:02:00Z" },
          { id: "artifact-1", execution_attempt_id: "attempt-1", agent_run_id: "aaaaaaaa-0000-4000-8000-000000000001", attempt_number: 1, status: "staged", created_at: "2026-08-04T10:00:00Z" },
        ],
      };
    }
    return { rows: [] };
  });

  const page = await runs.render(new URL("http://test/admin/runs/aaaaaaaa-0000-4000-8000-000000000002"), session, {});

  expect(page?.body).toContain("/api/admin/runs/aaaaaaaa-0000-4000-8000-000000000002/log");
  expect(page?.body).toContain("/api/admin/runs/aaaaaaaa-0000-4000-8000-000000000001/log");
});

// The download route only serves artifacts with status IN ('staged',
// 'finalized'); an 'abandoned' row would render a dead link if it leaked
// into this list.
test("attempt-log list excludes abandoned artifacts", async () => {
  query.mockImplementation(async (sql: string) => {
    if (!sql) return { rows: [] };
    if (sql.includes("FROM agent_runs ar")) return { rows: [run] };
    if (sql.includes("FROM artifacts a JOIN execution_attempts ea")) {
      expect(sql).toContain("a.status IN ('staged','finalized')");
      return { rows: [] };
    }
    throw new Error(`unexpected query: ${sql}`);
  });

  await runs.render(new URL("http://test/admin/runs/aaaaaaaa-0000-4000-8000-000000000002"), session, {});
});

test("run detail escapes and retains captured prompts and accounting", async () => {
  query.mockImplementation(async (sql: string) => {
    if (String(sql).includes("FROM agent_runs ar")) return { rows: [{ ...run,
      ai_usage_status: "captured", input_tokens: 10, output_tokens: 20, reasoning_tokens: 8, cache_read_tokens: 2, cache_write_tokens: 3, total_tokens: 35,
      estimated_cost_usd: "0.00001234", task_prompt: "<task>", rendered_prompt: "<rendered>", prompt_name: "execution", prompt_version: 3,
      price_source_url: "https://example.test/prices", input_usd_per_million: "3", output_usd_per_million: "15", cache_read_usd_per_million: "0.3", cache_write_usd_per_million: "3.75",
    }] };
    if (String(sql).includes("FROM artifacts a JOIN execution_attempts ea")) return { rows: [] };
    return { rows: [] };
  });

  const page = await runs.render(new URL("http://test/admin/runs/aaaaaaaa-0000-4000-8000-000000000002"), session, {});

  expect(page?.body).toContain("Usage accounting");
  expect(page?.body).toContain("$0.00001234");
  expect(page?.body).toContain("&lt;task&gt;");
  expect(page?.body).toContain("&lt;rendered&gt;");
  expect(page?.body).toContain("<details>");
});
