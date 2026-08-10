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

const ticket = {
  id: "ticket-1", ticket_number: "T-1", form_id: "form-1", project_id: "project-1", status: "Triage",
  custom_values_json: { retained: "value" }, ai_configuration_mode: "basic",
  default_model: "sonnet", default_reasoning_level: "high",
};

function request(body: unknown) {
  return {
    method: "PATCH", headers: {}, socket: { remoteAddress: "127.0.0.1" },
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); },
  } as any;
}

function response() {
  const result: any = { writeHead: vi.fn(), end: vi.fn() };
  return result;
}

function body(result: any) {
  return JSON.parse(result.end.mock.calls[0][0]);
}

beforeEach(() => {
  pool.query.mockReset();
  pool.query.mockResolvedValue({ rows: [
    { field_key: "source_url", field_type: "url", required: false, validation_json: {}, options_json: [] },
    { field_key: "details", field_type: "long_text", required: false, validation_json: {}, options_json: [] },
    { field_key: "screenshot", field_type: "image_upload", required: false, validation_json: {}, options_json: [] },
  ] });
  transactionClient = { query: vi.fn(async (sql: string) => {
    if (sql.includes("FROM tickets") && sql.includes("FOR UPDATE")) return { rows: [ticket] };
    if (sql.includes("FROM projects")) return { rows: [{ id: "project-1", config_json: {} }] };
    if (sql.includes("FROM system_ai_settings")) return { rows: [{ default_model: "sonnet", default_reasoning_level: "high" }] };
    if (sql.includes("UPDATE tickets SET")) return { rows: [{ ...ticket, source_url: "https://example.test/report", custom_values_json: { retained: "value", details: "Saved detail" } }] };
    return { rows: [], rowCount: 1 };
  }) };
});

test("PATCH submission saves allowed source values without changing attachments", async () => {
  const result = response();

  await adminApi(request({ submission: { source_url: "https://example.test/report", details: "Saved detail" } }), result,
    new URL("http://test/api/admin/tickets/ticket-1"), { user_id: "admin" });

  expect(result.writeHead).toHaveBeenCalledWith(200, expect.anything());
  expect(body(result).ticket.custom_values_json).toEqual({ retained: "value", details: "Saved detail" });
  const update = transactionClient.query.mock.calls.find(([sql]: [string]) => sql.includes("UPDATE tickets SET"));
  expect(update[0]).toContain("source_url=$2");
  expect(update[1]).toContain("https://example.test/report");
  expect(update[1]).toContainEqual({ retained: "value", details: "Saved detail" });
  expect(transactionClient.query.mock.calls.some(([sql]: [string]) => sql.includes("attachments"))).toBe(false);
});

test("PATCH submission rejects invalid source URL and unknown keys", async () => {
  for (const [submission, fields] of [
    [{ source_url: "not a URL" }, { source_url: "invalid URL" }],
    [{ unknown: "value" }, { unknown: "unknown field" }],
  ] as const) {
    const result = response();

    await adminApi(request({ submission }), result, new URL("http://test/api/admin/tickets/ticket-1"), { user_id: "admin" });

    expect(result.writeHead).toHaveBeenCalledWith(400, expect.anything());
    expect(body(result)).toEqual({ error: "validation failed", fields });
    expect(transactionClient.query.mock.calls.some(([sql]: [string]) => sql.includes("UPDATE tickets SET"))).toBe(false);
  }
});
