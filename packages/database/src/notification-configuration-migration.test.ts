import { readFile } from "node:fs/promises";
import pg from "pg";
import { expect, test } from "vitest";

const migrationTest = process.env.DATABASE_URL ? test : test.skip;

migrationTest("migration 020 removes unsafe legacy notification configuration idempotently", async () => {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query("CREATE TEMP TABLE notification_providers (name text NOT NULL, configuration_encrypted_json jsonb NOT NULL)");
    await client.query(
      "INSERT INTO notification_providers (name,configuration_encrypted_json) VALUES ($1,$2),($3,$4)",
      [
        "legacy-base", {
          base_url: "https://user:literal-secret@example.test", endpoint: "https://notify.example/hook", timeout_seconds: 4,
          authorization: "Bearer literal-secret", authentication: { type: "bearer", secret_reference: "NOTIFICATION_TOKEN" },
        },
        "legacy-endpoint", {
          base_url: "https://notify.example", endpoint: "https://user:literal-secret@example.test/hook",
          authentication: { type: "raw", secret_reference: "DCC_NOTIFICATION_SECRET_VALID" },
        },
      ],
    );
    const migration = await readFile(new URL("../migrations/020_notification_configuration_secrecy.sql", import.meta.url), "utf8");
    await client.query(migration);
    const once = (await client.query("SELECT name,configuration_encrypted_json FROM notification_providers ORDER BY name")).rows;
    expect(once).toEqual([
      { name: "legacy-base", configuration_encrypted_json: { endpoint: "https://notify.example/hook", timeout_seconds: 4 } },
      { name: "legacy-endpoint", configuration_encrypted_json: {
        base_url: "https://notify.example", authentication: { type: "raw", secret_reference: "DCC_NOTIFICATION_SECRET_VALID" },
      } },
    ]);
    await client.query(migration);
    expect((await client.query("SELECT name,configuration_encrypted_json FROM notification_providers ORDER BY name")).rows).toEqual(once);
  } finally {
    await client.end();
  }
});
