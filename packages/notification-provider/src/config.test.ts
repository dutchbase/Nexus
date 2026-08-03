import { afterEach, describe, expect, test, vi } from "vitest";
import { createNotificationProvider, parseNotificationConfiguration } from "./index.ts";

describe("notification configuration", () => {
  test("accepts an allowlisted endpoint configuration", () => {
    expect(parseNotificationConfiguration({
      endpoint: "/hooks/notify", base_url: "https://notify.example", method: "PUT", timeout_seconds: 4,
      authentication: { type: "bearer", secret_reference: "NOTIFICATION_TOKEN" },
    })).toEqual({
      endpoint: "/hooks/notify", base_url: "https://notify.example", method: "PUT", timeout_seconds: 4,
      authentication: { type: "bearer", secret_reference: "NOTIFICATION_TOKEN" },
    });
  });

  test("rejects literal and arbitrary credential fields", () => {
    for (const configuration of [
      { endpoint: "https://notify.example", authorization_header: "Bearer secret-canary" },
      { endpoint: "https://notify.example", api_key_reference: "NOTIFICATION_TOKEN" },
      { endpoint: "https://notify.example", headers: { authorization: "Bearer secret-canary" } },
    ]) expect(parseNotificationConfiguration(configuration)).toBeNull();
  });

  test("does not return caught provider secrets", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("secret-canary")));
    const result = await createNotificationProvider("webhook", {
      endpoint: "https://notify.example", authentication: { type: "bearer", secret_reference: "NOTIFICATION_TOKEN" },
    }).send({ event: "test" });
    expect(result.errorMessage).toBe("Notification request failed");
    expect(result.errorMessage).not.toContain("secret-canary");
  });

  afterEach(() => vi.unstubAllGlobals());
});
