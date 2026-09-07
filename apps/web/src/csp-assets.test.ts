import { describe, expect, it } from "vitest";
import { adminPage } from "./ui.ts";
import { securityHeaders } from "./security.ts";

describe("CSP and assets", () => {
  const nonce = "trusted-nonce";
  const page = adminPage("/admin", "Dashboard", "", {}, "admin", nonce);
  it("uses the local stylesheet and no external fonts", () => {
    expect(page).toContain('href="/assets/design-tokens.css"');
    expect(page).not.toContain("fonts.googleapis.com");
    expect(page).not.toContain("<style>");
  });
  it("CSP allows inline style attributes but forbids injected style blocks", () => {
    const csp = securityHeaders(false, nonce)["content-security-policy"];
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("style-src-elem 'self'");
  });
  it("adds the response nonce only to the trusted renderer script", () => {
    const injected = adminPage("/admin", "Dashboard", "<script>alert('bad')</script>", {}, "admin", nonce);
    expect(injected).toContain(`<script>alert('bad')</script>`);
    expect(injected).not.toContain(`<script nonce="${nonce}">alert('bad')</script>`);
    expect(injected).toContain(`<script nonce="${nonce}">`);
  });
});
