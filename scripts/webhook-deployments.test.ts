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
