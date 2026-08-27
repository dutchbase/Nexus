import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { loadProjectConfig } from "@dcc/project-config";
import { parse } from "yaml";
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

  it("has contribution docs and GitHub templates", () => {
    expect(existsSync(new URL("CONTRIBUTING.md", root))).toBe(true);
    expect(existsSync(new URL(".github/PULL_REQUEST_TEMPLATE.md", root))).toBe(true);
    expect(existsSync(new URL(".github/ISSUE_TEMPLATE/bug_report.md", root))).toBe(true);
    expect(existsSync(new URL(".github/ISSUE_TEMPLATE/feature_request.md", root))).toBe(true);
  });

  it("does not hardcode a private deploy path as the default in shipped deploy tooling", () => {
    for (const file of ["deploy.sh", "webhook-server.js", "webhook-runner.sh"]) {
      const content = readFileSync(new URL(file, root), "utf8");
      expect(content, `${file} should not default to /home/deploy/...`).not.toContain("/home/deploy/");
    }
  });

  it("does not expose a real SSH host alias in the deployment runbook", () => {
    const runbook = readFileSync(new URL("docs/DEPLOYMENT-RUNBOOK.md", root), "utf8");
    expect(runbook).not.toContain("vps-nederland");
    expect(runbook).not.toContain("/home/deploy/");
  });

  it("does not track internal AI-build scaffolding referencing the operator's private home directory", () => {
    const tracked = execFileSync("git", ["ls-files"], { cwd: new URL(".", root), encoding: "utf8" });
    const lfdFiles = tracked.split("\n").filter((line) => line.startsWith(".lfd/"));
    expect(lfdFiles).toEqual([]);
    expect(tracked).not.toContain("prompts/lfd-dev-control-center.md");
  });

  it("README leads with what Nexus is, and covers every required open-source section", () => {
    const readme = readFileSync(new URL("README.md", root), "utf8");
    expect(readme.startsWith("# Nexus")).toBe(true);
    expect(readme).not.toContain("/home/deploy/");
    for (const heading of [
      "## What is Nexus?",
      "## Features",
      "## Project status",
      "## Prerequisites",
      "## Installation",
      "## Configuration",
      "### Environment variables",
      "## Running locally",
      "## Production / self-hosted deployment",
      "### Configuring projects",
      "### GitHub integration",
      "### Authentication",
      "## Troubleshooting",
      "## Security",
      "## Contributing",
      "## License",
      "## Contact",
    ]) {
      expect(readme, `README missing section: ${heading}`).toContain(heading);
    }
  });

  it("the tracked config/projects.yaml (empty, no private data) loads successfully", async () => {
    // loadProjectConfig returns { path, content, config } — not the parsed
    // config directly (packages/project-config/src/index.ts:16-23).
    const { config } = await loadProjectConfig(new URL("config/projects.yaml", root).pathname);
    expect(config.version).toBe(1);
    expect(config.projects).toEqual({});
  });

  it("the README's example project config block is structurally valid YAML with the required fields", () => {
    const readme = readFileSync(new URL("README.md", root), "utf8");
    const match = readme.match(/```yaml\n(version: 1[\s\S]*?example-app:[\s\S]*?)```/);
    expect(match, "README should contain a fenced yaml example with an example-app project").toBeTruthy();
    const parsed = parse(match![1]);
    expect(parsed.projects["example-app"].paths.repository).toBeTruthy();
  });
});
