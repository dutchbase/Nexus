import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";

test("notification configuration migration keeps only allowlisted safe fields", async () => {
  const migration = await readFile(new URL("../migrations/020_notification_configuration_secrecy.sql", import.meta.url), "utf8");
  expect(migration).toContain("jsonb_strip_nulls");
  expect(migration).toContain("'base_url'");
  expect(migration).toContain("'endpoint'");
  expect(migration).toContain("'method'");
  expect(migration).toContain("'timeout_seconds'");
  expect(migration).toContain("'authentication'");
  expect(migration).toContain("^DCC_NOTIFICATION_SECRET_");
  expect(migration).not.toContain("authorization_header");
});
