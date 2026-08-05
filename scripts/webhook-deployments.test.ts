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
  it("rejects unsafe check evidence before touching PostgreSQL", async () => {
    const db = fakePool(() => ({ rows: [] }));

    await expect(deployments.enqueueDeploymentAttempt(db.pool, {
      ...attempt("a"),
      checkEvidence: { conclusion: "success", payload: "webhook-secret" },
      state: "rejected",
    })).rejects.toThrow("unsafe event metadata key payload");
    expect(db.queries).toEqual([]);
  });

  it("records a launch intent before a child PID exists", async () => {
    const db = fakePool((text) => text.startsWith("UPDATE deployment_attempts SET marker_path")
      ? { rows: [{ id: "attempt", marker_path: "/safe/attempt.done", child_pid: null }] }
      : { rows: [] });

    await expect(deployments.recordDeploymentLaunchIntent(db.pool, { attemptId: "attempt", owner: "webhook", markerPath: "/safe/attempt.done" }))
      .resolves.toMatchObject({ id: "attempt", child_pid: null });
  });

  it("persists a spawned child PID with its marker under the owner lease", async () => {
    const db = fakePool((text) => text.startsWith("UPDATE deployment_attempts SET child_pid")
      ? { rows: [{ id: "attempt", child_pid: 42 }] }
      : { rows: [] });

    await expect(deployments.recordDeploymentLaunch(db.pool, { attemptId: "attempt", owner: "webhook", markerPath: "/safe/attempt.done", childPid: 42 }))
      .resolves.toMatchObject({ id: "attempt", child_pid: 42 });
  });

  it("keeps the durable rollback target and notification evidence at terminal completion", async () => {
    const db = fakePool((text, values) => text.includes("SET state=$3")
      ? { rows: [{ id: "attempt", prior_release_path: "/releases/previous", notification_status: values[5], notification_error_code: values[6] }] }
      : { rows: [] });

    await expect(deployments.completeDeploymentAttempt(db.pool, {
      attemptId: "attempt",
      owner: "webhook",
      state: "failed",
      notificationStatus: "failed_http",
      notificationErrorCode: "http_503",
      recoveryReason: "deploy_failed",
    })).resolves.toMatchObject({
      prior_release_path: "/releases/previous",
      notification_status: "failed_http",
      notification_error_code: "http_503",
    });

    const terminal = db.queries.find(({ text }) => text.includes("SET state=$3"));
    expect(terminal?.text).toContain("prior_release_path=COALESCE($5,prior_release_path)");
    const completedEvent = db.queries.find(({ text, values }) => text.startsWith("INSERT INTO deployment_events") && values[2] === "failed");
    expect(JSON.parse(completedEvent?.values[3] as string)).toEqual({
      state: "failed",
      notification_status: "failed_http",
      notification_error_code: "http_503",
      recovery_reason: "deploy_failed",
    });
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

  it("keeps a stale-head rejection distinct from prior deployment history for the same SHA", async () => {
    const first = await deployments.enqueueDeploymentAttempt(pool, attempt("a"));
    const rejected = await deployments.enqueueDeploymentAttempt(pool, {
      ...attempt("a"),
      deliveryId: "delivery-stale-a",
      state: "rejected",
      checkEvidence: { requiredCheck: "ci", conclusion: "success", rejectionReason: "protected_head_mismatch" },
    });

    expect(first).toMatchObject({ created: true });
    expect(rejected).toMatchObject({ created: true, attempt: { state: "rejected" } });
    await expect(pool.query("SELECT state FROM deployment_attempts WHERE target_sha=$1 ORDER BY created_at", [sha("a")]))
      .resolves.toMatchObject({ rows: [{ state: "queued" }, { state: "rejected" }] });
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
