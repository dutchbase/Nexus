import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";

const testDatabaseUrl = process.env.DCC_TEST_DATABASE_URL;
process.env.DCC_PROCESS_ROLE = "web";
process.env.DATABASE_URL = testDatabaseUrl ?? "postgres://unused:unused@127.0.0.1:1/unused";
const integration = testDatabaseUrl ? describe : describe.skip;
const { pool } = await import("@dcc/database");
const { migrate } = await import("../../../packages/database/src/migrate.ts");
const { adminApi } = await import("./server.ts");

integration("project prompt archival", () => {
  let projectId: string, promptId: string;
  beforeAll(async () => {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await migrate({ connectionString: testDatabaseUrl! });
    projectId = (await pool.query("INSERT INTO projects (slug,name,repository_path) VALUES ('archive-test','Archive test','/tmp/archive-test') RETURNING id")).rows[0].id;
    promptId = (await pool.query("INSERT INTO prompt_files (scope,project_id,prompt_type,file_path) VALUES ('project',$1,'context','prompts/context.md') RETURNING id", [projectId])).rows[0].id;
    const versionId = (await pool.query("INSERT INTO prompt_versions (prompt_file_id,version,content,content_hash) VALUES ($1,1,'context',$2) RETURNING id", [promptId, createHash("sha256").update("context").digest("hex")])).rows[0].id;
    await pool.query("UPDATE prompt_files SET active_version_id=$2 WHERE id=$1", [promptId, versionId]);
  });
  afterAll(async () => { await pool.end(); });

  test("Archive keeps every immutable version and deactivates the prompt file", async () => {
    const before = Number((await pool.query("SELECT count(*) FROM prompt_versions WHERE prompt_file_id=$1", [promptId])).rows[0].count);
    const request: any = { method: "POST", headers: {}, socket: { remoteAddress: "127.0.0.1" }, async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify({ action: "archive", ids: [promptId] }));
    } };
    const response: any = { writeHead: vi.fn(), end: vi.fn() };
    await adminApi(request, response, new URL(`http://test/api/admin/projects/${projectId}/prompts/bulk`), {});
    expect(response.writeHead).toHaveBeenCalledWith(200, expect.anything());
    expect((await pool.query("SELECT active_version_id FROM prompt_files WHERE id=$1", [promptId])).rows[0].active_version_id).toBeNull();
    expect(Number((await pool.query("SELECT count(*) FROM prompt_versions WHERE prompt_file_id=$1", [promptId])).rows[0].count)).toBe(before);
  });
});
