import { describe, expect, it } from "vitest";
import { hashPassword } from "./password.ts";

describe("password input contract", () => {
  it("rejects line breaks before invoking Argon2", async () => {
    await expect(hashPassword("safe\npassword")).rejects.toThrow("Password must be 1-4096 UTF-8 bytes without NUL, CR, or LF");
  });
});
