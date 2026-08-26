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

function request(body: unknown, method = "POST") {
  return {
    method, headers: {}, socket: { remoteAddress: "127.0.0.1" },
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); },
  } as any;
}

function newResponse() {
  return { writeHead: vi.fn(), end: vi.fn((body?: unknown) => body) } as any;
}

const projectId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const mergePath = `http://test/api/admin/projects/${projectId}/merge-branches`;
const jobId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

beforeEach(() => {
  pool.query.mockReset();
  // Default: every lookup resolves to a configured project; unmatched selects return empty rows.
  pool.query.mockImplementation(async (sql: string) =>
    sql.includes("FROM projects")
      ? { rows: [{ id: projectId, github_owner: "acme", github_repository: "widgets", default_branch: "main" }] }
      : { rows: [] });
});

test("merge-branches rejects invalid branch names before enqueueing anything", async () => {
  const response = newResponse();
  await adminApi(request({ head: "--upload-pack=/bin/sh", base: "staging" }), response, new URL(mergePath), { user_id: "admin" });

  expect(response.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
  expect(pool.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO jobs"))).toBe(false);
});

test("merge-branches into the default branch requires explicit confirmation", async () => {
  const response = newResponse();

  await adminApi(request({ head: "master", base: "main" }), response, new URL(mergePath), { user_id: "admin" });

  expect(response.writeHead).toHaveBeenCalledWith(409, expect.any(Object));
  expect(pool.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO jobs"))).toBe(false);

  // With confirm_default_branch=true the job is enqueued with a deterministic key.
  const okResponse = newResponse();
  await adminApi(request({ head: "master", base: "main", confirm_default_branch: true }), okResponse, new URL(mergePath), { user_id: "admin" });
  const enqueue = pool.query.mock.calls.find(([sql]) => sql.includes("INSERT INTO jobs"));
  expect(enqueue).toBeDefined();
  expect(String(enqueue![1]?.find((value: unknown) => typeof value === "string" && value.startsWith("g07:github.merge_branches:")))).toContain(":master:main:");
});

test("jobs status endpoint returns 404 for a missing job", async () => {
  const response = newResponse();

  await adminApi(request({}, "GET"), response, new URL(`http://test/api/admin/jobs/${jobId}`), { user_id: "admin" });

  expect(response.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
});

test("jobs status endpoint rejects malformed ids without touching the database", async () => {
  const response = newResponse();

  await adminApi(request({}, "GET"), response, new URL("http://test/api/admin/jobs/not-a-uuid"), { user_id: "admin" });

  expect(response.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
  expect(pool.query).not.toHaveBeenCalled();
});
