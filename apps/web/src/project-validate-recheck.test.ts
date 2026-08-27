import { beforeEach, expect, test, vi } from "vitest";

process.env.DCC_PROCESS_ROLE = "web";

const pool = { query: vi.fn() };
vi.mock("@dcc/database", () => ({
  artifactDataRoot: () => "/primary", legacyArtifactDataRoot: () => "/legacy",
  finalizeArtifact: vi.fn(), inTransaction: vi.fn(), pool,
  readArtifact: vi.fn(), readStagedArtifact: vi.fn(), stageArtifact: vi.fn(),
}));
vi.mock("@dcc/domain", async (importOriginal) => ({
  ...(await importOriginal<object>()),
}));

const { adminApi } = await import("./server.ts");

const projectId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const validatePath = `http://test/api/admin/projects/${projectId}/validate`;

function request() {
  return {
    method: "POST", headers: {}, socket: { remoteAddress: "127.0.0.1" },
    async *[Symbol.asyncIterator]() { yield Buffer.from("{}"); },
  } as any;
}

function newResponse() {
  return { writeHead: vi.fn(), end: vi.fn((body?: unknown) => body) } as any;
}

beforeEach(() => {
  pool.query.mockReset();
  pool.query.mockImplementation(async (sql: string) =>
    sql.includes("FROM projects") ? { rows: [{ id: projectId }] } : { rows: [] });
});

async function recheck() {
  const response = newResponse();
  await adminApi(request(), response, new URL(validatePath), { user_id: "admin" });
  expect(response.writeHead).toHaveBeenCalledWith(202, expect.any(Object));
  const enqueue = pool.query.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO jobs")).at(-1);
  expect(enqueue).toBeDefined();
  return String(enqueue![1]!.find((value: unknown) => typeof value === "string" && value.startsWith("project.validate:")));
}

// enqueueJob dedupes on idempotency_key with `ON CONFLICT DO UPDATE SET
// idempotency_key = EXCLUDED.idempotency_key` — a no-op that leaves a
// terminal job untouched. A per-project constant key therefore made every
// Recheck after the first a silent no-op: 202, no re-run, stale diagnostics.
test("each Recheck request enqueues under its own idempotency key", async () => {
  const first = await recheck();
  const second = await recheck();

  expect(first).toMatch(new RegExp(`^project\\.validate:${projectId}:`));
  expect(second).toMatch(new RegExp(`^project\\.validate:${projectId}:`));
  expect(second).not.toBe(first);
});
