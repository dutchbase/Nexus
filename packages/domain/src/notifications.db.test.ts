import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pg from "pg";

process.env.DATABASE_URL ??= "postgres://unused:unused@127.0.0.1:1/unused";
const { migrate } = await import("../../database/src/migrate.ts");
const { enqueueNotification } = await import("./notifications.ts");

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
});
