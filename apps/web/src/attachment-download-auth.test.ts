import { beforeEach, expect, it, vi } from "vitest";

process.env.DCC_PROCESS_ROLE = "web";

const query = vi.fn();
const readArtifact = vi.fn();

vi.mock("@dcc/database", () => ({
  artifactDataRoot: () => "/primary", legacyArtifactDataRoot: () => "/legacy",
  finalizeArtifact: vi.fn(), inTransaction: vi.fn(), pool: { query }, readArtifact, readStagedArtifact: vi.fn(), stageArtifact: vi.fn(),
}));

const { adminHtml } = await import("./server.ts");

beforeEach(() => { query.mockReset(); readArtifact.mockReset(); });

it("redirects an unauthenticated attachment download request to /login without touching the database", async () => {
  const request: any = { method: "GET", headers: {} };
  const response: any = { writeHead: vi.fn(), end: vi.fn() };

  await adminHtml(request, response, new URL("http://test/admin/attachments/11111111-1111-4111-8111-111111111111"));

  expect(response.writeHead).toHaveBeenCalledWith(302, { location: "/login" });
  expect(query).not.toHaveBeenCalled();
  expect(readArtifact).not.toHaveBeenCalled();
});
