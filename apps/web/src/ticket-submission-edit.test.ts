import { beforeEach, expect, test, vi } from "vitest";

process.env.DCC_PROCESS_ROLE = "web";

const pool = { query: vi.fn() };
let transactionClient: any;
let formFields: any[];
let existingAttachments: any[];
const inTransaction = vi.fn(async (callback: (client: any) => unknown) => callback(transactionClient));
vi.mock("@dcc/database", () => ({
  artifactDataRoot: () => "/primary", legacyArtifactDataRoot: () => "/legacy",
  finalizeArtifact: vi.fn(), inTransaction, pool,
  readArtifact: vi.fn(), readStagedArtifact: vi.fn(), stageArtifact: vi.fn(),
}));

const { adminApi } = await import("./server.ts");

const ticket = {
  id: "ticket-1", ticket_number: "T-1", form_id: "form-1", project_id: "project-1", status: "Triage",
  title: "Saved title", description: "Saved description",
  custom_values_json: { retained: "value" }, ai_configuration_mode: "basic",
  default_model: "sonnet", default_reasoning_level: "high",
};

function request(body: unknown, method = "PATCH") {
  return {
    method, headers: {}, socket: { remoteAddress: "127.0.0.1" },
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
  formFields = [
    { field_key: "title", field_type: "short_text", required: true, validation_json: {}, options_json: [] },
    { field_key: "description", field_type: "long_text", required: true, validation_json: {}, options_json: [] },
    { field_key: "source_url", field_type: "url", required: false, validation_json: {}, options_json: [] },
    { field_key: "details", field_type: "long_text", required: false, validation_json: {}, options_json: [] },
    { field_key: "screenshot", field_type: "image_upload", required: false, validation_json: {}, options_json: [] },
  ];
  existingAttachments = [];
  pool.query.mockImplementation(async (sql: string) => sql.includes("SELECT id FROM projects")
    ? { rows: [{ id: "project-1" }] } : { rows: formFields });
  transactionClient = { query: vi.fn(async (sql: string) => {
    if (sql.includes("FROM users") && sql.includes("FOR UPDATE")) return { rows: [{ role: "admin", is_active: true }] };
    if (sql.includes("FROM tickets") && sql.includes("FOR UPDATE")) return { rows: [ticket] };
    if (sql.includes("FROM projects")) return { rows: [{ id: "project-1", config_json: {} }] };
    if (sql.includes("FROM system_ai_settings")) return { rows: [{ default_model: "sonnet", default_reasoning_level: "high" }] };
    if (sql.includes("SELECT upload_id,field_key FROM attachments")) return { rows: existingAttachments };
    if (sql.includes("UPDATE tickets SET")) return { rows: [{ ...ticket, source_url: "https://example.test/report", custom_values_json: { retained: "value", details: "Saved detail" } }] };
    return { rows: [], rowCount: 1 };
  }) };
});

test("POST claims validated screenshot uploads in the ticket transaction", async () => {
  const uploadId = "22222222-2222-4222-8222-222222222222";
  const fallback = transactionClient.query.getMockImplementation();
  transactionClient.query.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (sql.includes("nextval")) return { rows: [{ number: 42 }] };
    if (sql.includes("INSERT INTO tickets")) return { rows: [{ ...ticket, id: "created", project_id: "project-1" }] };
    if (sql.includes("ticket_id IS NULL FOR UPDATE")) return { rows: [{ upload_id: uploadId }] };
    if (sql.includes("SELECT a.upload_id FROM attachments")) return { rows: [{ upload_id: uploadId }] };
    return fallback!(sql, params);
  });
  const result = response();

  await adminApi(request({ project_id: "project-1", title: "New", description: "Ticket", attachment_upload_ids: { screenshots: [uploadId] } }, "POST"), result,
    new URL("http://test/api/admin/tickets"), { user_id: "admin", role: "admin" });

  expect(result.writeHead).toHaveBeenCalledWith(201, expect.anything());
  expect(transactionClient.query.mock.calls).toContainEqual([
    expect.stringContaining("UPDATE attachments SET ticket_id"), ["created", "screenshots", uploadId],
  ]);
});

