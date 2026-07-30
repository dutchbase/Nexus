import { describe, expect, it } from "vitest";
import { countCredentialShapes, executionBranchName, matchesProtectedPath, sanitizeValidationOutput } from "./index.ts";

describe("worker validation primitives", () => {
  it("detects credential shapes without returning their values", () => {
    expect(countCredentialShapes("x=AKIAIOSFODNN7EXAMPLE\n-----BEGIN PRIVATE KEY-----")).toBe(2);
    expect(countCredentialShapes("ordinary content")).toBe(0);
    expect(sanitizeValidationOutput("failed for AKIAIOSFODNN7EXAMPLE")).toBe("failed for [REDACTED_CREDENTIAL]");
  });

  it("matches protected paths as globs", () => {
    expect(matchesProtectedPath(".env")).toBe(true);
    expect(matchesProtectedPath(".env.local")).toBe(true);
    expect(matchesProtectedPath("secrets/nested/key.txt")).toBe(true);
    expect(matchesProtectedPath("src/environment.ts")).toBe(false);
  });

  it("generates distinct branch names for different attempts on the same ticket", () => {
    const first = executionBranchName("DCC-1001", "Update the logo to my png image", 1);
    const second = executionBranchName("DCC-1001", "Update the logo to my png image", 2);
    expect(first).not.toBe(second);
    expect(second).toContain("-2-");
  });
});
