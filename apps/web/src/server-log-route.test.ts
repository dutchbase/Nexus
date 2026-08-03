import { beforeEach, expect, it, vi } from "vitest";

process.env.DCC_PROCESS_ROLE = "web";

const query = vi.fn();
const readStagedArtifact = vi.fn();
const readArtifact = vi.fn();

vi.mock("@dcc/database", () => ({
  artifactDataRoot: () => "/primary", legacyArtifactDataRoot: () => "/legacy",
  finalizeArtifact: vi.fn(), inTransaction: vi.fn(), pool: { query }, readArtifact, readStagedArtifact, stageArtifact: vi.fn(),
}));

const { adminApi } = await import("./server.ts");

beforeEach(() => { query.mockReset(); readArtifact.mockReset(); readStagedArtifact.mockReset(); });

it("serves a migration-022 staged log from its controlled final path after a rename", async () => {
  query.mockResolvedValueOnce({ rows: [{ id: "11111111-1111-4111-8111-111111111111", artifact_id: "22222222-2222-4222-8222-222222222222", storage_path: "logs/run.log", status: "staged", storage_root: "primary" }] });
  readStagedArtifact.mockRejectedValueOnce(new Error("staging entry gone"));
  readArtifact.mockResolvedValueOnce(Buffer.from("renamed log"));
  const response: any = { writeHead: vi.fn(), end: vi.fn() };
  await adminApi({ method: "GET" } as any, response, new URL("http://test/api/admin/runs/11111111-1111-4111-8111-111111111111/log"), {});
  expect(readArtifact).toHaveBeenCalledWith("/primary", "logs/run.log");
  expect(response.end).toHaveBeenCalledWith(JSON.stringify({ run_id: "11111111-1111-4111-8111-111111111111", content: "renamed log" }));
  expect(query).toHaveBeenCalledTimes(1);
});


it("does not abandon a log when its artifact root is temporarily unavailable", async () => {
  query.mockResolvedValueOnce({ rows: [{ id: "11111111-1111-4111-8111-111111111111", artifact_id: "22222222-2222-4222-8222-222222222222", storage_path: "logs/run.log", status: "finalized", storage_root: "legacy" }] });
  readArtifact.mockRejectedValueOnce(new Error("artifact is missing"));
  const response: any = { writeHead: vi.fn(), end: vi.fn() };
  await adminApi({ method: "GET" } as any, response, new URL("http://test/api/admin/runs/11111111-1111-4111-8111-111111111111/log"), {});
  expect(query).toHaveBeenCalledTimes(1);
  expect(response.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
  expect(response.end).toHaveBeenCalledWith(JSON.stringify({ error: "execution log not found" }));
});
