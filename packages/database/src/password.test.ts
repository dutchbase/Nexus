import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password.ts";

describe("password input contract", () => {
  it("rejects line breaks before invoking Argon2", async () => {
    await expect(hashPassword("safe\npassword")).rejects.toThrow("Password must be 1-4096 UTF-8 bytes without NUL, CR, or LF");
  });

  it("hashes and verifies a correct password", async () => {
    const encoded = await hashPassword("correct horse battery");
    expect(await verifyPassword(encoded, "correct horse battery")).toBe(true);
    expect(await verifyPassword(encoded, "wrong")).toBe(false);
  });

  it("throws an actionable error when the helper binary is missing", async () => {
    process.env.DCC_ARGON2_HELPER_PATH = "/nonexistent/argon2-helper";
    try {
      await expect(hashPassword("anything")).rejects.toThrow(/Argon2 helper binary not found/);
    } finally {
      delete process.env.DCC_ARGON2_HELPER_PATH;
    }
  });
});