test("POST rejects invalid attachment selections before creating a ticket", async () => {
  await expect(adminApi(request({ project_id: "project-1", title: "New", description: "Ticket", attachment_upload_ids: { screenshots: ["bad"] } }, "POST"), response(),
    new URL("http://test/api/admin/tickets"), { user_id: "admin", role: "admin" })).rejects.toMatchObject({ status: 422 });

  expect(transactionClient.query.mock.calls.some(([sql]: [string]) => sql.includes("INSERT INTO tickets"))).toBe(false);
});

test("POST aborts the create transaction when an upload cannot be claimed", async () => {
  const uploadId = "22222222-2222-4222-8222-222222222222";
  const fallback = transactionClient.query.getMockImplementation();
  transactionClient.query.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (sql.includes("nextval")) return { rows: [{ number: 42 }] };
    if (sql.includes("INSERT INTO tickets")) return { rows: [{ ...ticket, id: "created" }] };
    if (sql.includes("SELECT a.upload_id FROM attachments")) return { rows: [] };
    return fallback!(sql, params);
  });

  await expect(adminApi(request({ project_id: "project-1", title: "New", description: "Ticket", attachment_upload_ids: { screenshots: [uploadId] } }, "POST"), response(),
    new URL("http://test/api/admin/tickets"), { user_id: "admin", role: "admin" })).rejects.toMatchObject({ message: "upload unavailable" });

  expect(transactionClient.query.mock.calls.some(([sql]: [string]) => sql.includes("ticket_status_history"))).toBe(false);
});

test.each([{ screenshot: "id" }, { screenshot: ["-".repeat(36)] }, null])("PATCH rejects malformed attachment maps before mutation", async (attachment_upload_ids) => {
  await expect(adminApi(request({ attachment_upload_ids }), response(),
    new URL("http://test/api/admin/tickets/ticket-1"), { user_id: "admin", role: "admin" }))
    .rejects.toMatchObject({ status: 422 });

  expect(transactionClient.query.mock.calls.some(([sql]: [string]) => /UPDATE tickets|DELETE FROM attachments/.test(sql))).toBe(false);
  expect(transactionClient.query.mock.calls.some(([sql]: [string]) => sql.includes("FROM attachments"))).toBe(false);
});

test("PATCH preserves an omitted required image and rejects explicitly removing it", async () => {
  formFields = formFields.map((field) => field.field_key === "screenshot" ? { ...field, required: true } : field);
  existingAttachments = [{ upload_id: "11111111-1111-4111-8111-111111111111", field_key: "screenshot" }];
  const preserved = response();

  await adminApi(request({ title: "Changed" }), preserved,
    new URL("http://test/api/admin/tickets/ticket-1"), { user_id: "admin", role: "admin" });

  expect(preserved.writeHead).toHaveBeenCalledWith(200, expect.anything());
  expect(transactionClient.query.mock.calls.some(([sql]: [string]) => sql.includes("DELETE FROM attachments"))).toBe(false);

  transactionClient.query.mockClear();
  const removed = response();
  await adminApi(request({ attachment_upload_ids: { screenshot: [] } }), removed,
    new URL("http://test/api/admin/tickets/ticket-1"), { user_id: "admin", role: "admin" });

  expect(removed.writeHead).toHaveBeenCalledWith(400, expect.anything());
  expect(body(removed)).toEqual({ error: "validation failed", fields: { screenshot: "required" } });
  expect(transactionClient.query.mock.calls.some(([sql]: [string]) => /UPDATE tickets|DELETE FROM attachments/.test(sql))).toBe(false);
});

