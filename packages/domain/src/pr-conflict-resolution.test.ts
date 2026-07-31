import { describe, expect, it } from "vitest";
import { renderConflictResolutionPrompt } from "./pr-conflict-resolution.ts";

describe("conflict resolution prompt", () => {
  it("embeds project, PR, and conflicted file content", () => {
    const prompt = renderConflictResolutionPrompt(
      "{{project.name}} / {{pr.title}} / {{pr.head_branch}} -> {{pr.base_branch}}\n\n{{conflicted_files}}",
      {
        project: { name: "Billing" },
        pr: { title: "Fix checkout", headBranch: "feature/checkout", baseBranch: "main" },
        conflictedFiles: [{ path: "src/checkout.ts", content: "<<<<<<< HEAD\nfoo\n=======\nbar\n>>>>>>> main" }],
      },
    );
    expect(prompt).toContain("Billing / Fix checkout / feature/checkout -> main");
    expect(prompt).toContain("src/checkout.ts");
    expect(prompt).toContain("<<<<<<< HEAD");
  });

  it("joins multiple conflicted files", () => {
    const prompt = renderConflictResolutionPrompt("{{conflicted_files}}", {
      project: { name: "P" },
      pr: { title: "T", headBranch: "h", baseBranch: "b" },
      conflictedFiles: [
        { path: "a.ts", content: "conflict-a" },
        { path: "b.ts", content: "conflict-b" },
      ],
    });
    expect(prompt).toContain("a.ts");
    expect(prompt).toContain("conflict-a");
    expect(prompt).toContain("b.ts");
    expect(prompt).toContain("conflict-b");
  });
});
