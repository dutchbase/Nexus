import { expect, test, vi, beforeEach } from "vitest";
import { checkProductionHealth, evaluatePromotionEligibility } from "./deployment.ts";

beforeEach(() => { vi.restoreAllMocks(); });

test("checkProductionHealth reports state:healthy when the health endpoint is 200 and version matches", async () => {
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response("ok", { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ commit: "a".repeat(40) }), { status: 200 }));
  const result = await checkProductionHealth({ host: "https://x.com", health_path: "/health", version_path: "/version" });
  expect(result).toEqual({ state: "healthy", healthy: true, commit_sha: "a".repeat(40), raw: { commit: "a".repeat(40) } });
});

test("checkProductionHealth reports state:unhealthy on a non-2xx health response", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("error", { status: 500 }));
  const result = await checkProductionHealth({ host: "https://x.com", health_path: "/health", version_path: "/version" });
  expect(result.state).toBe("unhealthy");
  expect(result.healthy).toBe(false);
});

test("checkProductionHealth reports state:unreachable when the fetch itself throws (timeout/DNS/etc)", async () => {
  vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("fetch failed"));
  const result = await checkProductionHealth({ host: "https://x.com", health_path: "/health", version_path: "/version" });
  expect(result.state).toBe("unreachable");
});

test("checkProductionHealth reads a custom version_field dot-path", async () => {
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response("ok", { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ build: { sha: "b".repeat(40) } }), { status: 200 }));
  const result = await checkProductionHealth({ host: "https://x.com", health_path: "/health", version_path: "/version", version_field: "build.sha" });
  expect(result.commit_sha).toBe("b".repeat(40));
});

test("evaluatePromotionEligibility is eligible when CI is green, image exists, and e2e gate is satisfied", () => {
  const result = evaluatePromotionEligibility({ ciState: "success", imageExists: true, e2eGateRequired: true, e2eGateSatisfied: true });
  expect(result).toEqual({ eligible: true, reasons: [] });
});

test("evaluatePromotionEligibility lists every failing reason at once, not just the first", () => {
  const result = evaluatePromotionEligibility({ ciState: "failure", imageExists: false, e2eGateRequired: true, e2eGateSatisfied: false });
  expect(result.eligible).toBe(false);
  expect(result.reasons).toEqual(["ci_not_green", "image_not_built", "missing_e2e_label"]);
});

test("evaluatePromotionEligibility ignores the e2e gate entirely when it isn't required", () => {
  const result = evaluatePromotionEligibility({ ciState: "success", imageExists: true, e2eGateRequired: false, e2eGateSatisfied: false });
  expect(result).toEqual({ eligible: true, reasons: [] });
});
