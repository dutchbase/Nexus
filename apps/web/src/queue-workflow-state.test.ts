import { beforeEach, expect, test, vi } from "vitest";

process.env.DCC_PROCESS_ROLE = "web";

const query = vi.fn();
vi.mock("@dcc/database", () => ({
  artifactDataRoot: () => "/primary", legacyArtifactDataRoot: () => "/legacy",
  finalizeArtifact: vi.fn(), inTransaction: vi.fn(), pool: { query },
  readArtifact: vi.fn(), readStagedArtifact: vi.fn(), stageArtifact: vi.fn(),
}));

const queue = await import("./pages/queue.ts");
const { adminApi } = await import("./server.ts");

const job = {
  id: "11111111-1111-4111-8111-111111111111", type: "workflow", priority: "normal",
  attempt: 1, max_attempts: 3, status: "running", ticket_label: "T-17", project_name: "Console",
  claimed_at: "2026-08-03T10:00:00.000Z", claimed_by: "worker-1",
  lease_expires_at: "2026-08-03T10:02:00.000Z", rerun_of: "22222222-2222-4222-8222-222222222222",
  recovery_reason: "lease_expired", updated_at: new Date().toISOString(),
};

beforeEach(() => query.mockReset());

test("queue reports sequential capacity and the running job's workflow state", async () => {
  query.mockImplementation(async (sql?: string) => {
    if (!sql) return { rows: [] };
    if (sql.includes("FROM jobs j")) return { rows: [job] };
    if (sql.includes("SELECT DISTINCT status")) return { rows: [{ status: "running" }] };
    if (sql.includes("SELECT DISTINCT type")) return { rows: [{ type: "workflow" }] };
    if (sql.includes("GROUP BY status")) return { rows: [{ status: "running", c: 1 }] };
    if (sql.includes("MAX(updated_at)") && sql.includes("status='running'")) return { rows: [{ hb: job.updated_at }] };
    throw new Error(`unexpected query: ${sql}`);
  });

  const page = await queue.render(new URL("http://test/admin/queue"), { username: "admin", user_id: "admin" }, {});

  expect(page?.body).toContain("1 total · sequential");
  expect(page?.body).toContain("1 observed running");
  expect(page?.body).toContain("worker-1");
  expect(page?.body).toContain("lease expires");
  expect(page?.body).toContain("rerun of JOB-2222");
  expect(page?.body).toContain("recovery: lease expired");
});

test("jobs API returns the observed running count with jobs", async () => {
  query.mockImplementation(async (sql?: string) => {
    if (!sql) return { rows: [] };
    if (sql.includes("SELECT * FROM jobs")) return { rows: [job] };
    if (sql.includes("count(*)") && sql.includes("status='running'")) return { rows: [{ observed_running: 1 }] };
    throw new Error(`unexpected query: ${sql}`);
  });
  const response: any = { writeHead: vi.fn(), end: vi.fn() };

  await adminApi({ method: "GET" } as any, response, new URL("http://test/api/admin/jobs"), { user_id: "admin" });

  expect(JSON.parse(response.end.mock.calls[0][0])).toMatchObject({
    jobs: [job], capacity: { configured: 1, observed_running: 1 },
  });
});
