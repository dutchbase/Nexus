import { describe, expect, it } from "vitest";
import { previewField } from "./pages/forms.ts";

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
});
