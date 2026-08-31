import { beforeEach, describe, expect, test, vi } from "vitest";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pg from "pg";

process.env.DCC_PROCESS_ROLE = "web";
process.env.DATABASE_URL = process.env.DCC_TEST_DATABASE_URL ?? "postgres://unused:unused@127.0.0.1:1/unused";

const testDatabaseUrl = process.env.DCC_TEST_DATABASE_URL;
const integration = testDatabaseUrl ? describe : describe.skip;

function postRequest(body: string) {
  return {
    method: "POST", headers: {}, socket: { remoteAddress: "127.0.0.1" },
    async *[Symbol.asyncIterator]() { yield Buffer.from(body); },
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

integration("POST /api/admin/projects rejects a duplicate GitHub repo", () => {
  beforeEach(async () => {
    const directory = await mkdtemp(join(tmpdir(), "dcc-dup-repo-guard-"));
    try {
      await cp(new URL("../../../packages/database/migrations/", import.meta.url), directory, { recursive: true });
      await withClient((client) => client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;"));
      const { migrate } = await import("../../../packages/database/src/migrate.ts");
      await migrate({ connectionString: testDatabaseUrl!, directory });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    await withClient((client) => client.query(
      "INSERT INTO projects (slug,name,repository_path,default_branch,github_owner,github_repository) VALUES ('p','P','/tmp/p','main','acme','widgets')",
    ));
  });

  test("second project for the same owner/repo is rejected with 400, not inserted", async () => {
    const { adminApi } = await import("./server.ts");
    const body = JSON.stringify({
      slug: "p2", name: "P2", repository_path: "/tmp/p2",
      github_owner: "acme", github_repository: "widgets",
    });
    const response = newResponse();
    const projectsBefore = await withClient((client) => client.query("SELECT count(*) FROM projects"));

    await adminApi(postRequest(body), response, new URL("http://test/api/admin/projects"), { user_id: "admin" });

    expect(response.writeHead).toHaveBeenCalledWith(400, expect.anything());
    const projectsAfter = await withClient((client) => client.query("SELECT count(*) FROM projects"));
    expect(Number(projectsAfter.rows[0].count)).toBe(Number(projectsBefore.rows[0].count));
  });
});
