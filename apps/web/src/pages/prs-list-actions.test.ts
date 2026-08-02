import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("pull request list actions", () => {
  it("renders a menu beside a non-nested row detail link", async () => {
    const page = await readFile(new URL("./prs.ts", import.meta.url), "utf8");
    const script = await readFile(new URL("../ui.ts", import.meta.url), "utf8");

    expect(page).toContain('data-pr-id="${item.id}"');
    expect(page).toContain('aria-label="Pull request actions">•••');
    expect(page).toContain("data-pr-list-approve");
    expect(page).toContain("data-pr-list-ai-review-merge");
    expect(page).toContain('class="pr-row-link"');
    expect(page).toContain("<span>Merge Status</span>");
    expect(page).toContain('class="card prs-card"');
    expect(page).not.toContain('return `<a class="ticket-row prs-row"');
    expect(script).toContain("async function listPrAction");
    const css = await readFile(new URL("../design-tokens.css", import.meta.url), "utf8");
    expect(css).toContain(".prs-row:has(.menu[open]) { z-index:2 }");
    expect(css).toContain("background-color:var(--raised)");
  });
});
