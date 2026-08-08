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
    method, headers: {}, socket: { remoteAddress: "127.0.0.1" },
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); },
  } as any;
}

beforeEach(() => {
  pool.query.mockReset();
  inTransaction.mockClear();
});

const ticketPatchPath = "http://test/api/admin/tickets/ticket-1";

const ticketRow = {
  id: "ticket-1", ticket_number: "T-1", project_id: "project-1", status: "Triage",
  ai_configuration_mode: "basic",
  default_model: "sonnet", default_reasoning_level: "high",
  planning_model: null, planning_reasoning_level: null,
  execution_model: null, execution_reasoning_level: null,
  repair_model: null, repair_reasoning_level: null,
};

const projectRow = { id: "project-1", config_json: {} };

const systemAiRow = {
  default_model: "deepseek-v4-pro", default_reasoning_level: "high",
  planning_model: null, planning_reasoning_level: null,
  execution_model: null, execution_reasoning_level: null,
  repair_model: null, repair_reasoning_level: null,
};

function makeTransactionClient() {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("FROM tickets") && sql.includes("FOR UPDATE")) return { rows: [ticketRow] };
      if (sql.includes("FROM projects")) return { rows: [projectRow] };
      if (sql.includes("FROM system_ai_settings")) return { rows: [systemAiRow] };
      if (sql.includes("UPDATE tickets SET")) return { rows: [{ ...ticketRow, default_model: null }] };
      return { rows: [], rowCount: 1 };
    }),
  };
}

test("PATCHing an empty-string AI field stores SQL NULL, not the empty string", async () => {
  transactionClient = makeTransactionClient();
  const response: any = { writeHead: vi.fn(), end: vi.fn() };

  await adminApi(request({ default_model: "" }), response, new URL(ticketPatchPath), { user_id: "admin" });

  const updated = transactionClient.query.mock.calls.find(([sql]: [string]) => sql.includes("UPDATE tickets SET"));
  expect(updated).toBeTruthy();
  const [sql, values] = updated as [string, unknown[]];
  const columnIndex = sql.match(/default_model=\$(\d+)/);
  expect(columnIndex).toBeTruthy();
  const paramPosition = Number(columnIndex![1]) - 1; // values array is 0-indexed, $1 is ticket id
  expect(values[paramPosition]).toBeNull();
  expect(values).not.toContain("");
  expect(response.writeHead).not.toHaveBeenCalledWith(422, expect.anything());
});

test("PATCHing an empty-string AI field that would leave planning unresolvable still 422s", async () => {
  transactionClient = {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("FROM tickets") && sql.includes("FOR UPDATE")) return { rows: [ticketRow] };
      if (sql.includes("FROM projects")) return { rows: [projectRow] };
      if (sql.includes("FROM system_ai_settings")) return { rows: [{
        default_model: null, default_reasoning_level: null,
        planning_model: null, planning_reasoning_level: null,
        execution_model: null, execution_reasoning_level: null,
        repair_model: null, repair_reasoning_level: null,
      }] };
      return { rows: [], rowCount: 1 };
    }),
  };
  const response: any = { writeHead: vi.fn(), end: vi.fn() };

  await expect(adminApi(request({ default_model: "", default_reasoning_level: "" }), response,
    new URL(ticketPatchPath), { user_id: "admin" })).rejects.toMatchObject({ status: 422 });

  expect(transactionClient.query.mock.calls.some(([sql]: [string]) => sql.includes("UPDATE tickets SET"))).toBe(false);
});