test("PATCH marks an approved plan stale when image evidence changes", async () => {
  const oldId = "11111111-1111-4111-8111-111111111111";
  const newId = "22222222-2222-4222-8222-222222222222";
  existingAttachments = [{ upload_id: oldId, field_key: "screenshot" }];
  const fallback = transactionClient.query.getMockImplementation();
  transactionClient.query.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (sql.includes("SELECT id,upload_id,field_key FROM attachments")) return { rows: [{ id: "attachment-old", upload_id: oldId, field_key: "screenshot" }] };
    if (sql.includes("ticket_id IS NULL FOR UPDATE")) return { rows: [{ id: "attachment-new", upload_id: newId }] };
    if (sql.includes("SELECT a.upload_id FROM attachments")) return { rows: [{ upload_id: newId }] };
    return fallback!(sql, params);
  });
  const result = response();

  await adminApi(request({ attachment_upload_ids: { screenshot: [newId] } }), result,
    new URL("http://test/api/admin/tickets/ticket-1"), { user_id: "admin", role: "admin" });

  expect(result.writeHead).toHaveBeenCalledWith(200, expect.anything());
  expect(transactionClient.query.mock.calls.some(([sql]: [string]) => sql.includes("mark_ticket_plan_potentially_stale"))).toBe(true);
});

test("PATCH claims new uploads against a newly selected project", async () => {
  const uploadId = "22222222-2222-4222-8222-222222222222";
  const fallback = transactionClient.query.getMockImplementation();
  transactionClient.query.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (sql.includes("SELECT * FROM projects")) return { rows: [{ id: "project-2", config_json: {} }] };
    if (sql.includes("UPDATE tickets SET")) return { rows: [{ ...ticket, project_id: "project-2" }] };
    if (sql.includes("ticket_id IS NULL FOR UPDATE")) return { rows: [{ upload_id: uploadId }] };
    if (sql.includes("SELECT a.upload_id FROM attachments")) return { rows: [{ upload_id: uploadId }] };
    return fallback!(sql, params);
  });

  await adminApi(request({ project_id: "project-2", attachment_upload_ids: { screenshot: [uploadId] } }), response(),
    new URL("http://test/api/admin/tickets/ticket-1"), { user_id: "admin", role: "admin" });

  const allowed = transactionClient.query.mock.calls.find(([sql]: [string]) => sql.includes("SELECT a.upload_id FROM attachments"));
  expect(allowed[1]).toEqual([[uploadId], "admin", "project-2"]);
});

test("PATCH submission validates a source URL against saved required values", async () => {
  const result = response();

  await adminApi(request({ submission: { source_url: "https://example.test/only-url" } }), result,
    new URL("http://test/api/admin/tickets/ticket-1"), { user_id: "admin", role: "admin" });

  expect(result.writeHead).toHaveBeenCalledWith(200, expect.anything());
  const update = transactionClient.query.mock.calls.find(([sql]: [string]) => sql.includes("UPDATE tickets SET"));
  expect(update[0]).toContain("source_url=$2");
  expect(update[1]).toContain("https://example.test/only-url");
});

test("PATCH submission saves allowed source values without changing attachments", async () => {
  const result = response();

  await adminApi(request({ submission: { source_url: "https://example.test/report", details: "Saved detail" } }), result,
    new URL("http://test/api/admin/tickets/ticket-1"), { user_id: "admin", role: "admin" });

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

    await adminApi(request({ submission }), result, new URL("http://test/api/admin/tickets/ticket-1"), { user_id: "admin", role: "admin" });

    expect(result.writeHead).toHaveBeenCalledWith(400, expect.anything());
    expect(body(result)).toEqual({ error: "validation failed", fields });
    expect(transactionClient.query.mock.calls.some(([sql]: [string]) => sql.includes("UPDATE tickets SET"))).toBe(false);
  }
});

test("direct PATCH preserves nonempty bounded ticket title and description", async () => {
  for (const [patch, fields] of [
    [{ title: "  " }, { title: "required" }],
    [{ description: "" }, { description: "required" }],
  ] as const) {
    const result = response();
    await adminApi(request(patch), result, new URL("http://test/api/admin/tickets/ticket-1"), { user_id: "admin", role: "admin" });
    expect(result.writeHead).toHaveBeenCalledWith(400, expect.anything());
    expect(body(result)).toEqual({ error: "validation failed", fields });
  }
});
