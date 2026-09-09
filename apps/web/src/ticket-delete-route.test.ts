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

function request(method = "DELETE") {
  return {
    method, headers: {}, socket: { remoteAddress: "127.0.0.1" },
    async *[Symbol.asyncIterator]() { yield Buffer.from("{}"); },
  } as any;
}

const url = () => new URL("http://test/api/admin/tickets/DCC-1");

beforeEach(() => { pool.query.mockReset(); inTransaction.mockClear(); });

test("deletes a Triage ticket in one transaction and audits it", async () => {
  transactionClient = { query: vi.fn(async (sql: string) => {
    if (sql.includes("SELECT * FROM tickets")) return { rows: [{ id: "ticket-1", ticket_number: "DCC-1", status: "Triage" }] };
    return { rows: [], rowCount: 1 };
  }) };
  const response: any = { writeHead: vi.fn(), end: vi.fn() };

  await adminApi(request(), response, url(), { user_id: "admin" });

  const calls = transactionClient.query.mock.calls;
  expect(calls.some(([sql, values]: [string, unknown[]]) =>
    sql.includes("DELETE FROM tickets WHERE id=$1") && values?.[0] === "ticket-1")).toBe(true);
  expect(calls.some(([sql, values]: [string, unknown[]]) =>
    sql.includes("INSERT INTO audit_events") && values?.[2] === "ticket.delete")).toBe(true);
  expect(response.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
});

test("404s for an unknown ticket without deleting anything", async () => {
  transactionClient = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
  const response: any = { writeHead: vi.fn(), end: vi.fn() };

  await adminApi(request(), response, url(), { user_id: "admin" });

  expect(transactionClient.query.mock.calls.some(([sql]: [string]) => sql.includes("DELETE FROM tickets"))).toBe(false);
  expect(response.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
});

test("refuses to delete a ticket that has moved past intake", async () => {
  transactionClient = { query: vi.fn(async (sql: string) => {
    if (sql.includes("SELECT * FROM tickets")) return { rows: [{ id: "ticket-1", ticket_number: "DCC-1", status: "Executing" }] };
    return { rows: [], rowCount: 1 };
  }) };
  const response: any = { writeHead: vi.fn(), end: vi.fn() };

  await expect(adminApi(request(), response, url(), { user_id: "admin" }))
    .rejects.toMatchObject({ status: 409, code: "ticket_not_deletable" });
  expect(transactionClient.query.mock.calls.some(([sql]: [string]) => sql.includes("DELETE FROM tickets"))).toBe(false);
});

test("maps a foreign-key violation to a 409 instead of a 500", async () => {
  transactionClient = { query: vi.fn(async (sql: string) => {
    if (sql.includes("SELECT * FROM tickets")) return { rows: [{ id: "ticket-1", ticket_number: "DCC-1", status: "Cancelled" }] };
    if (sql.includes("DELETE FROM tickets")) throw Object.assign(new Error("update or delete on table \"tickets\" violates foreign key constraint"), { code: "23503" });
    return { rows: [], rowCount: 1 };
  }) };
  const response: any = { writeHead: vi.fn(), end: vi.fn() };

  await adminApi(request(), response, url(), { user_id: "admin" });

  expect(response.writeHead).toHaveBeenCalledWith(409, expect.any(Object));
  expect(String(response.end.mock.calls[0][0])).toContain("ticket_has_dependents");
});
