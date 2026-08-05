import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import pg from "pg";

process.env.DATABASE_URL ??= "postgres://unused:unused@127.0.0.1:1/unused";
const { migrate } = await import("../packages/database/src/migrate.js");
const deployments = createRequire(import.meta.url)("../webhook-deployments.js");

const testDatabaseUrl = process.env.DCC_TEST_DATABASE_URL;
const integration = testDatabaseUrl ? describe : describe.skip;

let pool: pg.Pool;

const sha = (letter: string) => letter.repeat(40);
const attempt = (suffix: string) => ({
  deliveryId: `delivery-${suffix}`,
  eventType: "push",
  targetRef: "refs/heads/master",
  targetSha: sha(suffix),
  protectedBranch: "master",
  protectedHeadSha: sha(suffix),
  checkEvidence: { requiredCheck: "ci", conclusion: "success" },
});

function fakePool(reply: (text: string, values: unknown[], queries: Array<{ text: string; values: unknown[] }>) => { rows: unknown[] }) {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  return {
    queries,
    pool: {
      connect: async () => ({
        query: async (text: string, values: unknown[] = []) => {
          queries.push({ text, values });
          return reply(text, values, queries);
        },
        release() {},
      }),
    },
  };
}

describe("webhook deployment store query semantics", () => {
  it("persists a spawned child PID with its marker under the owner lease", async () => {
    const db = fakePool((text) => text.startsWith("UPDATE deployment_attempts SET marker_path")
      ? { rows: [{ id: "attempt", child_pid: 42 }] }
      : { rows: [] });

    await expect(deployments.recordDeploymentLaunch(db.pool, { attemptId: "attempt", owner: "webhook", markerPath: "/safe/attempt.done", childPid: 42 }))
      .resolves.toMatchObject({ id: "attempt", child_pid: 42 });
  });

  it("uses PostgreSQL time to retain a lease that appears expired to the host", async () => {
    const db = fakePool((text) => text.includes("lease_expires_at > now() AS lease_active")
      ? { rows: [{ id: "attempt", lease_expires_at: "1970-01-01T00:00:00.000Z", lease_active: true, recovery_count: 0 }] }
      : { rows: [] });

    await expect(deployments.claimDeploymentAttempt(db.pool, { owner: "webhook", leaseMs: 60_000 }))
      .resolves.toMatchObject({ kind: "busy", attempt: { id: "attempt" } });
  });

  it("prefers a delivery collision when delivery and SHA collisions coexist", async () => {
    const db = fakePool((text) => {
      if (text.startsWith("INSERT INTO deployment_attempts")) return { rows: [] };
      if (text.startsWith("SELECT *, CASE WHEN delivery_id")) {
        return { rows: [{ id: "delivery-attempt", duplicate: text.includes("ORDER BY CASE WHEN delivery_id=$1") ? "delivery" : "sha" }] };
      }
      return { rows: [] };
    });

    await expect(deployments.enqueueDeploymentAttempt(db.pool, attempt("a")))
      .resolves.toMatchObject({ created: false, duplicate: "delivery", attempt: { id: "delivery-attempt" } });
  });
});

