import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { formatFollowUpDescription } from "./follow-up-description.ts";

describe("formatFollowUpDescription", () => {
  it("adds the PR source first and keeps the complete description within 12000 characters", () => {
    const description = formatFollowUpDescription(
      { number: 42, title: "Repair login flow", url: "https://github.com/acme/widgets/pull/42" },
      "x".repeat(12_100),
    );

    expect(description.startsWith("## Source\n\n- Pull request: [PR #42: Repair login flow](https://github.com/acme/widgets/pull/42)\n\n")).toBe(true);
    expect(description).toHaveLength(12_000);
  });
});

it("casts the JSON key when saving generated output", async () => {
  const worker = await readFile(new URL("./worker.ts", import.meta.url), "utf8");
  expect(worker).toContain("jsonb_build_object($2::text,$3::text)");
});
