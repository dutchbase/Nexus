import { describe, expect, it } from "vitest";
import { clipboardImageType, imageUploadControl, imageUploadScript } from "./image-upload-control.ts";

describe("image upload control", () => {
  it("prefers PNG and accepts only supported clipboard image types", () => {
    expect(clipboardImageType(["text/html", "image/png", "image/jpeg"])).toBe("image/png");
    expect(clipboardImageType(["text/plain"])).toBeNull();
    expect(clipboardImageType(["image/svg+xml"])).toBeNull();
  });

  it("renders accessible non-submitting controls and existing images", () => {
    const html = imageUploadControl({
      fieldKey: "screenshots", label: "Screenshots", required: true,
      uploadUrl: "/api/projects/project-1/uploads",
      existing: [{ id: "attachment-1", upload_id: "upload-1", field_key: "screenshots", original_name: "saved.png", media_type: "image/png", size_bytes: 8, url: "/attachments/attachment-1" }],
    });
    expect(html).toContain(">Paste<");
    expect(html).toContain("Choose files");
    expect(html).toContain('type="button"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('data-image-error="screenshots"');
    expect(html).toContain("Remove");
    expect(html).not.toContain(" required");
  });

  it("contains clipboard, shared picker, retry, removal and form-state behavior", () => {
    const script = imageUploadScript();
    expect(() => new Function(script)).not.toThrow();
    expect(script).toContain("navigator.clipboard.read()");
    expect(script).toContain("addImage(file)");
    expect(script).toContain("retryImage");
    expect(script).toContain("selections(form)");
    expect(script).toContain("pending(form)");
    expect(script).toContain("invalid(form)");
    expect(script).toContain("5*1024*1024");
  });
});
