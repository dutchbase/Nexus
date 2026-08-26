import { describe, expect, it } from "vitest";
import { allowedTemplateVariables, statusBadge, statusTone } from "./shared.ts";

describe("status tone scale", () => {
  it("colors failures red, completions green, review-needed amber", () => {
    expect(statusTone("Execution Failed")).toBe("danger");
    expect(statusTone("Validation Failed")).toBe("danger");
    expect(statusTone("Rejected")).toBe("danger");
    expect(statusTone("failed")).toBe("danger");
    expect(statusTone("Completed")).toBe("ok");
    expect(statusTone("Merged")).toBe("ok");
    expect(statusTone("sent")).toBe("ok");
    expect(statusTone("Plan Ready for Review")).toBe("run");
    expect(statusTone("Plan Revision Requested")).toBe("warn");
    expect(statusTone("Needs Information")).toBe("warn");
  });

  it("keeps organizational states quiet", () => {
    expect(statusTone("Archived")).toBe("muted");
    expect(statusTone("Cancelled")).toBe("muted");
    expect(statusTone("Closed Without Merge")).toBe("muted");
    expect(statusTone("Disabled")).toBe("muted");
  });

  it("falls back to muted so an unknown status never looks alarming", () => {
    expect(statusTone("Some Future Status")).toBe("muted");
    expect(statusTone(null)).toBe("muted");
    expect(statusTone("")).toBe("muted");
  });

  it("renders a badge with the tone class and escaped label", () => {
    expect(statusBadge("Completed")).toBe('<span class="status ok">Completed</span>');
    expect(statusBadge('x <script>')).toBe('<span class="status muted">x &lt;script&gt;</span>');
  });
});

describe("allowed template variables", () => {
  it("includes the effective planning agent start path", () => {
    expect(allowedTemplateVariables.has("project.agent_start_path")).toBe(true);
  });

  it("allows the trusted Superpowers PR-review rubric", () => {
    expect(allowedTemplateVariables.has("superpowers.code-reviewer")).toBe(true);
  });
});
