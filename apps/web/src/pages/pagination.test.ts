import { describe, expect, it } from "vitest";
import { pageRequest, keysetCondition, nextCursor, PAGE_SIZE_MAX, PAGE_SIZE_DEFAULT } from "./shared.ts";

describe("pagination", () => {
  it("clamps limit to the documented maximum", () => {
    expect(pageRequest(new URL("http://x/?limit=9999")).limit).toBe(PAGE_SIZE_MAX);
    expect(pageRequest(new URL("http://x/")).limit).toBe(PAGE_SIZE_DEFAULT);
  });
  it("ignores a malformed cursor", () => {
    expect(pageRequest(new URL("http://x/?cursor=garbage")).cursor).toBeNull();
  });
  it("builds a keyset predicate over (created_at,id)", () => {
    const values: any[] = ["seed"];
    const sql = keysetCondition({ at: "2026-01-01T00:00:00Z", id: "u1" }, "ae.created_at", "ae.id", values);
    expect(sql).toBe("(ae.created_at, ae.id) < ($2, $3)");
    expect(values).toHaveLength(3);
  });
  it("omits the next cursor on a short page", () => {
    expect(nextCursor([{ created_at: "t", id: "a" }], 50, "created_at")).toBeNull();
  });
});
