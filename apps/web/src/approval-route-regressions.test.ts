import { beforeEach, expect, test, vi } from "vitest";

process.env.DCC_PROCESS_ROLE = "web";

const pool = { query: vi.fn() };
let transactionClient: any;
const inTransaction = vi.fn(async (callback: (client: any) => unknown) => callback(transactionClient));
vi.mock("@dcc/database", () => ({
  artifactDataRoot: () => "/primary", legacyArtifactDataRoot: () => "/legacy",
  finalizeArtifact: vi.fn(), inTransaction, pool,
  readArtifact: vi.fn(), readStagedArtifact: vi.fn(), stageArtifact: vi.fn(),
}));

const { adminApi } = await import("./server.ts");

function request(body: unknown, method = "PATCH") {
  return {
    method, headers: {},
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); },
  } as any;
}

beforeEach(() => {
  pool.query.mockReset();
  inTransaction.mockClear();
});

test.each(["Rejected", "Plan Approved"])("generic ticket PATCH rejects raw %s transitions", async (status) => {
  const response: any = { writeHead: vi.fn(), end: vi.fn() };
  await adminApi(request({ status }), response, new URL("http://test/api/admin/tickets/ticket"), { user_id: "admin" });
  expect(response.writeHead).toHaveBeenCalledWith(422, expect.any(Object));
  expect(response.end).toHaveBeenCalledWith(JSON.stringify({ error: "status must use its decision endpoint" }));
});

test("generic ticket PATCH cannot forge the worker-authorized queued status", async () => {
  const response: any = { writeHead: vi.fn(), end: vi.fn() };
  await adminApi(request({ status: "Execution Queued" }), response, new URL("http://test/api/admin/tickets/ticket"), { user_id: "admin" });
  expect(response.writeHead).toHaveBeenCalledWith(422, expect.any(Object));
  expect(response.end).toHaveBeenCalledWith(JSON.stringify({ error: "status cannot be set manually" }));
});

test("execution queueing binds the job to the exact approved input snapshot", async () => {
  const approvedInput = {
    plan: { versionId: "plan-version", version: 1, contentHash: "plan-hash" },
    ticket: { title: "Approved title" },
    project: { configVersion: 1, config: {} }, models: {}, prompts: [], skills: [], policySources: [],
  };
  const { materialInput, inputHash } = (await import("@dcc/domain")).buildApprovedInputSnapshot(approvedInput as any);
  const gateRow = {
    id: "ticket", status: "Plan Approved", approved_plan_version_id: "plan-version",
    approved_input_snapshot_id: "approved-input-1", gate_snapshot_id: "approved-input-1",
    snapshot_ticket_id: "ticket", snapshot_plan_version_id: "plan-version",
    snapshot_material_input: materialInput, snapshot_input_hash: inputHash,
    gate_plan_version_id: "plan-version", current_version_id: "plan-version",
    approved_plan_hash: "plan-hash", current_content_hash: "plan-hash", potentially_stale: false, plan_id: "plan",
  };
  pool.query.mockImplementation(async (sql: string) => sql.includes("id::text=$1")
    ? { rows: [{ id: "ticket" }] }
    : { rows: [gateRow] });
  transactionClient = { query: vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes("FROM tickets t")) return { rows: [{ ...gateRow, status: "Plan Approved" }] };
    if (sql.includes("max(attempt_number)")) return { rows: [{ next: 1 }] };
    if (sql.includes("FROM execution_attempts")) return { rows: [], rowCount: 0 };
    if (sql.includes("INSERT INTO execution_attempts")) return { rows: [{ id: "attempt-1" }] };
    if (sql.includes("INSERT INTO jobs")) return { rows: [{ id: "job-1", payload_json: values?.[2] }] };
    return { rows: [], rowCount: 1 };
  }) };
  const response: any = { writeHead: vi.fn(), end: vi.fn() };

  await adminApi(request({}, "POST"), response, new URL("http://test/api/admin/tickets/ticket/execute"), { user_id: "admin" });

  const queued = transactionClient.query.mock.calls.find(([sql]: [string]) => sql.includes("INSERT INTO jobs"));
  expect(queued[1][2]).toMatchObject({ approved_input_snapshot_id: "approved-input-1" });
  expect(response.writeHead).toHaveBeenCalledWith(202, expect.any(Object));
});

