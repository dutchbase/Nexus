import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("pull request follow-up modal", () => {
  it("requires feedback and waits for an AI-generated description", async () => {
    const html = await readFile(new URL("./prs.ts", import.meta.url), "utf8");

    expect(html).toContain('name="feedback" rows="4" required');
    expect(html).toContain('name="description" rows="4" required readonly');
    expect(html).toContain('data-generate-follow-up-description');
    expect(html).toContain('type="submit" disabled>Create</button>');
  });

  it("only unlocks a completed generation and clears an old draft while a new one runs", async () => {
    const script = await readFile(new URL("../ui.ts", import.meta.url), "utf8");

    expect(script).toContain('result.status==="completed"&&typeof result.generated_description==="string"');
    expect(script).toContain('description.value="";description.readOnly=true;createButton.disabled=true');
  });
});
