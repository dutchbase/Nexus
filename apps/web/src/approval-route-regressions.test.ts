import { expect, test, vi } from "vitest";

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
