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

function request(body: unknown, method = "POST") {
  return {
    method, headers: {}, socket: { remoteAddress: "127.0.0.1" },
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); },
  } as any;
}

beforeEach(() => {
  pool.query.mockReset();
  inTransaction.mockClear();
});

test("cancelling a ticket cancels its queued jobs, queued execution attempt, and requests cancellation of its running run", async () => {
  transactionClient = { query: vi.fn(async (sql: string) => {
    if (sql.includes("SELECT *,updated_at::text ticket_version FROM tickets")) {
      return { rows: [{ id: "ticket-1", status: "Executing", ticket_version: "v1" }] };
    }
    if (sql.includes("UPDATE tickets SET status = $2")) return { rows: [{ id: "ticket-1", status: "Cancelled" }] };
    return { rows: [], rowCount: 1 };
  }) };
  const response: any = { writeHead: vi.fn(), end: vi.fn() };

  await adminApi(request({}), response, new URL("http://test/api/admin/tickets/ticket-1/cancel"), { user_id: "admin" });

  const calls = transactionClient.query.mock.calls;
  expect(calls.some(([sql, values]: [string, unknown[]]) =>
    sql.includes("UPDATE jobs SET status='cancelled'") && sql.includes("payload_json->>'ticket_id'=$1") && values?.[0] === "ticket-1")).toBe(true);
  expect(calls.some(([sql, values]: [string, unknown[]]) =>
    sql.includes("UPDATE execution_attempts SET validation_status='cancelled'") && values?.[0] === "ticket-1")).toBe(true);
  expect(calls.some(([sql, values]: [string, unknown[]]) =>
    sql.includes("UPDATE agent_runs SET status='cancellation_requested'") && sql.includes("ticket_id=$1") && values?.[0] === "ticket-1")).toBe(true);
  expect(response.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
});

test("rejecting or archiving a ticket does not touch jobs/execution_attempts/agent_runs", async () => {
  transactionClient = { query: vi.fn(async (sql: string) => {
    if (sql.includes("SELECT *,updated_at::text ticket_version FROM tickets")) {
      return { rows: [{ id: "ticket-2", status: "Completed", ticket_version: "v1" }] };
    }
    if (sql.includes("UPDATE tickets SET status = $2")) return { rows: [{ id: "ticket-2", status: "Archived" }] };
    return { rows: [], rowCount: 1 };
  }) };
  const response: any = { writeHead: vi.fn(), end: vi.fn() };

  await adminApi(request({}), response, new URL("http://test/api/admin/tickets/ticket-2/archive"), { user_id: "admin" });

  const calls = transactionClient.query.mock.calls;
  expect(calls.some(([sql]: [string]) => sql.includes("UPDATE jobs SET status='cancelled'"))).toBe(false);
  expect(calls.some(([sql]: [string]) => sql.includes("UPDATE execution_attempts SET validation_status='cancelled'"))).toBe(false);
  expect(calls.some(([sql]: [string]) => sql.includes("UPDATE agent_runs SET status='cancellation_requested'"))).toBe(false);
});
