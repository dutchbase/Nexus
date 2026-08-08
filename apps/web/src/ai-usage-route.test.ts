import { beforeEach, expect, it, vi } from "vitest";

process.env.DCC_PROCESS_ROLE = "web";
const query = vi.fn();
vi.mock("@dcc/database", () => ({
  artifactDataRoot: () => "/primary", legacyArtifactDataRoot: () => "/legacy", finalizeArtifact: vi.fn(), inTransaction: vi.fn(),
  pool: { query }, readArtifact: vi.fn(), readStagedArtifact: vi.fn(), stageArtifact: vi.fn(),
}));

const { adminHtml } = await import("./server.ts");

beforeEach(() => query.mockReset());

it("routes authenticated administrators to the AI usage dashboard", async () => {
  query.mockImplementation(async (sql: string) => {
    if (String(sql).includes("FROM admin_sessions")) return { rows: [{ user_id: "admin", username: "admin", role: "admin" }] };
    if (String(sql).includes("SELECT\n    (SELECT count(*)::integer")) return { rows: [{}] };
    if (String(sql).includes("count(*)::integer AS invocations")) return { rows: [{ invocations: 0, captured_tokens: 0, estimated_cost_usd: 0, coverage_exceptions: 0 }] };
    if (String(sql).includes("FROM agent_runs ar")) return { rows: [] };
    return { rows: [] };
  });
  const response: any = { writeHead: vi.fn(), end: vi.fn() };

  await adminHtml({ method: "GET", headers: { cookie: "dcc_session=token" } } as any, response, new URL("http://test/admin/ai-usage"));

  expect(response.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
  expect(response.end).toHaveBeenCalledWith(expect.stringContaining("AI usage"));
});
