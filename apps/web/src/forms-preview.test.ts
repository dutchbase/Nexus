import { describe, expect, it } from "vitest";
import { previewField } from "./pages/forms.ts";

describe("form preview attachments", () => {
  it("renders image_upload as a file control", () => {
    const html = previewField({ field_type: "image_upload", label: "Screenshots", required: false });
    expect(html).toContain('type="file"');
    expect(html).toContain("disabled");
    expect(html).toContain("PNG of JPG");
  });
  it("keeps generic fields as before", () => {
    expect(previewField({ field_type: "short_text", label: "Name", required: true })).toContain("placeholder=");
  });
});
