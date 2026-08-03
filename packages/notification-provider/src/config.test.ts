import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createNotificationProvider, mergeNotificationConfiguration, parseNotificationConfiguration,
  parseNotificationConfigurationPatch, safeNotificationConfiguration, safeNotificationProvider,
} from "./index.ts";

describe("notification configuration", () => {
  test("accepts an allowlisted endpoint configuration", () => {
    expect(parseNotificationConfiguration({
      endpoint: "/hooks/notify", base_url: "https://notify.example", method: "PUT", timeout_seconds: 4,
      authentication: { type: "bearer", secret_reference: "DCC_NOTIFICATION_SECRET_TOKEN" },
    })).toEqual({
      endpoint: "/hooks/notify", base_url: "https://notify.example", method: "PUT", timeout_seconds: 4,
      authentication: { type: "bearer", secret_reference: "DCC_NOTIFICATION_SECRET_TOKEN" },
    });
  });

  test("rejects literal and arbitrary credential fields", () => {
    for (const configuration of [
      { endpoint: "https://notify.example", authorization_header: "Bearer secret-canary" },
      { endpoint: "https://notify.example", api_key_reference: "NOTIFICATION_TOKEN" },
      { endpoint: "https://notify.example", headers: { authorization: "Bearer secret-canary" } },
    ]) expect(parseNotificationConfiguration(configuration)).toBeNull();
  });

  test("requires the dedicated notification secret namespace", () => {
    expect(parseNotificationConfiguration({
      endpoint: "https://notify.example", authentication: { type: "bearer", secret_reference: "NOTIFICATION_TOKEN" },
    })).toBeNull();
  });

  test("projects legacy configuration without its inline secret", () => {
    expect(safeNotificationConfiguration({
      endpoint: "https://notify.example", method: "PUT", timeout_seconds: 4,
      authorization: "Bearer secret-canary",
      authentication: { type: "bearer", secret_reference: "DCC_NOTIFICATION_SECRET_TOKEN", token: "secret-canary" },
    })).toEqual({ endpoint: "https://notify.example", method: "PUT", timeout_seconds: 4 });
  });

  test("projects provider rows without their raw configuration", () => {
    expect(safeNotificationProvider({
      id: "provider-1", name: "Webhook", type: "webhook", enabled: true,
      configuration_encrypted_json: { endpoint: "https://notify.example", authorization: "Bearer secret-canary" },
      internal_only: "secret-canary",
    })).toEqual({
      id: "provider-1", name: "Webhook", type: "webhook", enabled: true,
      configuration_encrypted_json: { endpoint: "https://notify.example" },
    });
  });

  test("rotates only the supplied authentication", () => {
    const patch = parseNotificationConfigurationPatch({
      authentication: { type: "raw", secret_reference: "DCC_NOTIFICATION_SECRET_ROTATED" },
    });
    expect(patch).toEqual({ authentication: { type: "raw", secret_reference: "DCC_NOTIFICATION_SECRET_ROTATED" } });
    expect(mergeNotificationConfiguration({
      base_url: "https://notify.example", endpoint: "/hooks/notify", method: "PUT", timeout_seconds: 4,
      authentication: { type: "bearer", secret_reference: "DCC_NOTIFICATION_SECRET_OLD" },
    }, patch!)).toEqual({
      base_url: "https://notify.example", endpoint: "/hooks/notify", method: "PUT", timeout_seconds: 4,
      authentication: { type: "raw", secret_reference: "DCC_NOTIFICATION_SECRET_ROTATED" },
    });
  });

  test("fails closed when a dedicated secret is absent", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const result = await createNotificationProvider("webhook", {
      endpoint: "https://notify.example", authentication: { type: "bearer", secret_reference: "DCC_NOTIFICATION_SECRET_ABSENT" },
    }).send({ event: "test" });
    expect(result).toEqual({ ok: false, responseStatus: null, errorMessage: "Notification secret is unavailable" });
    expect(fetch).not.toHaveBeenCalled();
  });

  test("does not return caught provider secrets", async () => {
    vi.stubEnv("DCC_NOTIFICATION_SECRET_TOKEN", "test-token");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("secret-canary")));
    const result = await createNotificationProvider("webhook", {
      endpoint: "https://notify.example", authentication: { type: "bearer", secret_reference: "DCC_NOTIFICATION_SECRET_TOKEN" },
    }).send({ event: "test" });
    expect(result.errorMessage).toBe("Notification request failed");
    expect(result.errorMessage).not.toContain("secret-canary");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
});