test("repair queueing keeps the originating execution snapshot binding", async () => {
  transactionClient = { query: vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes("FROM agent_runs ar")) return { rows: [{
      id: "a1", ticket_id: "ticket", execution_attempt_id: "attempt-1",
      plan_version_id: "plan-version", validation_status: "failed", worktree_path: "/worktree",
      ticket_status: "Execution Failed", metadata_json: { approved_input_snapshot_id: "approved-input-1" },
    }] };
    if (sql.includes("FROM jobs")) return { rows: [], rowCount: 0 };
    if (sql.includes("INSERT INTO jobs")) return { rows: [{ id: "repair-job", payload_json: values?.[2] }] };
    return { rows: [], rowCount: 1 };
  }) };
  const response: any = { writeHead: vi.fn(), end: vi.fn() };

  await adminApi(request({ feedback: "Repair the failed validation." }, "POST"), response,
    new URL("http://test/api/admin/runs/a1/repair"), { user_id: "admin" });

  const queued = transactionClient.query.mock.calls.find(([sql]: [string]) => sql.includes("INSERT INTO jobs"));
  expect(queued[1][2]).toMatchObject({ approved_input_snapshot_id: "approved-input-1" });
  expect(response.writeHead).toHaveBeenCalledWith(202, expect.any(Object));
});

test.each([
  ["ai-review", "review-1", "pr_ai_reviews"],
  ["resolve-conflicts", "resolution-1", "pr_conflict_resolutions"],
])("%s returns the existing active attempt", async (action, attemptId, table) => {
  pool.query.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM pull_requests pr")) return { rows: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }] };
    if (sql.includes("ai_review_settings")) return { rows: [{ default_model: "sonnet", default_reasoning_level: "high" }] };
    return { rows: [] };
  });
  transactionClient = { query: vi.fn(async (sql: string) => {
    if (sql.includes("SELECT id FROM pull_requests") && sql.includes("FOR UPDATE")) return { rows: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }] };
    if (sql.includes(`FROM ${table}`)) return { rows: [{ id: attemptId, job_id: "job-1", job_status: "running" }] };
    throw new Error(`unexpected query: ${sql}`);
  }) };
  const response: any = { writeHead: vi.fn(), end: vi.fn() };

  await adminApi(request({}, "POST"), response,
    new URL(`http://test/api/admin/pull-requests/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/${action}`), { user_id: "admin" });

  expect(response.end).toHaveBeenCalledWith(JSON.stringify({ id: attemptId }));
  expect(transactionClient.query).toHaveBeenCalledWith(
    expect.stringContaining("SELECT id FROM pull_requests WHERE id=$1 FOR UPDATE"),
    ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
  );
  expect(transactionClient.query.mock.calls.some(([sql]: [string]) => sql.includes(`INSERT INTO ${table}`))).toBe(false);
});

test.each([
  ["ai-review", "old-review", "pr_ai_reviews"],
  ["resolve-conflicts", "old-resolution", "pr_conflict_resolutions"],
])("%s prioritizes an older active attempt over newer terminal history", async (action, activeId, table) => {
  pool.query.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM pull_requests pr")) return { rows: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }] };
    if (sql.includes("ai_review_settings")) return { rows: [{ default_model: "sonnet", default_reasoning_level: "high" }] };
    return { rows: [] };
  });
  transactionClient = { query: vi.fn(async (sql: string) => {
    if (sql.includes("SELECT id FROM pull_requests")) return { rows: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }] };
    if (sql.includes(`FROM ${table}`)) {
      if (!sql.includes("CASE WHEN j.status IN ('queued','running') THEN 0 ELSE 1 END")) return { rows: [{ id: "new-terminal", job_id: "terminal-job", job_status: "failed" }] };
      return { rows: [{ id: activeId, job_id: "active-job", job_status: "running" }] };
    }
    throw new Error(`unexpected query: ${sql}`);
  }) };
  const response: any = { writeHead: vi.fn(), end: vi.fn() };

  await adminApi(request({}, "POST"), response,
    new URL(`http://test/api/admin/pull-requests/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/${action}`), { user_id: "admin" });

  expect(response.end).toHaveBeenCalledWith(JSON.stringify({ id: activeId }));
  expect(transactionClient.query.mock.calls.some(([sql]: [string]) => sql.includes(`INSERT INTO ${table}`))).toBe(false);
});

