import { beforeEach, expect, test, vi } from "vitest";

process.env.DCC_PROCESS_ROLE = "web";

const pool = { query: vi.fn() };
vi.mock("@dcc/database", () => ({
  artifactDataRoot: () => "/primary", legacyArtifactDataRoot: () => "/legacy",
  finalizeArtifact: vi.fn(), inTransaction: vi.fn(), pool,
  readArtifact: vi.fn(), readStagedArtifact: vi.fn(), stageArtifact: vi.fn(),
}));

const { adminApi } = await import("./server.ts");

function request(body: unknown, method = "POST") {
  return {
    method, headers: {}, socket: { remoteAddress: "127.0.0.1" },
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); },
  } as any;
}

const path = "http://test/api/admin/settings/ai-review";
const savedRow = { default_model: "haiku", default_reasoning_level: "low", auto_review_enabled: true, auto_merge_on_approve: false };

beforeEach(() => {
  pool.query.mockReset();
});

test("saving a new model and reasoning level returns the persisted row, not an echo", async () => {
  pool.query.mockImplementation(async (sql: string) => {
    if (sql.includes("UPDATE ai_review_settings")) return { rows: [savedRow] };
    if (sql.includes("INSERT INTO audit_events")) return { rows: [] };
    throw new Error(`unexpected query: ${sql}`);
  });
  const response: any = { writeHead: vi.fn(), end: vi.fn() };

  await adminApi(request({ default_model: "haiku", default_reasoning_level: "low" }), response, new URL(path), { user_id: "admin" });

  expect(response.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
  expect(response.end).toHaveBeenCalledWith(JSON.stringify({ ok: true, settings: savedRow }));
});

test("toggling auto_review_enabled and auto_merge_on_approve in one request saves successfully", async () => {
  pool.query.mockImplementation(async (sql: string, values?: unknown[]) => {
    if (sql.includes("UPDATE ai_review_settings")) {
      expect(values?.[3]).toBe(false); // auto_review_enabled
      expect(values?.[4]).toBe(true); // auto_merge_on_approve
      return { rows: [{ ...savedRow, auto_review_enabled: false, auto_merge_on_approve: true }] };
    }
    if (sql.includes("INSERT INTO audit_events")) return { rows: [] };
    throw new Error(`unexpected query: ${sql}`);
  });
  const response: any = { writeHead: vi.fn(), end: vi.fn() };

  await adminApi(request({ default_model: "haiku", default_reasoning_level: "low", auto_review_enabled: false, auto_merge_on_approve: true }), response, new URL(path), { user_id: "admin" });

  expect(response.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
});

test("a non-critical audit-log failure after a successful save still reports success (regression for the reported bug)", async () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  pool.query.mockImplementation(async (sql: string) => {
    if (sql.includes("UPDATE ai_review_settings")) return { rows: [savedRow] };
    if (sql.includes("INSERT INTO audit_events")) throw new Error("simulated audit insert failure (e.g. FK violation, transient connection error)");
    throw new Error(`unexpected query: ${sql}`);
  });
  const response: any = { writeHead: vi.fn(), end: vi.fn() };

  await adminApi(request({ default_model: "haiku", default_reasoning_level: "low" }), response, new URL(path), { user_id: "admin" });

  // The bug this regresses: before the fix, the audit exception propagated uncaught
  // out of adminApi and the top-level error handler turned it into a 500 "internal error"
  // even though the UPDATE above had already committed.
  expect(response.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
  expect(response.end).toHaveBeenCalledWith(JSON.stringify({ ok: true, settings: savedRow }));
  expect(consoleError).toHaveBeenCalled(); // the failure must be logged, not swallowed
  consoleError.mockRestore();
});

test("an invalid model is rejected before any write, and is not reported as 'internal error'", async () => {
  const response: any = { writeHead: vi.fn(), end: vi.fn() };

  // validateAiSelection throws AiConfigurationError (status 422) synchronously inside
  // the handler; adminApi has no internal try/catch, so the promise rejects here rather
  // than adminApi itself calling response.writeHead. The 422-vs-500 distinction is proven
  // by the thrown error's own `.status`, which errorEnvelope() (server.ts) reads at the
  // real HTTP layer — that layer isn't exercised by calling adminApi() directly, so this
  // test only needs to confirm the request is rejected before any DB write happens.
  await expect(adminApi(request({ default_model: "not-a-real-model", default_reasoning_level: "low" }), response, new URL(path), { user_id: "admin" }))
    .rejects.toMatchObject({ status: 422 });
  expect(pool.query).not.toHaveBeenCalled();
});

test("an invalid reasoning level is rejected before any write", async () => {
  const response: any = { writeHead: vi.fn(), end: vi.fn() };
  await expect(adminApi(request({ default_model: "haiku", default_reasoning_level: "not-a-real-level" }), response, new URL(path), { user_id: "admin" }))
    .rejects.toMatchObject({ status: 422 });
  expect(pool.query).not.toHaveBeenCalled();
});

test("a genuine persistence failure does not report success", async () => {
  pool.query.mockImplementation(async (sql: string) => {
    if (sql.includes("UPDATE ai_review_settings")) throw new Error("simulated connection failure");
    throw new Error(`unexpected query: ${sql}`);
  });
  const response: any = { writeHead: vi.fn(), end: vi.fn() };

  await expect(adminApi(request({ default_model: "haiku", default_reasoning_level: "low" }), response, new URL(path), { user_id: "admin" }))
    .rejects.toThrow("simulated connection failure");
  expect(response.writeHead).not.toHaveBeenCalledWith(200, expect.any(Object));
  expect(pool.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO audit_events"))).toBe(false); // never reached
});

test("auto_review_enabled must be a boolean", async () => {
  const response: any = { writeHead: vi.fn(), end: vi.fn() };
  await adminApi(request({ auto_review_enabled: "yes" }), response, new URL(path), { user_id: "admin" });
  expect(response.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
  expect(pool.query).not.toHaveBeenCalled();
});
