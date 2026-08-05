import { describe, expect, it } from "vitest";
import { prFreshness, PR_STALE_AFTER_MS } from "./shared.ts";

describe("prFreshness", () => {
  it("flags pull requests whose last_synced_at exceeds the threshold", () => {
    expect(prFreshness(new Date(Date.now() - PR_STALE_AFTER_MS - 60_000).toISOString()).stale).toBe(true);
  });
  it("does not flag freshly synced pull requests", () => {
    expect(prFreshness(new Date().toISOString()).stale).toBe(false);
  });
});
