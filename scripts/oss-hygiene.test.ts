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

  it(".env.example exists, is tracked (not swallowed by .gitignore), and documents every required variable", () => {
    const envExample = readFileSync(new URL(".env.example", root), "utf8");
    for (const required of ["DATABASE_URL", "PORT", "APP_BASE_URL", "GITHUB_TOKEN", "GITHUB_API_BASE_URL", "PROJECTS_CONFIG_PATH", "WEBHOOK_SECRET", "DEPLOY_PROTECTED_BRANCH"]) {
      expect(envExample).toContain(required);
    }
    const gitignore = readFileSync(new URL(".gitignore", root), "utf8");
    const envStarLine = gitignore.split("\n").find((line) => line.trim() === ".env.*");
    expect(envStarLine, ".gitignore must still ignore .env.* (real secrets)").toBeTruthy();
    const negation = gitignore.split("\n").find((line) => line.trim() === "!.env.example");
    expect(negation, ".gitignore must explicitly un-ignore .env.example").toBeTruthy();
  });
});
