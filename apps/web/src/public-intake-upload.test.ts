import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, test, vi } from "vitest";

process.env.DCC_PROCESS_ROLE = "web";

const pool = { query: vi.fn() };
let mockClient: any;
const inTransaction = vi.fn(async (callback: (client: any) => unknown) => callback(mockClient));
vi.mock("@dcc/database", () => ({
  artifactDataRoot: () => "/primary",
  legacyArtifactDataRoot: () => "/legacy",
  finalizeArtifact: vi.fn().mockResolvedValue({ sha256: "sha-1" }),
  inTransaction,
  pool,
  readArtifact: vi.fn(),
  readStagedArtifact: vi.fn(),
  stageArtifact: vi.fn().mockResolvedValue({
    id: "x", root: "/primary", relativePath: "uploads/x.png",
    stagedPath: "/primary/.staged/x", storagePath: "/primary/uploads/x.png",
  }),
}));

const { upload, submitPublicForm } = await import("./server.ts");

beforeEach(() => {
  pool.query.mockReset();
  inTransaction.mockClear();
  mockClient = { query: vi.fn().mockResolvedValue({ rows: [{ id: "upload-1" }], rowCount: 1 }) };
});

function multipartPngBody(boundary: string, filename = "x.png") {
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from([0, 0, 0, 0])]);
  const head = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;
  return Buffer.concat([Buffer.from(head, "utf8"), png, Buffer.from(tail, "utf8")]);
}

function uploadRequest() {
  const boundary = "dccBoundary";
  const body = multipartPngBody(boundary);
  return {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    socket: { remoteAddress: "127.0.0.1" },
    async *[Symbol.asyncIterator]() { yield body; },
  } as any;
}

function jsonRequest(body: unknown, headers: Record<string, string> = {}) {
  return {
    method: "POST",
    headers,
    socket: { remoteAddress: "127.0.0.1" },
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); },
  } as any;
}

function response() {
  return { writeHead: vi.fn(), end: vi.fn() } as any;
}

describe("upload", () => {
  test("scopes a newly stored upload to the submitting form", async () => {
    const form = { id: "form-1", settings_json: {} };
    await upload(uploadRequest(), response(), form);

    const insert = mockClient.query.mock.calls.find(([sql]: [string]) => sql.includes("INSERT INTO uploads"));
    expect(insert).toBeDefined();
    expect(insert![1]).toContain("form-1");
    expect(insert![1][0]).toBe("uploads/x.png");
    const attachment = mockClient.query.mock.calls.find(([sql]: [string]) => sql.includes("INSERT INTO attachments"));
    expect(attachment?.[0]).toContain("RETURNING id");
  });

  test("does not register an upload when the form is no longer published", async () => {
    mockClient.query.mockImplementation(async (sql: string) => sql.includes("FROM forms")
      ? { rows: [], rowCount: 0 } : { rows: [{ count: 0 }], rowCount: 1 });
    const result = response();

    await upload(uploadRequest(), result, { id: "draft-form", settings_json: {} });

    expect(result.writeHead).toHaveBeenCalledWith(404, expect.anything());
    expect(JSON.parse(result.end.mock.calls[0][0])).toEqual({ error: "form not found" });
    expect(mockClient.query.mock.calls.some(([sql]: [string]) => sql.includes("INSERT INTO uploads"))).toBe(false);
  });
});

