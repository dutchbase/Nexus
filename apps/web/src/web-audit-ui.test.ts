import { describe, expect, it } from "vitest";
import { adminPage, formControls } from "./ui.ts";

describe("admin shell", () => {
  it("offers sign out without claiming a worker is healthy", () => {
    const html = adminPage("/admin", "Dashboard", "", {}, "admin");
    expect(html).toContain('data-logout');
    expect(html).toContain('fetch("/api/admin/logout"');
    expect(html).not.toContain("worker-01 healthy");
  });
});

describe("public form help", () => {
  it("renders static instructions, descriptions, placeholders, and numeric limits", () => {
    const html = formControls([
      { field_key: "help", field_type: "static", label: "Before you start", description: "Do not include secrets." },
      { field_key: "count", field_type: "number", label: "Count", description: "Whole items", placeholder: "3", validation_json: { min: 1, max: 9 }, required: true },
    ], []);
    expect(html).toContain("Before you start");
    expect(html).toContain("Do not include secrets.");
    expect(html).toContain('aria-describedby="field-count-help"');
    expect(html).toContain('placeholder="3"');
    expect(html).toContain('min="1"');
    expect(html).toContain('max="9"');
  });
});
