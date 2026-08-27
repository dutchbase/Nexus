import { describe, expect, it } from "vitest";
import { adminPage, loginPage, publicFormPage } from "./ui.ts";

const sampleForm = { title: "Website feedback", slug: "website-feedback", description: "Tell us what's broken.", settings_json: {} };

describe("Nexus branding", () => {
  it("sidebar shows Nexus, not the old product name or subtitle", () => {
    const page = adminPage("/admin", "Dashboard", "", {}, "admin");
    expect(page).toContain(">Nexus<");
    expect(page).not.toContain("Development hub");
    expect(page).not.toContain("Internet Nederland");
    expect(page).not.toContain("brand-sub");
  });

  it("breadcrumb fallback reads Nexus", () => {
    // Dashboard's own href is "/admin", and the matching logic treats any path
    // starting with "/admin/" as a match for it (path.startsWith(`${href}/`)),
    // so every real "/admin/..." path always resolves to a section label. The
    // fallback only renders for a path that doesn't fall under any nav href at
    // all — this is a direct unit call, not routed traffic, so that's fine here.
    const page = adminPage("/does-not-exist", "Unknown", "", {}, "admin");
    expect(page).toContain('<span class="eyebrow">Nexus</span>');
  });

  it("login page shows the Nexus wordmark and logo mark, not the old name", () => {
    const page = loginPage();
    expect(page).toContain(">Nexus<");
    expect(page).toContain('class="brand-mark"');
    expect(page).not.toContain("Development Control Center");
    expect(page).not.toContain("Development hub");
  });

  it("public form header carries the Nexus logo mark and name", () => {
    const page = publicFormPage(sampleForm, [], []);
    expect(page).toContain(">Nexus<");
    expect(page).toContain('class="brand-mark"');
    expect(page).not.toContain("Development hub");
    expect(page).not.toContain("Internet Nederland");
  });
});