test.each([
  ["ai-review", "pr_ai_reviews", "pr_ai_review_id", "pr.ai_review"],
  ["resolve-conflicts", "pr_conflict_resolutions", "pr_conflict_resolution_id", "pr.conflict_resolution"],
])("%s creates a linked single-attempt rerun after terminal history", async (action, table, payloadKey, jobType) => {
  pool.query.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM pull_requests pr")) return { rows: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }] };
    if (sql.includes("ai_review_settings")) return { rows: [{ default_model: "sonnet", default_reasoning_level: "high" }] };
    return { rows: [] };
  });
  transactionClient = { query: vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes("SELECT id FROM pull_requests") && sql.includes("FOR UPDATE")) return { rows: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }] };
    if (sql.includes(`FROM ${table}`)) return { rows: [{ id: "old-attempt", job_id: "old-job", job_status: "failed" }] };
    if (sql.includes(`INSERT INTO ${table}`)) return { rows: [{ id: "new-attempt" }] };
    if (sql.includes("SELECT 1 FROM jobs")) return { rows: [{}], rowCount: 1 };
    if (sql.includes("INSERT INTO jobs")) return { rows: [{ id: "new-job", type: jobType, payload_json: values?.[2], rerun_of: values?.[6] }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  }) };
  const response: any = { writeHead: vi.fn(), end: vi.fn() };

  await adminApi(request({}, "POST"), response,
    new URL(`http://test/api/admin/pull-requests/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/${action}`), { user_id: "admin" });

  const queued = transactionClient.query.mock.calls.find(([sql]: [string]) => sql.includes("INSERT INTO jobs"));
  expect(queued[1][2]).toMatchObject({ [payloadKey]: "new-attempt" });
  expect(queued[1][4]).toBe(1);
  expect(queued[1][6]).toBe("old-job");
  expect(response.end).toHaveBeenCalledWith(JSON.stringify({ id: "new-attempt" }));
});

test.each([
  ["/api/admin/runs/a1/repair", "execution.repair"],
  ["/api/admin/runs/a1/retry", "pull-request.retry"],
])("%s links its retry to the source run job", async (path, jobType) => {
  transactionClient = { query: vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes("FROM agent_runs ar")) return { rows: [{
      id: "attempt-1", run_id: "a1", ticket_id: "ticket", execution_attempt_id: "attempt-1",
      plan_version_id: "plan-version", validation_status: "failed", worktree_path: "/worktree",
      result_commit: "commit", ticket_status: path.endsWith("/retry") ? "PR Creation Failed" : "Execution Failed",
      publication_id: path.endsWith("/retry") ? "publication-1" : undefined,
      publication_status: path.endsWith("/retry") ? "failed" : undefined,
      publication_idempotency_key: path.endsWith("/retry") ? "execution-publication:attempt-1" : undefined,
      metadata_json: { job_id: "source-job", approved_input_snapshot_id: "approved-input-1" },
    }] };
    if (sql.includes("FROM jobs WHERE status IN")) return { rows: [], rowCount: 0 };
    if (sql.includes("SELECT status FROM jobs")) return { rows: [{ status: "failed" }], rowCount: 1 };
    if (sql.includes("SELECT 1 FROM jobs")) return { rows: [{}], rowCount: 1 };
    if (sql.includes("INSERT INTO jobs")) return { rows: [{ id: "new-job", type: jobType, rerun_of: values?.[6] }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  }) };
  const response: any = { writeHead: vi.fn(), end: vi.fn() };

  await adminApi(request({ feedback: "Repair it." }, "POST"), response, new URL(`http://test${path}`), { user_id: "admin" });

  const queued = transactionClient.query.mock.calls.find(([sql]: [string]) => sql.includes("INSERT INTO jobs"));
  expect(queued[1][6]).toBe("source-job");
});

