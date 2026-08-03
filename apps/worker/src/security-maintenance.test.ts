import { expect, test } from "vitest";
import { cleanupExpiredSessions } from "./security-maintenance.ts";

test("removes expired sessions and records their count without an actor", async () => {
  const queries: Array<{ text: string; values: unknown[] | undefined }> = [];
  const result = await cleanupExpiredSessions({
    async query(text: string, values?: unknown[]) {
      queries.push({ text, values });
      return { rows: [{ deleted_count: 2 }] };
    },
  });

  expect(result).toEqual({ deletedCount: 2 });
  expect(queries).toHaveLength(1);
  expect(queries[0]).toMatchObject({ values: undefined });
  expect(queries[0]?.text).toContain("DELETE FROM admin_sessions WHERE expires_at <= now()");
  expect(queries[0]?.text).toContain("INSERT INTO audit_events (actor_type, action, entity_type, metadata_json)");
  expect(queries[0]?.text).toContain("'system'");
  expect(queries[0]?.text).toContain("'admin_sessions.cleanup'");
  expect(queries[0]?.text).toContain("'deleted_count'");
});
