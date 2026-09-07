import { describe, expect, it } from "vitest";
import { allowedTemplateVariables, lineDiff, renderMarkdown, statusBadge, statusTone } from "./shared.ts";

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

  it("colors both project health failures alarmingly, never muted", () => {
    expect(statusTone("repository_dirty")).toBe("danger");
    expect(statusTone("inspection_error")).toBe("danger");
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

describe("review formatting", () => {
  it("keeps following lines aligned when one line is inserted", () => {
    expect(lineDiff("one\ntwo\nthree", "one\ninserted\ntwo\nthree")).toBe(" one\n+inserted\n two\n three");
  });

  it("renders common generated Markdown while escaping raw HTML and unsafe links", () => {
    const html = renderMarkdown("## Plan\n\n- first\n  - nested\n\n```ts\nconst x = '<x>';\n```\n\n| A | B |\n| --- | --- |\n| [safe](https://example.test) | [bad](javascript:alert(1)) |\n\n<script>alert(1)</script>");
    expect(html).toContain("<h2>Plan</h2>");
    expect(html).toContain("<ul><li>first<ul><li>nested</li></ul></li></ul>");
    expect(html).toContain('<pre><code class="language-ts">const x = &apos;&lt;x&gt;&apos;;');
    expect(html).toContain("<table>");
    expect(html).toContain('href="https://example.test"');
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("keeps arbitrarily indented list input balanced", () => {
    expect(renderMarkdown("    - starts deep\n        - jumps deeper\n- root")).toBe("<ul><li>starts deep<ul><li>jumps deeper</li></ul></li><li>root</li></ul>");
  });

  it("bounds expensive diff alignment and returns a truthful fallback", () => {
    const before = Array.from({ length: 1001 }, (_, index) => `old-${index}`).join("\n");
    const after = Array.from({ length: 1001 }, (_, index) => `new-${index}`).join("\n");
    const diff = lineDiff(before, after);
    expect(diff).toContain("@@ Diff simplified");
    expect(diff).toContain("-old-1000");
    expect(diff).toContain("+new-1000");
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