test.each([
  "/api/admin/runs/a1/repair",
  "/api/admin/runs/a1/retry",
])("%s refuses a rerun while the source job is still active", async (path) => {
  transactionClient = { query: vi.fn(async (sql: string) => {
    if (sql.includes("FROM agent_runs ar")) return { rows: [{
      id: "attempt-1", run_id: "a1", ticket_id: "ticket", execution_attempt_id: "attempt-1",
      plan_version_id: "plan-version", validation_status: "failed", worktree_path: "/worktree",
      result_commit: "commit", ticket_status: path.endsWith("/retry") ? "PR Creation Failed" : "Execution Failed",
      publication_id: path.endsWith("/retry") ? "publication-1" : undefined,
      publication_status: path.endsWith("/retry") ? "failed" : undefined,
      publication_idempotency_key: path.endsWith("/retry") ? "execution-publication:attempt-1" : undefined,
      metadata_json: { job_id: "source-job", approved_input_snapshot_id: "approved-input-1" },
    }] };
    if (sql.includes("FROM jobs WHERE status IN")) return { rows: [], rowCount: 0 };
    if (sql.includes("SELECT status FROM jobs")) return { rows: [{ status: "running" }], rowCount: 1 };
    if (sql.includes("SELECT 1 FROM jobs")) return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 1 };
  }) };
  const response: any = { writeHead: vi.fn(), end: vi.fn() };

  await expect(adminApi(request({ feedback: "Repair it." }, "POST"), response, new URL(`http://test${path}`), { user_id: "admin" }))
    .rejects.toMatchObject({ status: 409 });
});

test("publication retry requires a failed durable publication", async () => {
  transactionClient = { query: vi.fn(async (sql: string) => {
    if (sql.includes("FROM agent_runs ar")) return { rows: [{
      id: "attempt-1", run_id: "a1", ticket_id: "ticket", plan_version_id: "plan-version",
      result_commit: "commit", ticket_status: "PR Creation Failed", metadata_json: { job_id: "source-job" },
      publication_id: "publication-1", publication_status: "pending",
      publication_idempotency_key: "execution-publication:attempt-1",
    }] };
    return { rows: [], rowCount: 0 };
  }) };
  const response: any = { writeHead: vi.fn(), end: vi.fn() };

  await expect(adminApi(request({}, "POST"), response, new URL("http://test/api/admin/runs/a1/retry"), { user_id: "admin" }))
    .rejects.toMatchObject({ status: 409 });
  expect(transactionClient.query.mock.calls.some(([sql]: [string]) => sql.includes("INSERT INTO jobs"))).toBe(false);
});

test("publication retry resets the same intent without changing its external key", async () => {
  transactionClient = { query: vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes("FROM agent_runs ar")) return { rows: [{
      id: "attempt-1", run_id: "a1", ticket_id: "ticket", plan_version_id: "plan-version",
      result_commit: "commit", ticket_status: "PR Creation Failed", metadata_json: { job_id: "source-job" },
      publication_id: "publication-1", publication_status: "failed",
      publication_idempotency_key: "execution-publication:attempt-1",
    }] };
    if (sql.includes("SELECT status FROM jobs")) return { rows: [{ status: "failed" }], rowCount: 1 };
    if (sql.includes("INSERT INTO jobs")) return { rows: [{ id: "retry-job" }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  }) };
  const response: any = { writeHead: vi.fn(), end: vi.fn() };

  await adminApi(request({}, "POST"), response, new URL("http://test/api/admin/runs/a1/retry"), { user_id: "admin" });

  const reset = transactionClient.query.mock.calls.find(([sql]: [string]) => sql.includes("UPDATE execution_publications"));
  expect(reset?.[0]).toContain("status='pending'");
  expect(reset?.[0]).not.toContain("idempotency_key");
  expect(reset?.[1]).toContain("publication-1");
  expect(response.writeHead).toHaveBeenCalledWith(202, expect.any(Object));
});