describe("submitPublicForm upload claim", () => {
  test("atomically claims every finalized upload declared by an image field", async () => {
    pool.query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM form_fields")) return { rows: [] };
      if (sql.includes("FROM public_submission_attempts")) return { rows: [{ count: 0 }] };
      if (sql.includes("FROM projects")) return { rows: [{ id: "project-1" }] };
      return { rows: [] };
    });
    const form = { id: "form-1", fixed_project_id: "project-1", settings_json: { notify_on_submission: false } };
    const uploadId = "11111111-1111-4111-8111-111111111111";
    const body = {
      title: "A bug", description: "It broke", website: "", screenshot: uploadId,
    };

    mockClient.query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM attachments a") && sql.includes("FOR UPDATE")) return { rows: [{ upload_id: uploadId }], rowCount: 1 };
      if (sql.includes("INSERT INTO tickets")) return { rows: [{ id: "ticket-1", ticket_number: "DCC-1" }], rowCount: 1 };
      return { rows: [{ id: "row-1", number: 1 }], rowCount: 1 };
    });

    await submitPublicForm(jsonRequest(body), response(), form);

    const lock = mockClient.query.mock.calls.find(([sql]: [string]) => sql.includes("FROM attachments a") && sql.includes("FOR UPDATE"));
    expect(lock?.[0]).toContain("ar.status='finalized'");
    const claim = mockClient.query.mock.calls.find(([sql]: [string]) => sql.includes("UPDATE attachments"));
    expect(claim).toBeDefined();
    const [sql, params] = claim!;
    expect(sql).toContain("ticket_id IS NULL");
    const scopedClaim = mockClient.query.mock.calls.find(([query]: [string]) => query.includes("u.form_id=$2") && query.includes("claim_expires_at"));
    expect(scopedClaim?.[0]).toContain("interval '1 hour'");
    expect(scopedClaim?.[1]).toContain("form-1");
    expect(params[2]).toContain(uploadId);
    expect(mockClient.query.mock.calls.some(([sql, params]: [string, unknown[]]) => sql.includes("UPDATE attachments") && params.includes("screenshot"))).toBe(true);
  });

  test("rejects a missing or already claimed required upload before creating a ticket", async () => {
    const uploadId = "11111111-1111-4111-8111-111111111111";
    pool.query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM form_fields")) return { rows: [{ field_key: "evidence", field_type: "image_upload", required: true, validation_json: {}, options_json: [] }] };
      if (sql.includes("FROM public_submission_attempts")) return { rows: [{ count: 0 }] };
      if (sql.includes("FROM projects")) return { rows: [{ id: "project-1" }] };
      return { rows: [] };
    });
    mockClient.query.mockImplementation(async (sql: string) => sql.includes("FROM public_submission_attempts")
      ? { rows: [{ count: 0 }], rowCount: 1 }
      : { rows: [], rowCount: 0 });
    const result = response();
    await submitPublicForm(jsonRequest({ title: "A", description: "B", evidence: [uploadId] }), result,
      { id: "form-1", fixed_project_id: "project-1", settings_json: { notify_on_submission: false } });
    expect(result.writeHead).toHaveBeenCalledWith(400, expect.anything());
    expect(mockClient.query.mock.calls.some(([sql]: [string]) => sql.includes("INSERT INTO tickets"))).toBe(false);
  });

  test("serializes a client retry key and reuses its already-created ticket", async () => {
    const key = "33333333-3333-4333-8333-333333333333";
    pool.query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM form_fields")) return { rows: [] };
      if (sql.includes("FROM projects")) return { rows: [{ id: "project-1" }] };
      return { rows: [] };
    });
    mockClient.query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM public_submission_attempts")) return { rows: [{ count: 0 }] };
      if (sql.includes("FROM audit_events") && sql.includes("idempotency_key")) return { rows: [{ id: "ticket-1", ticket_number: "DCC-1" }] };
      return { rows: [], rowCount: 1 };
    });
    const result = response();
    await submitPublicForm(jsonRequest({ title: "A", description: "B" }, { "idempotency-key": key }), result,
      { id: "form-1", fixed_project_id: "project-1", settings_json: { notify_on_submission: false } });
    expect(mockClient.query.mock.calls.some(([sql, values]: [string, string[]]) => sql.includes("pg_advisory_xact_lock") && values.includes(key))).toBe(true);
    expect(mockClient.query.mock.calls.some(([sql]: [string]) => sql.includes("INSERT INTO tickets"))).toBe(false);
    expect(result.writeHead).toHaveBeenCalledWith(201, expect.anything());
  });

  test("returns a completed retry before charging another rate-limit attempt", async () => {
    const key = "44444444-4444-4444-8444-444444444444";
    pool.query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM form_fields")) return { rows: [] };
      if (sql.includes("FROM audit_events")) return { rows: [{ id: "ticket-1", ticket_number: "DCC-1" }] };
      return { rows: [] };
    });
    const result = response();
    await submitPublicForm(jsonRequest({ title: "A", description: "B" }, { "idempotency-key": key }), result,
      { id: "form-1", fixed_project_id: "project-1", settings_json: { notify_on_submission: false } });
    expect(result.writeHead).toHaveBeenCalledWith(201, expect.anything());
    expect(inTransaction).not.toHaveBeenCalled();
  });
});

describe("old unscoped upload route", () => {
  test("no source file references the retired /api/public/uploads path", () => {
    for (const file of ["./server.ts", "./ui.ts"]) {
      const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
      expect(source).not.toContain('"/api/public/uploads"');
    }
  });
});
