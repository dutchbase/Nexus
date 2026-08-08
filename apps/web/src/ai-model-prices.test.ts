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

const { adminApi, route } = await import("./server.ts");

function request(body: unknown) {
  return {
    method: "POST", url: "/api/admin/ai-model-prices", headers: {}, socket: { remoteAddress: "127.0.0.1" },
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); },
  } as any;
}

function response() {
  return { writeHead: vi.fn(), end: vi.fn() } as any;
}

const validPrice = {
  model: "deepseek-v4-pro", effective_from: "2026-09-01T00:00:00Z",
  input_usd_per_million: 1, output_usd_per_million: 2,
  cache_write_usd_per_million: 3, cache_read_usd_per_million: 4,
  source_url: "https://example.test/pricing",
};

beforeEach(() => {
  pool.query.mockReset();
  inTransaction.mockClear();
  transactionClient = { query: vi.fn() };
});

test("creates an append-only model price with the derived provider and audit event", async () => {
  const price = { id: "price-1", ...validPrice, provider: "deepseek", created_by: "admin" };
  transactionClient.query.mockResolvedValueOnce({ rows: [price] }).mockResolvedValueOnce({ rows: [] });
  const res = response();

  await adminApi(request(validPrice), res, new URL("http://test/api/admin/ai-model-prices"), { user_id: "admin" });

  const insert = transactionClient.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO ai_model_prices"));
  expect(insert?.[1]).toEqual([
    "deepseek-v4-pro", "deepseek", "2026-09-01T00:00:00.000Z", 1, 2, 3, 4,
    "https://example.test/pricing", "admin",
  ]);
  const audit = transactionClient.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO audit_events"));
  expect(audit?.[1]).toContain("ai_model_price.create");
  expect(inTransaction).toHaveBeenCalledTimes(1);
  expect(pool.query).not.toHaveBeenCalled();
  expect(res.writeHead).toHaveBeenCalledWith(201, expect.anything());
});

test.each([
  [{ ...validPrice, model: "unknown" }, "unsupported model"],
  [{ ...validPrice, input_usd_per_million: -1 }, "negative rate"],
  [{ ...validPrice, output_usd_per_million: "2" }, "string rate"],
  [{ ...validPrice, effective_from: "not-a-date" }, "invalid timestamp"],
  [{ ...validPrice, effective_from: "2026-02-30T00:00:00Z" }, "impossible calendar timestamp"],
  [{ ...validPrice, source_url: "http://example.test/pricing" }, "non-HTTPS source"],
])("rejects %s without inserting a price", async (body, _label) => {
  const res = response();

  await expect(adminApi(request(body), res, new URL("http://test/api/admin/ai-model-prices"), { user_id: "admin" })).rejects.toMatchObject({ status: 422 });

  expect(pool.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO ai_model_prices"))).toBe(false);
});

test("propagates an audit failure from the price transaction", async () => {
  const price = { id: "price-1", ...validPrice, provider: "deepseek", created_by: "admin" };
  transactionClient.query.mockResolvedValueOnce({ rows: [price] }).mockRejectedValueOnce(new Error("audit unavailable"));

  await expect(adminApi(request(validPrice), response(), new URL("http://test/api/admin/ai-model-prices"), { user_id: "admin" })).rejects.toThrow("audit unavailable");

  expect(inTransaction).toHaveBeenCalledTimes(1);
});

test("does not expose mutation or deletion routes for model prices", async () => {
  const res = response();

  await adminApi({ method: "PATCH", headers: {}, socket: { remoteAddress: "127.0.0.1" } } as any, res,
    new URL("http://test/api/admin/ai-model-prices/price-1"), { user_id: "admin" });

  expect(res.writeHead).toHaveBeenCalledWith(404, expect.anything());
  expect(pool.query).not.toHaveBeenCalled();
});

test("requires an authenticated admin session before accepting a model price", async () => {
  const res = response();

  await route(request(validPrice), res);

  expect(res.writeHead).toHaveBeenCalledWith(401, expect.anything());
  expect(pool.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO ai_model_prices"))).toBe(false);
});