integration("webhook deployment store", () => {
  beforeEach(async () => {
    const client = new pg.Client({ connectionString: testDatabaseUrl });
    await client.connect();
    try {
      await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    } finally {
      await client.end();
    }
    await migrate({ connectionString: testDatabaseUrl!, directory: new URL("../packages/database/migrations/", import.meta.url).pathname });
    pool = new pg.Pool({ connectionString: testDatabaseUrl });
  });

  afterEach(async () => {
    await pool?.end();
  });

  it("preserves immutable identity and deduplicates deliveries and SHAs", async () => {
    const first = await deployments.enqueueDeploymentAttempt(pool, attempt("a"));
    expect(first).toMatchObject({ created: true, duplicate: null });
    await expect(pool.query("UPDATE deployment_attempts SET target_sha=$1 WHERE id=$2", [sha("b"), first.attempt.id])).rejects.toThrow("immutable");

    await expect(deployments.enqueueDeploymentAttempt(pool, { ...attempt("b"), deliveryId: "delivery-a" })).resolves.toMatchObject({ created: false, duplicate: "delivery" });
    await expect(deployments.enqueueDeploymentAttempt(pool, { ...attempt("a"), deliveryId: "delivery-c" })).resolves.toMatchObject({ created: false, duplicate: "sha" });
  });

  it("keeps deployment events append-only and idempotent", async () => {
    const created = await deployments.enqueueDeploymentAttempt(pool, attempt("a"));
    const event = await deployments.appendDeploymentEvent(pool, {
      attemptId: created.attempt.id,
      eventKey: "queued",
      eventType: "queued",
      metadata: { source: "webhook" },
    });
    expect(event).toMatchObject({ event_key: "queued" });
    await expect(pool.query("UPDATE deployment_events SET event_type='changed' WHERE id=$1", [event.id])).rejects.toThrow("append-only");
    await expect(pool.query("DELETE FROM deployment_events WHERE id=$1", [event.id])).rejects.toThrow("append-only");
    await expect(deployments.appendDeploymentEvent(pool, {
      attemptId: created.attempt.id, eventKey: "queued", eventType: "queued", metadata: { source: "webhook" },
    })).resolves.toBeNull();
    await expect(pool.query(
      "INSERT INTO deployment_events (attempt_id,event_key,event_type,metadata) VALUES ($1,$2,$3,$4::jsonb)",
      [created.attempt.id, "unsafe-nested", "queued", JSON.stringify({ diagnostic: { token: "secret" } })],
    )).rejects.toThrow();
  });

  it("allows only one running attempt", async () => {
    const first = await deployments.enqueueDeploymentAttempt(pool, attempt("a"));
    await deployments.enqueueDeploymentAttempt(pool, attempt("b"));
    await expect(deployments.claimDeploymentAttempt(pool, { owner: "webhook-a", leaseMs: 60_000 })).resolves.toMatchObject({ kind: "claimed", attempt: { id: first.attempt.id, state: "running" } });
    await expect(deployments.claimDeploymentAttempt(pool, { owner: "webhook-b", leaseMs: 60_000 })).resolves.toMatchObject({ kind: "busy", attempt: { id: first.attempt.id } });
  });

  it("renews once, recovers once, then blocks without promoting the queue", async () => {
    const first = await deployments.enqueueDeploymentAttempt(pool, attempt("a"));
    const second = await deployments.enqueueDeploymentAttempt(pool, attempt("b"));
    await deployments.claimDeploymentAttempt(pool, { owner: "webhook-a", leaseMs: 60_000 });
    await expect(deployments.renewDeploymentLease(pool, { attemptId: first.attempt.id, owner: "webhook-a", leaseMs: 60_000 })).resolves.toMatchObject({ id: first.attempt.id, state: "running" });

    await pool.query("UPDATE deployment_attempts SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [first.attempt.id]);
    await expect(deployments.renewDeploymentLease(pool, { attemptId: first.attempt.id, owner: "webhook-a", leaseMs: 60_000 })).resolves.toBeNull();
    await expect(deployments.completeDeploymentAttempt(pool, { attemptId: first.attempt.id, owner: "webhook-a", state: "failed" })).resolves.toBeNull();
    await expect(deployments.claimDeploymentAttempt(pool, { owner: "webhook-b", leaseMs: 60_000 })).resolves.toMatchObject({ kind: "recovered", attempt: { id: first.attempt.id, recovery_count: 1, owner: "webhook-b" } });

    await pool.query("UPDATE deployment_attempts SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [first.attempt.id]);
    await expect(deployments.claimDeploymentAttempt(pool, { owner: "webhook-c", leaseMs: 60_000 })).resolves.toMatchObject({ kind: "blocked", attempt: { id: first.attempt.id, state: "blocked" } });
    await expect(pool.query("SELECT state FROM deployment_attempts WHERE id=$1", [second.attempt.id])).resolves.toMatchObject({ rows: [{ state: "queued" }] });
    await expect(pool.query("UPDATE deployment_attempts SET recovery_count=2 WHERE id=$1", [first.attempt.id])).rejects.toThrow();
  });
});
