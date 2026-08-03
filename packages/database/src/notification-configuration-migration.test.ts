import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { safeNotificationConfiguration } from "../../notification-provider/src/index.ts";

test("notification configuration migration keeps only allowlisted safe fields", async () => {
  const migration = await readFile(new URL("../migrations/020_notification_configuration_secrecy.sql", import.meta.url), "utf8");
  expect(migration).toContain("jsonb_strip_nulls");
  expect(migration).toContain("'base_url'");
  expect(migration).toContain("'endpoint'");
  expect(migration).toContain("'method'");
  expect(migration).toContain("'timeout_seconds'");
  expect(migration).toContain("'authentication'");
  expect(migration).toContain("^DCC_NOTIFICATION_SECRET_");
  expect(migration).toContain("[^/?#]*@");
  expect(migration).not.toContain("authorization_header");
});

test("normalizes representative legacy notification configurations", () => {
  const legacy = {
    base_url: "https://user:literal-secret@example.test",
    endpoint: "https://notify.example/hook",
    timeout_seconds: 4,
    authorization: "Bearer literal-secret",
    authentication: { type: "bearer", secret_reference: "NOTIFICATION_TOKEN" },
  };
  const normalized = safeNotificationConfiguration(legacy);
  expect(normalized).toEqual({ endpoint: "https://notify.example/hook", timeout_seconds: 4 });
  expect(safeNotificationConfiguration(normalized)).toEqual(normalized);
  expect(safeNotificationConfiguration({
    base_url: "https://notify.example", endpoint: "https://user:literal-secret@example.test/hook",
    authentication: { type: "raw", secret_reference: "DCC_NOTIFICATION_SECRET_VALID" },
  })).toEqual({
    base_url: "https://notify.example",
    authentication: { type: "raw", secret_reference: "DCC_NOTIFICATION_SECRET_VALID" },
  });
});
