import { beforeEach, describe, expect, test, vi } from "vitest";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pg from "pg";

process.env.DCC_PROCESS_ROLE = "web";
process.env.DATABASE_URL = process.env.DCC_TEST_DATABASE_URL ?? "postgres://unused:unused@127.0.0.1:1/unused";

const testDatabaseUrl = process.env.DCC_TEST_DATABASE_URL;
const integration = testDatabaseUrl ? describe : describe.skip;

const projectId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const validatePath = `http://test/api/admin/projects/${projectId}/validate`;

function request() {
  return {
    method: "POST", headers: {}, socket: { remoteAddress: "127.0.0.1" },
    async *[Symbol.asyncIterator]() { yield Buffer.from("{}"); },
  } as any;
}

function newResponse() {
  return { writeHead: vi.fn(), end: vi.fn((body?: unknown) => body) } as any;
}

async function withClient<T>(use: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: testDatabaseUrl });
  await client.connect();
  try {
    return await use(client);
  } finally {
    await client.end();
  }
}

// The unit-level sibling (project-validate-recheck.test.ts) pins the key
// shape; this one proves what that shape actually buys against real Postgres
// ON CONFLICT semantics — a second Recheck after the first job reached a
// terminal state produces a genuinely runnable (queued) job.
integration("Recheck repository re-runs after the first validation completes", () => {
  beforeEach(async () => {
    const directory = await mkdtemp(join(tmpdir(), "dcc-validate-recheck-"));
    try {
      await cp(new URL("../../../packages/database/migrations/", import.meta.url), directory, { recursive: true });
      await withClient((client) => client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;"));
      const { migrate } = await import("../../../packages/database/src/migrate.ts");
      await migrate({ connectionString: testDatabaseUrl!, directory });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    await withClient((client) => client.query(
      "INSERT INTO projects (id,slug,name,repository_path,default_branch) VALUES ($1,'p','P','/tmp/p','main')",
      [projectId],
    ));
  });

  test("a second Recheck after the first job completes queues a runnable job", async () => {
    const { adminApi } = await import("./server.ts");

    await adminApi(request(), newResponse(), new URL(validatePath), { user_id: "admin" });
    // The worker claims and finishes the first validation.
    await withClient((client) => client.query("UPDATE jobs SET status='completed',completed_at=now() WHERE type='project.validate'"));

    await adminApi(request(), newResponse(), new URL(validatePath), { user_id: "admin" });

    const jobs = await withClient(async (client) => (await client.query(
      "SELECT status FROM jobs WHERE type='project.validate' ORDER BY created_at",
    )).rows);
    expect(jobs).toHaveLength(2);
    expect(jobs.map((job) => job.status)).toEqual(["completed", "queued"]);
  });
});
