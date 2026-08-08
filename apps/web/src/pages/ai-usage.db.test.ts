import { afterAll, beforeAll, describe, expect, it } from "vitest";

const testDatabaseUrl = process.env.DCC_TEST_DATABASE_URL;
process.env.DATABASE_URL = testDatabaseUrl ?? "postgres://unused:unused@127.0.0.1:1/unused";

const integration = testDatabaseUrl ? describe : describe.skip;
const { pool } = await import("@dcc/database");
const { migrate } = await import("../../../../packages/database/src/migrate.ts");
const { createAiInvocation, recordAiUnavailable, recordAiUsage } = await import("@dcc/domain");
const usage = await import("./ai-usage.ts");

integration("AI usage dashboard queries", () => {
  beforeAll(async () => {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await migrate({ connectionString: testDatabaseUrl! });
  });
  afterAll(async () => { await pool.end(); });

  it("queries only AI phases and counts captured unpriced usage as a coverage exception", async () => {
    const projectId = (await pool.query(
      "INSERT INTO projects (slug,name,repository_path) VALUES ('ai-usage-query','AI usage query','/tmp') RETURNING id",
    )).rows[0].id;
    await createAiInvocation({ id: "00000000-0000-4000-8000-000000000001", projectId, runType: "planning", model: "sonnet", reasoningLevel: "high", startedAt: new Date("2026-08-09T00:00:00Z") });
    await recordAiUsage({ runId: "00000000-0000-4000-8000-000000000001", inputTokens: 10, outputTokens: 20, rawUsage: {} });
    await createAiInvocation({ id: "00000000-0000-4000-8000-000000000002", projectId, runType: "execution", model: "sonnet", reasoningLevel: "high", startedAt: new Date("2020-01-01T00:00:00Z") });
    await recordAiUsage({ runId: "00000000-0000-4000-8000-000000000002", inputTokens: 10, outputTokens: 20, rawUsage: {} });
    await createAiInvocation({ id: "00000000-0000-4000-8000-000000000003", projectId, runType: "pr_ai_review", model: "sonnet", reasoningLevel: "high", startedAt: new Date("2026-08-09T00:00:00Z") });
    await recordAiUnavailable("00000000-0000-4000-8000-000000000003");
    await pool.query(
      "INSERT INTO agent_runs (id,project_id,run_type,status,started_at) VALUES ('00000000-0000-4000-8000-000000000004',$1,'validation','completed','2026-08-09')",
      [projectId],
    );

    const page = await usage.render(new URL("http://test/admin/ai-usage?all_time=1"), { username: "admin", user_id: "admin" }, {});

    expect(page?.body).toMatch(/Invocations[\s\S]*?<strong>3<\/strong>/);
    expect(page?.body).toMatch(/Coverage exceptions[\s\S]*?<strong>2<\/strong>/);
    expect(page?.body).not.toContain("00000000-0000-4000-8000-000000000004");
  });
});
