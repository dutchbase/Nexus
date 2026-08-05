import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pg from "pg";

process.env.DATABASE_URL = process.env.DCC_TEST_DATABASE_URL ?? "postgres://unused:unused@127.0.0.1:1/unused";
const { migrate } = await import("../../database/src/migrate.ts");
const { enqueueNotification, claimNotificationDelivery, failNotificationDelivery, retryNotificationDelivery } = await import("./notifications.ts");

const testDatabaseUrl = process.env.DCC_TEST_DATABASE_URL;
const integration = testDatabaseUrl ? describe : describe.skip;
let migrationDirectory = "";

async function resetDatabase() {
  const client = new pg.Client({ connectionString: testDatabaseUrl });
  await client.connect();
  try {
    await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  } finally {
    await client.end();
  }
}

integration("enqueueNotification rule filtering", () => {
  beforeAll(async () => {
    migrationDirectory = await mkdtemp(join(tmpdir(), "dcc-notifications-"));
    await cp(new URL("../../database/migrations/", import.meta.url), migrationDirectory, { recursive: true });
  });

  beforeEach(async () => {
    await resetDatabase();
    await migrate({ connectionString: testDatabaseUrl!, directory: migrationDirectory });
  });

  afterAll(async () => {
    if (migrationDirectory) await rm(migrationDirectory, { recursive: true, force: true });
  });

  async function seedTicket(client: pg.Client) {
    const projectId = (await client.query(
      "INSERT INTO projects (slug,name,repository_path) VALUES ($1,$2,$3) RETURNING id",
      ["notif-project", "Project", "/tmp/project"],
    )).rows[0].id;
    const ticketId = (await client.query(
      "INSERT INTO tickets (ticket_number,project_id,title,status) VALUES ($1,$2,$3,$4) RETURNING id",
      ["N-1", projectId, "Notification ticket", "Submitted"],
    )).rows[0].id;
    return { projectId, ticketId };
  }

  it("enqueues only to providers with the event enabled", async () => {
    const client = new pg.Client({ connectionString: testDatabaseUrl });
    await client.connect();
    try {
      const { ticketId } = await seedTicket(client);
      const disallowingProviderId = (await client.query(
        "INSERT INTO notification_providers (name,type,enabled,enabled_events) VALUES ($1,$2,true,$3) RETURNING id",
        ["silent-provider", "webhook", JSON.stringify([])],
      )).rows[0].id;
      const allowingProviderId = (await client.query(
        "INSERT INTO notification_providers (name,type,enabled,enabled_events) VALUES ($1,$2,true,$3) RETURNING id",
        ["allowing-provider", "webhook", JSON.stringify(["ticket.created"])],
      )).rows[0].id;

      await enqueueNotification(client, "ticket.created", ticketId, "entity-1");

      const deliveries = (await client.query(
        "SELECT provider_id FROM notification_deliveries WHERE ticket_id=$1",
        [ticketId],
      )).rows;
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0].provider_id).toBe(allowingProviderId);
      expect(deliveries.map((d: { provider_id: string }) => d.provider_id)).not.toContain(disallowingProviderId);
    } finally {
      await client.end();
    }
  });

  it("rejects events outside the registry", async () => {
    const client = new pg.Client({ connectionString: testDatabaseUrl });
    await client.connect();
    try {
      const { ticketId } = await seedTicket(client);
      await expect(
        enqueueNotification(client, "nope.event" as any, ticketId, "entity-2"),
      ).rejects.toThrow(/Unknown notification event/);
    } finally {
      await client.end();
    }
  });

  it("reclaims an expired sending delivery once and records recovery_reason", async () => {
    const client = new pg.Client({ connectionString: testDatabaseUrl });
    await client.connect();
    try {
      const { ticketId, projectId } = await seedTicket(client);
      const providerId = (await client.query(
        "INSERT INTO notification_providers (name,type,enabled,enabled_events) VALUES ($1,$2,true,$3) RETURNING id",
        ["reclaim-provider", "webhook", JSON.stringify(["ticket.created"])],
      )).rows[0].id;
      const expiredId = (await client.query(
        `INSERT INTO notification_deliveries
           (provider_id,event_type,ticket_id,project_id,idempotency_key,payload_json,status,attempt_count,claimed_by,lease_expires_at,next_attempt_at)
         VALUES ($1,$2,$3,$4,$5,$6,'sending',1,'stale-worker',now() - interval '1 second',now() - interval '1 second')
         RETURNING id`,
        [providerId, "ticket.created", ticketId, projectId, "expired-key", JSON.stringify({})],
      )).rows[0].id;
      const liveLeasedId = (await client.query(
        `INSERT INTO notification_deliveries
           (provider_id,event_type,ticket_id,project_id,idempotency_key,payload_json,status,attempt_count,claimed_by,lease_expires_at,next_attempt_at)
         VALUES ($1,$2,$3,$4,$5,$6,'sending',1,'active-worker',now() + interval '1 minute',now() - interval '1 second')
         RETURNING id`,
        [providerId, "ticket.created", ticketId, projectId, "live-key", JSON.stringify({})],
      )).rows[0].id;

      const claimed = await claimNotificationDelivery("recovery-worker");
      expect(claimed?.id).toBe(expiredId);
      expect(claimed?.recovery_reason).toBe("lease_expired");
      expect(claimed?.status).toBe("sending");
      expect(claimed?.claimed_by).toBe("recovery-worker");

      const nextClaim = await claimNotificationDelivery("another-worker");
      expect(nextClaim).toBeNull();

      const liveRow = (await client.query(
        "SELECT claimed_by FROM notification_deliveries WHERE id=$1",
        [liveLeasedId],
      )).rows[0];
      expect(liveRow.claimed_by).toBe("active-worker");
    } finally {
      await client.end();
    }
  });

  it("moves a delivery to terminal exhausted at max_attempts", async () => {
    const client = new pg.Client({ connectionString: testDatabaseUrl });
    await client.connect();
    try {
      const { ticketId, projectId } = await seedTicket(client);
      const providerId = (await client.query(
        "INSERT INTO notification_providers (name,type,enabled,enabled_events,max_attempts) VALUES ($1,$2,true,$3,$4) RETURNING id",
        ["exhaust-provider", "webhook", JSON.stringify(["ticket.created"]), 2],
      )).rows[0].id;
      const deliveryId = (await client.query(
        `INSERT INTO notification_deliveries
           (provider_id,event_type,ticket_id,project_id,idempotency_key,payload_json,status,attempt_count,claimed_by,lease_expires_at,next_attempt_at)
         VALUES ($1,$2,$3,$4,$5,$6,'sending',1,'exhaust-worker',now() + interval '1 minute',now())
         RETURNING id`,
        [providerId, "ticket.created", ticketId, projectId, "exhaust-key", JSON.stringify({})],
      )).rows[0].id;

      const updated = await failNotificationDelivery(deliveryId, "exhaust-worker", new Error("boom"), undefined, 2);
      expect(updated).toBe(true);

      const row = (await client.query(
        "SELECT status,attempt_count FROM notification_deliveries WHERE id=$1",
        [deliveryId],
      )).rows[0];
      expect(row.status).toBe("exhausted");
      expect(row.attempt_count).toBe(2);

      const claimed = await claimNotificationDelivery("another-worker");
      expect(claimed).toBeNull();
    } finally {
      await client.end();
    }
  });

  it("manual retry re-queues only failed/exhausted deliveries", async () => {
    const client = new pg.Client({ connectionString: testDatabaseUrl });
    await client.connect();
    try {
      const { ticketId, projectId } = await seedTicket(client);
      const providerId = (await client.query(
        "INSERT INTO notification_providers (name,type,enabled,enabled_events) VALUES ($1,$2,true,$3) RETURNING id",
        ["retry-provider", "webhook", JSON.stringify(["ticket.created"])],
      )).rows[0].id;

      const failedId = (await client.query(
        `INSERT INTO notification_deliveries
           (provider_id,event_type,ticket_id,project_id,idempotency_key,payload_json,status,attempt_count,next_attempt_at)
         VALUES ($1,$2,$3,$4,$5,$6,'failed',3,now() + interval '1 hour')
         RETURNING id`,
        [providerId, "ticket.created", ticketId, projectId, "failed-key", JSON.stringify({})],
      )).rows[0].id;

      const retried = await retryNotificationDelivery(failedId);
      expect(retried?.status).toBe("queued");
      expect(retried?.attempt_count).toBe(0);
      expect(retried?.recovery_reason).toBe("manual_retry");

      const sendingId = (await client.query(
        `INSERT INTO notification_deliveries
           (provider_id,event_type,ticket_id,project_id,idempotency_key,payload_json,status,attempt_count,claimed_by,lease_expires_at,next_attempt_at)
         VALUES ($1,$2,$3,$4,$5,$6,'sending',1,'active-worker',now() + interval '1 minute',now())
         RETURNING id`,
        [providerId, "ticket.created", ticketId, projectId, "sending-key", JSON.stringify({})],
      )).rows[0].id;

      const sendingRetry = await retryNotificationDelivery(sendingId);
      expect(sendingRetry).toBeNull();
      const sendingRow = (await client.query(
        "SELECT status,claimed_by,lease_expires_at FROM notification_deliveries WHERE id=$1",
        [sendingId],
      )).rows[0];
      expect(sendingRow.status).toBe("sending");
      expect(sendingRow.claimed_by).toBe("active-worker");
      expect(sendingRow.lease_expires_at).not.toBeNull();

      const secondRetry = await retryNotificationDelivery(failedId);
      expect(secondRetry).toBeNull();
    } finally {
      await client.end();
    }
  });
});
