import { beforeEach, expect, test, vi } from "vitest";

process.env.DCC_PROCESS_ROLE = "web";
const pool = { query: vi.fn() };
const inTransaction = vi.fn();
vi.mock("@dcc/database", () => ({
  artifactDataRoot: () => "/primary", legacyArtifactDataRoot: () => "/legacy",
  finalizeArtifact: vi.fn(), inTransaction, pool,
  readArtifact: vi.fn(), readStagedArtifact: vi.fn(), stageArtifact: vi.fn(),
}));
const { adminApi } = await import("./server.ts");
const response = () => ({ writeHead: vi.fn(), end: vi.fn() } as any);
const request = (body: unknown) => ({ method: "POST", headers: {}, socket: { remoteAddress: "127.0.0.1" }, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); } } as any);

beforeEach(() => { pool.query.mockReset(); inTransaction.mockReset(); });

test("form creation rejects an unroutable slug before writing", async () => {
  const result = response();
  await adminApi(request({ name: "Broken", slug: "broken/form", title: "Broken" }), result,
    new URL("http://test/api/admin/forms"), { user_id: "admin", role: "admin" });
  expect(result.writeHead).toHaveBeenCalledWith(400, expect.anything());
  expect(inTransaction).not.toHaveBeenCalled();
});

test("publishing rejects forms without required public core controls", async () => {
  const client = { query: vi.fn(async (sql: string) => {
    if (sql.includes("SELECT * FROM forms")) return { rows: [{ id: "11111111-1111-4111-8111-111111111111", slug: "valid", name: "Valid", title: "Valid", fixed_project_id: "project-1", settings_json: {} }] };
    if (sql.includes("FROM form_fields")) return { rows: [{ field_key: "title", field_type: "short_text", required: true }] };
    return { rows: [] };
  }) };
  inTransaction.mockImplementation(async (fn: any) => fn(client));
  pool.query.mockImplementation(client.query);
  const result = response();
  await adminApi(request({}), result,
    new URL("http://test/api/admin/forms/11111111-1111-4111-8111-111111111111/publish"), { user_id: "admin", role: "admin" });
  expect(result.writeHead).toHaveBeenCalledWith(422, expect.anything());
  expect(inTransaction).toHaveBeenCalledTimes(1);
  expect(client.query.mock.calls.some(([sql]: [string]) => sql.includes("UPDATE forms SET status"))).toBe(false);
});

test("editing a published form cannot disable its required image field", async () => {
  const form = { id: "11111111-1111-4111-8111-111111111111", slug: "valid", name: "Valid", title: "Valid", status: "published", fixed_project_id: "project-1", settings_json: { allow_image_attachments: true } };
  const client = { query: vi.fn(async (sql: string) => {
    if (sql.includes("SELECT * FROM forms")) return { rows: [form] };
    if (sql.includes("FROM form_fields")) return { rows: [
      { field_key: "title", field_type: "short_text" }, { field_key: "description", field_type: "long_text" },
      { field_key: "image", field_type: "image_upload", required: true },
    ] };
    return { rows: [{ ...form }], rowCount: 1 };
  }) };
  inTransaction.mockImplementation(async (fn: any) => fn(client));
  pool.query.mockResolvedValue({ rows: [] });
  const result = response();
  await adminApi({ ...request({ settings_json: { allow_image_attachments: false } }), method: "PATCH" }, result,
    new URL("http://test/api/admin/forms/11111111-1111-4111-8111-111111111111"), { user_id: "admin", role: "admin" });
  expect(result.writeHead).toHaveBeenCalledWith(422, expect.anything());
  expect(client.query.mock.calls.some(([sql]: [string]) => sql.includes("UPDATE forms SET"))).toBe(false);
});
