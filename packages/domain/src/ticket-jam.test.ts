import { describe, expect, it } from "vitest";
import { normalizeJamUrl, queueJamRetry } from "./ticket-jam.ts";

describe("normalizeJamUrl", () => {
  it("canonicalizes Jam capture links", () => {
    expect(normalizeJamUrl(" https://jam.dev/c/abc123?utm_source=copy#details ")).toEqual({ id: "abc123", url: "https://jam.dev/c/abc123" });
    expect(normalizeJamUrl("")).toBeNull();
  });

  it("rejects non-canonical and unsafe sources", () => {
    for (const input of ["http://jam.dev/c/abc", "https://jam.dev.evil.test/c/abc", "https://user:pass@jam.dev/c/abc",
      "https://127.0.0.1/c/abc", "https://jam.dev:444/c/abc", "https://jam.dev/c/a/b", "https://jam.dev/c/%2e%2e",
      "javascript:alert(1)", 3, "x".repeat(2049)]) expect(() => normalizeJamUrl(input)).toThrow();
  });
});

describe("queueJamRetry", () => {
  const client = (context: Record<string, unknown>) => {
    const queries: string[] = [];
    return {
      queries,
      query: async (sql: string) => {
        queries.push(sql);
        if (sql.includes("FROM tickets t JOIN ticket_jam_contexts")) return { rows: [context] };
        return { rows: [{}], rowCount: 1 };
      },
    };
  };

  it.each(["failed", "not_configured"])("requeues %s imports without clearing saved evidence", async (state) => {
    const db = client({ jam_url: "https://jam.dev/c/a", source_url: "https://jam.dev/c/a", state, submitter_deleted_at: null });
    await queueJamRetry(db, "ticket-1");
    expect(db.queries[0]).toContain("FOR UPDATE OF t,c");
    expect(db.queries[1]).not.toMatch(/data_json|content_hash|fetched_at/);
    expect(db.queries.some((sql) => sql.includes("INSERT INTO jobs"))).toBe(true);
  });

  it.each([
    { state: "queued" }, { state: "fetching" }, { state: "ready" }, { state: "partial" },
    { state: "failed", submitter_deleted_at: new Date() },
    { state: "failed", jam_url: null },
    { state: "failed", jam_url: "https://jam.dev/c/new" },
  ])("rejects an ineligible current context: %j", async (override) => {
    const db = client(Object.assign({ jam_url: "https://jam.dev/c/a", source_url: "https://jam.dev/c/a", state: "failed", submitter_deleted_at: null }, override));
    await expect(queueJamRetry(db, "ticket-1")).rejects.toMatchObject({ status: 409 });
    expect(db.queries).toHaveLength(1);
  });
});
