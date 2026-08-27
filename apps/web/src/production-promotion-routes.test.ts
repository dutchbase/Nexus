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

const vaJobsPlatformId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const otherProjectId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const masterSha = "a".repeat(40);

const actionsDeploymentConfig = {
  enabled: true,
  mechanism: "github_actions_jobs",
  production_branch: "production",
  image: { registry: "ghcr.io", repository: "dutchbase/va-jobs-platform", tag_template: "sha-{{commit}}" },
  promotion: { require_e2e_gate_label: false },
  actions: { docker_image_job_name: "docker-image", migrations_job_name: "migrations-production", deploy_job_name: "deploy-production" },
};

beforeEach(() => {
  pool.query.mockReset();
  pool.query.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (sql.includes("FROM projects")) {
      const id = params?.[0];
      if (id === vaJobsPlatformId) {
        return { rows: [{ id: vaJobsPlatformId, slug: "va-jobs-platform", config_json: { deployment: actionsDeploymentConfig } }] };
      }
      if (id === otherProjectId) {
        return { rows: [{ id: otherProjectId, slug: "some-other-project", config_json: { deployment: { ...actionsDeploymentConfig, image: { ...actionsDeploymentConfig.image, repository: "acme/other" } } } }] };
      }
      return { rows: [] };
    }
    return { rows: [] };
  });
});

test("promote-force route is rejected for a project not on the production-promotion allowlist", async () => {
  const response = newResponse();
  await adminApi(
    request({ commit_sha: masterSha, expected_master_sha: masterSha, confirm_diverged: true }),
    response,
    new URL(`http://test/api/admin/projects/${otherProjectId}/deployment/promote-force`),
    { user_id: "admin" },
  );

  expect(response.writeHead).toHaveBeenCalledWith(403, expect.any(Object));
  expect(pool.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO jobs"))).toBe(false);
});

test("promote-force route requires confirm_diverged:true in the body", async () => {
  const response = newResponse();
  await adminApi(
    request({ commit_sha: masterSha, expected_master_sha: masterSha }),
    response,
    new URL(`http://test/api/admin/projects/${vaJobsPlatformId}/deployment/promote-force`),
    { user_id: "admin" },
  );

  expect(response.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
  expect(pool.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO jobs"))).toBe(false);
});

test("promote-force route enqueues deployment.promote with force:true and maxAttempts:1", async () => {
  const response = newResponse();
  await adminApi(
    request({ commit_sha: masterSha, expected_master_sha: masterSha, confirm_diverged: true }),
    response,
    new URL(`http://test/api/admin/projects/${vaJobsPlatformId}/deployment/promote-force`),
    { user_id: "admin" },
  );

  expect(response.writeHead).toHaveBeenCalledWith(202, expect.any(Object));
  const enqueue = pool.query.mock.calls.find(([sql]) => sql.includes("INSERT INTO jobs"));
  expect(enqueue).toBeDefined();
  const values = enqueue![1] as unknown[];
  // INSERT INTO jobs (type, status, priority, payload_json, idempotency_key, max_attempts, available_at, rerun_of)
  const payload = values[2] as Record<string, unknown>;
  expect(payload.force).toBe(true);
  expect(values[4]).toBe(1); // max_attempts
});

test("normal promote route (unchanged) still uses maxAttempts:1 too — 422 must never auto-retry regardless of force", async () => {
  const response = newResponse();
  await adminApi(
    request({ commit_sha: masterSha, expected_master_sha: masterSha }),
    response,
    new URL(`http://test/api/admin/projects/${vaJobsPlatformId}/deployment/promote`),
    { user_id: "admin" },
  );

  expect(response.writeHead).toHaveBeenCalledWith(202, expect.any(Object));
  const enqueue = pool.query.mock.calls.find(([sql]) => sql.includes("INSERT INTO jobs"));
  expect(enqueue).toBeDefined();
  const values = enqueue![1] as unknown[];
  expect(values[4]).toBe(1); // max_attempts
});
