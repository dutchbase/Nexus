import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { clientIpOf, csrfMatches, securityHeaders, validateWebRuntime } from "./security.ts";

describe("web security", () => {
  test("production requires the web role and a HTTPS public URL", () => {
    expect(() => validateWebRuntime({ NODE_ENV: "production", DCC_PROCESS_ROLE: "worker", APP_BASE_URL: "https://dcc.test" })).toThrow("DCC_PROCESS_ROLE=web");
    expect(() => validateWebRuntime({ NODE_ENV: "production", DCC_PROCESS_ROLE: "web", APP_BASE_URL: "http://dcc.test" })).toThrow("HTTPS APP_BASE_URL");
    expect(validateWebRuntime({ NODE_ENV: "production", DCC_PROCESS_ROLE: "web", APP_BASE_URL: "https://dcc.test" }).production).toBe(true);
  });

  test("production web refuses worker credentials while development is explicit", () => {
    expect(() => validateWebRuntime({ NODE_ENV: "production", DCC_PROCESS_ROLE: "web", APP_BASE_URL: "https://dcc.test", GITHUB_TOKEN: "secret" })).toThrow("GITHUB_TOKEN");
    expect(validateWebRuntime({ NODE_ENV: "development" })).toMatchObject({ production: false, trustedProxyHops: 0 });
  });

  test("uses the documented browser hardening header baseline", () => {
    expect(securityHeaders()).toMatchObject({
      "content-security-policy": expect.stringContaining("frame-ancestors 'none'"),
      "x-frame-options": "DENY", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
      "permissions-policy": expect.stringContaining("camera=()"),
    });
  });

  test("compares valid CSRF hashes in constant time and rejects malformed values", () => {
    const token = "correct-token";
    const hash = createHash("sha256").update(token).digest("hex");
    expect(csrfMatches(token, hash)).toBe(true);
    expect(csrfMatches("wrong-token", hash)).toBe(false);
    expect(csrfMatches(token, "bad")).toBe(false);
    expect(csrfMatches(token, hash.slice(2))).toBe(false);
  });

  test("uses forwarded identity only for configured trusted proxy hops", () => {
    const direct = { socket: { remoteAddress: "203.0.113.10" }, headers: { "x-forwarded-for": "198.51.100.9" } } as any;
    expect(clientIpOf(direct, 0)).toBe("203.0.113.10");
    expect(clientIpOf(direct, 1)).toBe("198.51.100.9");
    const chained = { socket: { remoteAddress: "203.0.113.11" }, headers: { "x-forwarded-for": "198.51.100.9, 203.0.113.10" } } as any;
    expect(clientIpOf(chained, 2)).toBe("198.51.100.9");
  });

  test("rejects invalid trusted proxy settings", () => {
    expect(() => validateWebRuntime({ DCC_TRUST_PROXY_HOPS: "11" })).toThrow("DCC_TRUST_PROXY_HOPS");
  });
});
