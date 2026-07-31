import { describe, expect, it } from "vitest";
import { allowedTemplateVariables } from "./shared.ts";

describe("allowed template variables", () => {
  it("includes the effective planning agent start path", () => {
    expect(allowedTemplateVariables.has("project.agent_start_path")).toBe(true);
  });
});
