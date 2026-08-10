import { describe, expect, it } from "vitest";
import { formControls, publicSubmissionPayload } from "./ui.ts";

describe("ticket submission form controls", () => {
  it("renders saved admin values without admin-only field types", () => {
    const html = formControls([
      { field_key: "source_url", field_type: "url", label: "Source URL" },
      { field_key: "details", field_type: "long_text", label: "Details" },
      { field_key: "priority", field_type: "dropdown", label: "Priority", options_json: ["Low", "High"] },
      { field_key: "project_id", field_type: "project_selector", label: "Project" },
      { field_key: "follow_up", field_type: "checkbox", label: "Follow up" },
      { field_key: "evidence", field_type: "image_upload", label: "Evidence" },
    ], [{ id: "project-1", name: "First project" }, { id: "project-2", name: "Saved project" }], {
      source_url: "https://example.test/report",
      details: "Saved custom text",
      priority: "High",
      project_id: "project-2",
      follow_up: true,
    }, "admin");

    expect(html).toContain('name="source_url" type="url" value="https://example.test/report"');
    expect(html).toContain('name="details" rows="5">Saved custom text</textarea>');
    expect(html).toContain('<option value="High" selected>High</option>');
    expect(html).toContain('<option value="project-2" selected>Saved project</option>');
    expect(html).toContain('name="follow_up" type="checkbox" value="true" checked');
    expect(html).not.toContain('type="file"');
  });

  it("renders an optional admin multi-select without a saved value", () => {
    expect(formControls([
      { field_key: "labels", field_type: "multi_select", label: "Labels", options_json: ["alpha", "beta"] },
    ], [], {}, "admin")).toContain('<select name="labels" multiple>');
  });

  it("preserves repeated public form values as an array", () => {
    expect(publicSubmissionPayload([
      ["title", "Saved title"], ["labels", "alpha"], ["labels", "beta"],
    ])).toEqual({ title: "Saved title", labels: ["alpha", "beta"] });
  });
});
