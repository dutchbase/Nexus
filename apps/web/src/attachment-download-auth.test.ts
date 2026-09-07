import { createHash } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";

process.env.DCC_PROCESS_ROLE = "web";

const query = vi.fn();
const readArtifact = vi.fn();

vi.mock("@dcc/database", () => ({
  artifactDataRoot: () => "/primary", legacyArtifactDataRoot: () => "/legacy",
  finalizeArtifact: vi.fn(), inTransaction: vi.fn(), pool: { query }, readArtifact, readStagedArtifact: vi.fn(), stageArtifact: vi.fn(),
}));

const { adminHtml, readUploadArtifact } = await import("./server.ts");

beforeEach(() => { query.mockReset(); readArtifact.mockReset(); });

it("redirects an unauthenticated attachment download request to /login without touching the database", async () => {
  const request: any = { method: "GET", headers: {} };
  const response: any = { writeHead: vi.fn(), end: vi.fn() };

  await adminHtml(request, response, new URL("http://test/admin/attachments/11111111-1111-4111-8111-111111111111"));

  expect(response.writeHead).toHaveBeenCalledWith(302, { location: "/login" });
  expect(query).not.toHaveBeenCalled();
  expect(readArtifact).not.toHaveBeenCalled();
});

it("reads registered uploads only from their authoritative root and verifies their hash", async () => {
  const bytes = Buffer.from("image bytes");
  readArtifact.mockResolvedValue(bytes);
  const content = await readUploadArtifact({
    artifact_id: "artifact-1", artifact_status: "finalized", storage_root: "legacy",
    artifact_storage_path: "uploads/a.png", artifact_sha256: createHash("sha256").update(bytes).digest("hex"),
    upload_storage_path: "/primary/uploads/a.png",
  });
  expect(content).toEqual(bytes);
  expect(readArtifact).toHaveBeenCalledTimes(1);
  expect(readArtifact).toHaveBeenCalledWith("/legacy", "uploads/a.png");
});

it("does not revive an abandoned registered upload through its legacy path", async () => {
  await expect(readUploadArtifact({
    artifact_id: "artifact-1", artifact_status: "abandoned", storage_root: "primary",
    artifact_storage_path: "uploads/a.png", artifact_sha256: null, upload_storage_path: "/primary/uploads/a.png",
  })).rejects.toThrow(/unavailable/);
  expect(readArtifact).not.toHaveBeenCalled();
});
