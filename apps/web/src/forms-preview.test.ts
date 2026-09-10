import { describe, expect, it } from "vitest";
import { previewField } from "./pages/forms.ts";
import { adminPage, formFieldPresets } from "./ui.ts";

describe("form preview attachments", () => {
  it("renders image_upload as disabled paste and picker controls", () => {
    const html = previewField({ field_type: "image_upload", label: "Screenshots", required: false });
    expect(html).toContain('type="file"');
    expect(html).toContain("disabled");
    expect(html).toContain("Paste");
    expect(html).toContain("PNG or JPG");
  });
  it("keeps generic fields as before", () => {
    expect(previewField({ field_type: "short_text", label: "Name", required: true })).toContain("placeholder=");
  });
  it("renders Jam links as URL inputs", () => {
    expect(previewField({ field_type: "jam_link", label: "Jam link", required: false })).toContain('type="url" placeholder="https://jam.dev/c/..."');
  });

  it("applies the reserved Jam defaults when its type is selected", () => {
    expect(formFieldPresets.jam_link).toEqual({
      field_key: "jam_url", label: "Jam link", description: "Paste a Jam link to include technical details.", placeholder: "https://jam.dev/c/...",
    });
    expect(adminPage("/admin/forms/example", "Example", '<div data-fields-app></div><script data-field-types type="application/json">[]</script><script data-fields-json type="application/json">[]</script>', {}, "admin"))
      .toContain("Object.assign(field,fieldPresets[field.field_type]||{})");
    expect({ required: true, ...formFieldPresets.jam_link }).toMatchObject({ field_key: "jam_url", required: true });
  });
});
