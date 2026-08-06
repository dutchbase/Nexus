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
  it("CSP allows inline style attributes but forbids injected style blocks", () => {
    const csp = securityHeaders()["content-security-policy"];
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("style-src-elem 'self'");
  });
});
