import { expect, test, vi } from "vitest";

const inTransaction = vi.fn(async () => undefined);
vi.mock("@dcc/database", () => ({
  artifactDataRoot: () => "/primary", legacyArtifactDataRoot: () => "/legacy",
  finalizeArtifact: vi.fn(), inTransaction, pool: { query: vi.fn() },
  readArtifact: vi.fn(), readStagedArtifact: vi.fn(), stageArtifact: vi.fn(),
}));

const { adminApi } = await import("./server.ts");

function request(body: unknown) {
  return {
    method: "PATCH", headers: {},
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); },
  } as any;
}

test.each(["Rejected", "Plan Approved"])("generic ticket PATCH rejects raw %s transitions", async (status) => {
  const response: any = { writeHead: vi.fn(), end: vi.fn() };
  await adminApi(request({ status }), response, new URL("http://test/api/admin/tickets/ticket"), { user_id: "admin" });
  expect(response.writeHead).toHaveBeenCalledWith(422, expect.any(Object));
  expect(response.end).toHaveBeenCalledWith(JSON.stringify({ error: "status must use its decision endpoint" }));
});
