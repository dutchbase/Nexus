import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pg from "pg";

process.env.DATABASE_URL = process.env.DCC_TEST_DATABASE_URL ?? "postgres://unused:unused@127.0.0.1:1/unused";
const { migrate } = await import("../../database/src/migrate.ts");
const { createAiInvocation, recordAiUnavailable, recordAiUsage } = await import("./index.ts");

const testDatabaseUrl = process.env.DCC_TEST_DATABASE_URL;
const integration = testDatabaseUrl ? describe : describe.skip;
let migrationDirectory = "";

async function resetDatabase() {
  const client = new pg.Client({ connectionString: testDatabaseUrl });
  await client.connect();
  try { await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;"); } finally { await client.end(); }
}

integration("AI invocation accounting persistence", () => {
  beforeAll(async () => {
    migrationDirectory = await mkdtemp(join(tmpdir(), "dcc-ai-accounting-"));
    await cp(new URL("../../database/migrations/", import.meta.url), migrationDirectory, { recursive: true });
  });
  beforeEach(async () => { await resetDatabase(); await migrate({ connectionString: testDatabaseUrl!, directory: migrationDirectory }); });
  afterAll(async () => { if (migrationDirectory) await rm(migrationDirectory, { recursive: true, force: true }); });

  it("uses the price effective at invocation start, retains that historic price, and leaves unpriced usage cost-null", async () => {
    const client = new pg.Client({ connectionString: testDatabaseUrl });
    await client.connect();
    try {
      const projectId = (await client.query("INSERT INTO projects (slug,name,repository_path) VALUES ('prices','Prices','/tmp') RETURNING id")).rows[0].id;
      await client.query(`INSERT INTO ai_model_prices
        (model,provider,effective_from,input_usd_per_million,output_usd_per_million,cache_write_usd_per_million,cache_read_usd_per_million,source_url)
        VALUES ('sonnet','anthropic','2026-01-01',10,20,30,40,'https://example.test/old')`);
      await createAiInvocation({ id: "priced", projectId, runType: "planning", model: "sonnet", reasoningLevel: "high", startedAt: new Date("2026-06-01T00:00:00Z") }, client);
      const priced = await recordAiUsage({ runId: "priced", inputTokens: 1_000_000, outputTokens: 1_000_000, cacheWriteTokens: 1_000_000, cacheReadTokens: 1_000_000, rawUsage: {} }, client);
      expect(priced.total_tokens).toBe("4000000");
      expect(priced.estimated_cost_usd).toBe("100.0000000000");
      expect((await client.query("SELECT source_url FROM ai_model_prices WHERE id=$1", [priced.ai_model_price_id])).rows[0].source_url).toBe("https://example.test/old");
      await client.query(`INSERT INTO ai_model_prices
        (model,provider,effective_from,input_usd_per_million,output_usd_per_million,cache_write_usd_per_million,cache_read_usd_per_million,source_url)
        VALUES ('sonnet','anthropic','2027-01-01',100,200,300,400,'https://example.test/new')`);
      expect((await client.query("SELECT ai_model_price_id,estimated_cost_usd FROM agent_runs WHERE id='priced' ")).rows[0])
        .toEqual({ ai_model_price_id: priced.ai_model_price_id, estimated_cost_usd: "100.0000000000" });

      await createAiInvocation({ id: "unpriced", projectId, runType: "planning", model: "haiku", reasoningLevel: "low", startedAt: new Date("2020-01-01T00:00:00Z") }, client);
      const unpriced = await recordAiUsage({ runId: "unpriced", inputTokens: 1, outputTokens: 1, rawUsage: {} }, client);
      expect(unpriced.ai_model_price_id).toBeNull();
      expect(unpriced.estimated_cost_usd).toBeNull();
      expect((await client.query("INSERT INTO agent_runs (status) VALUES ('completed') RETURNING ai_usage_status,total_tokens")).rows[0]).toEqual({ ai_usage_status: null, total_tokens: null });
    } finally { await client.end(); }
  });

  it("defaults billing_mode to subscription and persists an explicit api mode", async () => {
    const client = new pg.Client({ connectionString: testDatabaseUrl });
    await client.connect();
    try {
      const projectId = (await client.query("INSERT INTO projects (slug,name,repository_path) VALUES ('billing','Billing','/tmp') RETURNING id")).rows[0].id;
      await createAiInvocation({ id: "billing-default", projectId, runType: "planning", model: "sonnet", reasoningLevel: "high" }, client);
      expect((await client.query("SELECT billing_mode FROM agent_runs WHERE id='billing-default'")).rows[0].billing_mode).toBe("subscription");

      await createAiInvocation({ id: "billing-api", projectId, runType: "planning", model: "deepseek-v4-flash", reasoningLevel: "high", billingMode: "api" }, client);
      expect((await client.query("SELECT billing_mode FROM agent_runs WHERE id='billing-api'")).rows[0].billing_mode).toBe("api");
    } finally { await client.end(); }
  });

  it("does not replace terminal captured accounting", async () => {
    const client = new pg.Client({ connectionString: testDatabaseUrl });
    await client.connect();
    try {
      const projectId = (await client.query("INSERT INTO projects (slug,name,repository_path) VALUES ('idempotent','Idempotent','/tmp') RETURNING id")).rows[0].id;
      await createAiInvocation({ id: "once", projectId, runType: "planning", model: "sonnet", reasoningLevel: "high", startedAt: new Date("2026-09-01T00:00:00Z") }, client);
      await recordAiUsage({ runId: "once", inputTokens: 10, outputTokens: 20, rawUsage: { attempt: 1 } }, client);
      expect((await recordAiUsage({ runId: "once", inputTokens: 100, outputTokens: 200, rawUsage: { attempt: 2 } }, client)).total_tokens).toBe("30");
      expect((await recordAiUnavailable("once", client)).usage_status).toBe("captured");
    } finally { await client.end(); }
  });

  it("does not permit raw provider usage on pending or unavailable invocations", async () => {
    const client = new pg.Client({ connectionString: testDatabaseUrl });
    await client.connect();
    try {
      const projectId = (await client.query("INSERT INTO projects (slug,name,repository_path) VALUES ('raw-usage','Raw usage','/tmp') RETURNING id")).rows[0].id;
      await createAiInvocation({ id: "pending-raw", projectId, runType: "planning", model: "sonnet", reasoningLevel: "high" }, client);
      await expect(client.query("UPDATE agent_runs SET raw_usage_json='{}' WHERE id='pending-raw'"))
        .rejects.toThrow(/agent_runs_ai_accounting_check/);
      await createAiInvocation({ id: "unavailable-raw", projectId, runType: "planning", model: "sonnet", reasoningLevel: "high" }, client);
      await recordAiUnavailable("unavailable-raw", client);
      await expect(client.query("UPDATE agent_runs SET raw_usage_json='{}' WHERE id='unavailable-raw'"))
        .rejects.toThrow(/agent_runs_ai_accounting_check/);
    } finally { await client.end(); }
  });

  it("returns the terminal row when a concurrent caller wins the row lock", async () => {
    const client = new pg.Client({ connectionString: testDatabaseUrl });
    const contender = new pg.Client({ connectionString: testDatabaseUrl });
    await client.connect();
    await contender.connect();
    try {
      const projectId = (await client.query("INSERT INTO projects (slug,name,repository_path) VALUES ('concurrent','Concurrent','/tmp') RETURNING id")).rows[0].id;
      await createAiInvocation({ id: "contended", projectId, runType: "planning", model: "sonnet", reasoningLevel: "high" }, client);
      await client.query("BEGIN");
      await client.query("SELECT id FROM agent_runs WHERE id='contended' FOR UPDATE");
      const loser = recordAiUsage({ runId: "contended", inputTokens: 1, outputTokens: 1, rawUsage: {} }, contender);
      await client.query("UPDATE agent_runs SET ai_usage_status='unavailable' WHERE id='contended'");
      await client.query("COMMIT");
      await expect(loser).resolves.toMatchObject({ id: "contended", ai_usage_status: "unavailable" });
    } finally { await client.query("ROLLBACK").catch(() => undefined); await contender.end(); await client.end(); }
  });
});
