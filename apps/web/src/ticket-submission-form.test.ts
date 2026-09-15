import { describe, expect, it } from "vitest";
import { characterCounterScript, formControls, publicFormPage } from "./ui.ts";

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
    expect(html).toContain('name="details" rows="5" maxlength="10000">Saved custom text</textarea>');
    expect(html).toContain('<option value="High" selected>High</option>');
    expect(html).toContain('<option value="project-2" selected>Saved project</option>');
    expect(html).toContain('name="follow_up" type="checkbox" value="true" checked');
    expect(html).toContain('type="file"');
    expect(html).toContain('data-image-control="evidence"');
  });

  it("renders an optional admin multi-select without a saved value", () => {
    expect(formControls([
      { field_key: "labels", field_type: "multi_select", label: "Labels", options_json: ["alpha", "beta"] },
    ], [], {}, "admin")).toContain('<select name="labels" multiple>');
  });

  it("renders an admin multi-select saved by an older scalar value", () => {
    expect(formControls([
      { field_key: "labels", field_type: "multi_select", label: "Labels", options_json: ["alpha", "beta"] },
    ], [], { labels: "alpha" }, "admin")).toContain('<option value="alpha" selected>alpha</option>');
  });

  it("emits a public submit script that groups repeated values", () => {
    const page = publicFormPage({ slug: "feedback", title: "Feedback", description: "" }, [], []);

    expect(page).not.toContain("publicSubmissionPayload(values)");
    expect(page).toContain('payload[key]=key in payload?[].concat(payload[key],value):value');
    expect(page).toContain("window.nexusImages.selections(form)");
    expect(page).not.toContain("retainedUploads");
  });

  it("serializes a checked checkbox as a boolean", () => {
    const page = publicFormPage({ slug: "feedback", title: "Feedback", description: "" }, [
      { field_key: "follow_up", field_type: "checkbox", label: "Follow up" },
    ], []);

    expect(page).toContain('"follow_up":"checkbox"');
    expect(page).toContain('if(type==="checkbox")payload[key]=payload[key]==="true"');
  });

  it("disables public image controls when form attachments are disabled", () => {
    const page = publicFormPage({ slug: "feedback", title: "Feedback", description: "", settings_json: { allow_image_attachments: false } }, [
      { field_key: "evidence", field_type: "image_upload", label: "Evidence" },
    ], []);

    expect(page).toContain("data-image-paste disabled");
    expect(page).toContain("data-image-picker disabled");
  });

  it("serializes a one-choice multi-select as an array", () => {
    const page = publicFormPage({ slug: "feedback", title: "Feedback", description: "" }, [
      { field_key: "labels", field_type: "multi_select", label: "Labels", options_json: ["alpha"] },
    ], []);

    expect(page).toContain('"labels":"multi_select"');
    expect(page).toContain('else if(type==="multi_select")payload[key]=Array.isArray(payload[key])?payload[key]:key in payload?[payload[key]]:[]');
  });

  it("retains the submission key across rate limits and server/network failures", () => {
    const page = publicFormPage({ slug: "feedback", title: "Feedback", description: "" }, [], []);
    expect(page).toContain('if(response.status===400||response.status===422)idempotencyKey=crypto.randomUUID()');
    expect(page).not.toContain('if(!response.ok){idempotencyKey=crypto.randomUUID()');
  });

  it("includes the character counter script in publicFormPage", () => {
    const page = publicFormPage({ slug: "feedback", title: "Feedback", description: "" }, [], []);
    expect(page).toContain("char-counter");
    expect(page).toContain("insertAdjacentElement");
  });

  it("caps the title field at 200 chars even if a larger max_length is configured", () => {
    const html = formControls([
      { field_key: "title", field_type: "short_text", label: "Title", validation_json: { max_length: 999 } },
    ], [], {}, "admin");

    expect(html).toContain('name="title" maxlength="200"');
  });

  it("defaults a long_text field with no validation_json to a 10000 char max", () => {
    const html = formControls([
      { field_key: "details", field_type: "long_text", label: "Details" },
    ], [], {}, "admin");

    expect(html).toContain('name="details" rows="5" maxlength="10000"');
  });

  it("respects a configured max_length for a long_text field", () => {
    const html = formControls([
      { field_key: "details", field_type: "long_text", label: "Details", validation_json: { max_length: 500 } },
    ], [], {}, "admin");

    expect(html).toContain('name="details" rows="5" maxlength="500"');
  });

  it("does not add maxlength to unrelated field types", () => {
    const html = formControls([
      { field_key: "source_url", field_type: "url", label: "Source URL" },
    ], [], {}, "admin");

    expect(html).not.toContain("maxlength");
  });

  it("renders maxlength=\"0\" for a long_text field with max_length: 0", () => {
    const html = formControls([
      { field_key: "details", field_type: "long_text", label: "Details", validation_json: { max_length: 0 } },
    ], [], {}, "admin");

    expect(html).toContain('name="details" rows="5" maxlength="0"');
  });
});

describe("character counter script", () => {
  it("returns a script that finds inputs and textareas with maxlength and adds character counter", () => {
    const script = characterCounterScript();

    expect(script).toContain("char-counter");
    expect(script).toContain("insertAdjacentElement");
    expect(script).toContain('input[maxlength],textarea[maxlength]');
  });
});
