import { describe, expect, it } from "vitest";
import { adminPage } from "./ui.ts";
import { securityHeaders } from "./security.ts";

describe("CSP and assets", () => {
  const page = adminPage("/admin", "Dashboard", "", {}, "admin");
  it("uses the local stylesheet and no external fonts", () => {
    expect(page).toContain('href="/assets/design-tokens.css"');
    expect(page).not.toContain("fonts.googleapis.com");
    expect(page).not.toContain("<style>");
  });
  it("CSP no longer allows inline styles", () => {
    expect(securityHeaders()["content-security-policy"]).not.toContain("style-src 'self' 'unsafe-inline'");
  });
});
