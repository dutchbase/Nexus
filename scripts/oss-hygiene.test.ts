import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);

describe("open-source release hygiene", () => {
  it("has a LICENSE file", () => {
    const license = readFileSync(new URL("LICENSE", root), "utf8");
    expect(license).toContain("MIT License");
  });

  it("root package.json declares license, description, and repository consistent with the LICENSE file", () => {
    const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
    expect(pkg.license).toBe("MIT");
    expect(typeof pkg.description).toBe("string");
    expect(pkg.description.length).toBeGreaterThan(0);
    expect(pkg.repository).toEqual({ type: "git", url: "https://github.com/dutchbase/dev-control.git" });
  });
});
