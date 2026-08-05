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
    async *[Symbol.asyncIterator]() { yield body; },
  } as any;
}

function jsonRequest(body: unknown) {
  return {
    method: "POST",
    headers: {},
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
  });
});

describe("submitPublicForm upload claim", () => {
  test("claims only fresh uploads scoped to the submitting form", async () => {
    pool.query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM form_fields")) return { rows: [] };
      if (sql.includes("FROM public_submission_attempts")) return { rows: [{ count: 0 }] };
      if (sql.includes("FROM projects")) return { rows: [{ id: "project-1" }] };
      return { rows: [] };
    });
    const form = { id: "form-1", fixed_project_id: "project-1", settings_json: { notify_on_submission: false } };
    const uploadId = "11111111-1111-4111-8111-111111111111";
    const body = {
      title: "A bug", description: "It broke", website: "", image: uploadId,
    };

    await submitPublicForm(jsonRequest(body), response(), form);

    const claim = mockClient.query.mock.calls.find(([sql]: [string]) => sql.includes("UPDATE attachments"));
    expect(claim).toBeDefined();
    const [sql, params] = claim!;
    expect(sql).toContain("u.form_id");
    expect(sql).toContain("interval '1 hour'");
    expect(params).toContain("form-1");
    expect(params[1]).toContain(uploadId);
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
