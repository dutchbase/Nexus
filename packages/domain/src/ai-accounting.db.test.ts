import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
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
      const pricedId = randomUUID();
      await createAiInvocation({ id: pricedId, projectId, runType: "planning", model: "sonnet", reasoningLevel: "high", startedAt: new Date("2026-06-01T00:00:00Z") }, client);
      const priced = await recordAiUsage({ runId: pricedId, inputTokens: 1_000_000, outputTokens: 1_000_000, cacheWriteTokens: 1_000_000, cacheReadTokens: 1_000_000, rawUsage: {} }, client);
      expect(priced.total_tokens).toBe("4000000");
      expect(priced.estimated_cost_usd).toBe("100.0000000000");
      expect((await client.query("SELECT source_url FROM ai_model_prices WHERE id=$1", [priced.ai_model_price_id])).rows[0].source_url).toBe("https://example.test/old");
      await client.query(`INSERT INTO ai_model_prices
        (model,provider,effective_from,input_usd_per_million,output_usd_per_million,cache_write_usd_per_million,cache_read_usd_per_million,source_url)
        VALUES ('sonnet','anthropic','2027-01-01',100,200,300,400,'https://example.test/new')`);
      expect((await client.query("SELECT ai_model_price_id,estimated_cost_usd FROM agent_runs WHERE id=$1", [pricedId])).rows[0])
        .toEqual({ ai_model_price_id: priced.ai_model_price_id, estimated_cost_usd: "100.0000000000" });

      const unpricedId = randomUUID();
      await createAiInvocation({ id: unpricedId, projectId, runType: "planning", model: "haiku", reasoningLevel: "low", startedAt: new Date("2020-01-01T00:00:00Z") }, client);
      const unpriced = await recordAiUsage({ runId: unpricedId, inputTokens: 1, outputTokens: 1, rawUsage: {} }, client);
      expect(unpriced.ai_model_price_id).toBeNull();
      expect(unpriced.estimated_cost_usd).toBeNull();
      expect((await client.query("INSERT INTO agent_runs (status) VALUES ('completed') RETURNING ai_usage_status,total_tokens")).rows[0]).toEqual({ ai_usage_status: null, total_tokens: null });
    } finally { await client.end(); }
  });

  // Regression test for the recordAiUsage SQL type-mismatch bug: without
  // explicit ::bigint casts on every $2/$3/$5/$6 occurrence in the UPDATE
  // statement (see packages/domain/src/index.ts recordAiUsage), Postgres
  // fails to unify a single type for placeholders used both as a bare
  // bigint-column assignment and inside numeric(20,8) arithmetic, throwing
  // "inconsistent types deduced for parameter $2". This never surfaced in
  // the mocked-client unit tests (ai-accounting.test.ts) because those mock
  // the query client entirely, and this file's own tests never previously
  // ran against real Postgres (they used non-UUID literal ids like "priced",
  // which fail agent_runs.id's uuid column type before reaching the SQL
  // bug). Exercises all five AiUsage fields — inputTokens, outputTokens,
  // reasoningTokens, cacheReadTokens, cacheWriteTokens — so every casted
  // placeholder is populated with a real value.
  it("records usage with every AiUsage field populated (regression: ::bigint casts in recordAiUsage)", async () => {
    const client = new pg.Client({ connectionString: testDatabaseUrl });
    await client.connect();
    try {
      const projectId = (await client.query("INSERT INTO projects (slug,name,repository_path) VALUES ('full-usage','Full usage','/tmp') RETURNING id")).rows[0].id;
      await client.query(`INSERT INTO ai_model_prices
        (model,provider,effective_from,input_usd_per_million,output_usd_per_million,cache_write_usd_per_million,cache_read_usd_per_million,source_url)
        VALUES ('sonnet','anthropic','2026-01-01',10,20,30,40,'https://example.test/full')`);
      const runId = randomUUID();
      await createAiInvocation({ id: runId, projectId, runType: "planning", model: "sonnet", reasoningLevel: "high", startedAt: new Date("2026-06-01T00:00:00Z") }, client);

      const result = await recordAiUsage(
        {
          runId,
          inputTokens: 1000,
          outputTokens: 500,
          reasoningTokens: 250,
          cacheReadTokens: 100,
          cacheWriteTokens: 50,
          rawUsage: { source: "regression-test" },
        },
        client,
      );

      expect(result.ai_usage_status).toBe("captured");
      expect(result.input_tokens).toBe("1000");
      expect(result.output_tokens).toBe("500");
      expect(result.reasoning_tokens).toBe("250");
      expect(result.cache_read_tokens).toBe("100");
      expect(result.cache_write_tokens).toBe("50");
      expect(result.total_tokens).toBe("1650"); // input + output + cacheRead + cacheWrite
      // (1000*10 + 500*20 + 100*40 + 50*30) / 1_000_000 = 25500/1_000_000
      expect(result.estimated_cost_usd).toBe("0.0255000000");
    } finally { await client.end(); }
  });

  it("defaults billing_mode to subscription and persists an explicit api mode", async () => {
    const client = new pg.Client({ connectionString: testDatabaseUrl });
    await client.connect();
    try {
      const projectId = (await client.query("INSERT INTO projects (slug,name,repository_path) VALUES ('billing','Billing','/tmp') RETURNING id")).rows[0].id;
      const defaultId = randomUUID();
      await createAiInvocation({ id: defaultId, projectId, runType: "planning", model: "sonnet", reasoningLevel: "high" }, client);
      expect((await client.query("SELECT billing_mode FROM agent_runs WHERE id=$1", [defaultId])).rows[0].billing_mode).toBe("subscription");

      const apiId = randomUUID();
      await createAiInvocation({ id: apiId, projectId, runType: "planning", model: "deepseek-v4-flash", reasoningLevel: "high", billingMode: "api" }, client);
      expect((await client.query("SELECT billing_mode FROM agent_runs WHERE id=$1", [apiId])).rows[0].billing_mode).toBe("api");
    } finally { await client.end(); }
  });

  it("does not replace terminal captured accounting", async () => {
    const client = new pg.Client({ connectionString: testDatabaseUrl });
    await client.connect();
    try {
      const projectId = (await client.query("INSERT INTO projects (slug,name,repository_path) VALUES ('idempotent','Idempotent','/tmp') RETURNING id")).rows[0].id;
      const onceId = randomUUID();
      await createAiInvocation({ id: onceId, projectId, runType: "planning", model: "sonnet", reasoningLevel: "high", startedAt: new Date("2026-09-01T00:00:00Z") }, client);
      await recordAiUsage({ runId: onceId, inputTokens: 10, outputTokens: 20, rawUsage: { attempt: 1 } }, client);
      expect((await recordAiUsage({ runId: onceId, inputTokens: 100, outputTokens: 200, rawUsage: { attempt: 2 } }, client)).total_tokens).toBe("30");
      expect((await recordAiUnavailable(onceId, client)).ai_usage_status).toBe("captured");
    } finally { await client.end(); }
  });

  it("does not permit raw provider usage on pending or unavailable invocations", async () => {
    const client = new pg.Client({ connectionString: testDatabaseUrl });
    await client.connect();
    try {
      const projectId = (await client.query("INSERT INTO projects (slug,name,repository_path) VALUES ('raw-usage','Raw usage','/tmp') RETURNING id")).rows[0].id;
      const pendingRawId = randomUUID();
      await createAiInvocation({ id: pendingRawId, projectId, runType: "planning", model: "sonnet", reasoningLevel: "high" }, client);
      await expect(client.query("UPDATE agent_runs SET raw_usage_json='{}' WHERE id=$1", [pendingRawId]))
        .rejects.toThrow(/agent_runs_ai_accounting_check/);
      const unavailableRawId = randomUUID();
      await createAiInvocation({ id: unavailableRawId, projectId, runType: "planning", model: "sonnet", reasoningLevel: "high" }, client);
      await recordAiUnavailable(unavailableRawId, client);
      await expect(client.query("UPDATE agent_runs SET raw_usage_json='{}' WHERE id=$1", [unavailableRawId]))
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
      const contendedId = randomUUID();
      await createAiInvocation({ id: contendedId, projectId, runType: "planning", model: "sonnet", reasoningLevel: "high" }, client);
      await client.query("BEGIN");
      await client.query("SELECT id FROM agent_runs WHERE id=$1 FOR UPDATE", [contendedId]);
      const loser = recordAiUsage({ runId: contendedId, inputTokens: 1, outputTokens: 1, rawUsage: {} }, contender);
      await client.query("UPDATE agent_runs SET ai_usage_status='unavailable' WHERE id=$1", [contendedId]);
      await client.query("COMMIT");
      await expect(loser).resolves.toMatchObject({ id: contendedId, ai_usage_status: "unavailable" });
    } finally { await client.query("ROLLBACK").catch(() => undefined); await contender.end(); await client.end(); }
  });
});
