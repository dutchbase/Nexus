import { describe, expect, test, vi } from "vitest";

process.env.DCC_PROCESS_ROLE = "web";

vi.mock("@dcc/database", () => ({
  artifactDataRoot: () => "/primary",
  legacyArtifactDataRoot: () => "/legacy",
  finalizeArtifact: vi.fn(),
  inTransaction: vi.fn(),
  pool: { query: vi.fn() },
  readArtifact: vi.fn(),
  readStagedArtifact: vi.fn(),
  stageArtifact: vi.fn(),
}));

const { sanitizeFormSettings } = await import("./server.ts");

describe("sanitizeFormSettings", () => {
  test("unimplemented captcha modes cannot be persisted", () => {
    expect(sanitizeFormSettings({ captcha_mode: "honeypot_captcha" }).captcha_mode).toBe("honeypot");
  });
  test("whitelists keys and clamps rate limit", () => {
    const out = sanitizeFormSettings({ rate_limit: "999", evil: true, notify_on_submission: false, allow_image_attachments: false, completion_message: "ok" });
    expect(out).toEqual({ rate_limit: 20, captcha_mode: "honeypot", notify_on_submission: false, allow_image_attachments: false, completion_message: "ok" });
  });
  test("defaults are honest", () => {
    expect(sanitizeFormSettings(undefined)).toEqual({ rate_limit: 15, captcha_mode: "honeypot", notify_on_submission: true, allow_image_attachments: true, completion_message: "" });
  });
});
