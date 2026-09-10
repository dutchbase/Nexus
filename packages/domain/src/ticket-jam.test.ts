import { describe, expect, it } from "vitest";
import { normalizeJamUrl } from "./ticket-jam.ts";

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
