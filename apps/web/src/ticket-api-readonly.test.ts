import { beforeEach, expect, test, vi } from "vitest";

process.env.DCC_PROCESS_ROLE = "web";
const pool = { query: vi.fn() };
const inTransaction = vi.fn(async (fn: any) => fn(pool));
vi.mock("@dcc/database", () => ({
  artifactDataRoot: () => "/primary", legacyArtifactDataRoot: () => "/legacy",
  finalizeArtifact: vi.fn(), inTransaction, pool,
  readArtifact: vi.fn(), readStagedArtifact: vi.fn(), stageArtifact: vi.fn(),
}));
const { adminApi } = await import("./server.ts");

beforeEach(() => {
  pool.query.mockReset();
  pool.query.mockImplementation(async (sql: string) => sql.includes("SELECT * FROM tickets")
    ? { rows: [{ id: "ticket-1", status: "Submitted" }] }
    : { rows: [] });
});

test("GET ticket API is read-only", async () => {
  const response: any = { writeHead: vi.fn(), end: vi.fn() };
  await adminApi({ method: "GET", headers: {} } as any, response,
    new URL("http://test/api/admin/tickets/T-1"), { user_id: "admin" });
  expect(response.writeHead).toHaveBeenCalledWith(200, expect.anything());
  expect(pool.query.mock.calls.every(([sql]) => !/UPDATE tickets|INSERT INTO ticket_status_history/i.test(sql))).toBe(true);
});
