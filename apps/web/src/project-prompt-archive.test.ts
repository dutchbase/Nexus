import { beforeEach, expect, test, vi } from "vitest";

process.env.DCC_PROCESS_ROLE = "web";
const pool = { query: vi.fn() };
let client: any;
const inTransaction = vi.fn(async (fn: any) => fn(client));
vi.mock("@dcc/database", () => ({ artifactDataRoot: () => "/primary", legacyArtifactDataRoot: () => "/legacy", finalizeArtifact: vi.fn(), inTransaction, pool, readArtifact: vi.fn(), readStagedArtifact: vi.fn(), stageArtifact: vi.fn() }));
const { adminApi } = await import("./server.ts");

beforeEach(() => {
  pool.query.mockReset();
  pool.query.mockResolvedValue({ rows: [{ id: "22222222-2222-4222-8222-222222222222" }] });
  client = { query: vi.fn(async (sql: string) => sql.includes("SELECT id FROM prompt_files") ? { rows: [{ id: "11111111-1111-4111-8111-111111111111" }] } : { rows: [], rowCount: 1 }) };
});

test("bulk Delete archives prompt files and preserves immutable versions", async () => {
  const req: any = { method: "POST", headers: {}, socket: {}, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ action: "delete", ids: ["11111111-1111-4111-8111-111111111111"] })); } };
  const res: any = { writeHead: vi.fn(), end: vi.fn() };
  await adminApi(req, res, new URL("http://test/api/admin/projects/22222222-2222-4222-8222-222222222222/prompts/bulk"), { user_id: "admin" });
  expect(res.writeHead).toHaveBeenCalledWith(200, expect.anything());
  expect(client.query.mock.calls.some(([sql]: [string]) => sql.includes("active_version_id=NULL"))).toBe(true);
  expect(client.query.mock.calls.every(([sql]: [string]) => !sql.startsWith("DELETE FROM prompt_"))).toBe(true);
});
