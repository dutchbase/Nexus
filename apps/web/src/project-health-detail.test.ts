import { describe, expect, test } from "vitest";
import { dirtyBanner, repositoryDiagnosticsPanel } from "./pages/projects.ts";

const baseProject = {
  id: "project-1",
  repository_path: "/repos/app",
  last_validated_at: "2026-08-27T10:00:00Z",
};

describe("repository dirty diagnostics", () => {
  test("dirty project shows a real file count, not the hardcoded fallback of 3", () => {
    const project = {
      ...baseProject,
      health_status: "repository_dirty",
      health_detail_json: {
        summary: { modified: 2, untracked: 1 },
        files: [
          { path: "app/routes/admin.tsx", status: "modified", staged: false },
          { path: "new-file.txt", status: "untracked", staged: false },
        ],
      },
    };
    const html = dirtyBanner(project);
    expect(html).toContain("2 modified");
    expect(html).toContain("1 untracked");
    expect(html).not.toMatch(/\b3\b/);
  });

  test("dirty diagnostics list each changed file with its category", () => {
    const project = {
      ...baseProject,
      health_status: "repository_dirty",
      health_detail_json: {
        summary: { modified: 1 },
        files: [{ path: "app/routes/admin.tsx", status: "modified", staged: false }],
      },
    };
    const html = repositoryDiagnosticsPanel(project);
    expect(html).toContain("app/routes/admin.tsx");
    expect(html).toContain("Modified");
  });

  test("merge conflicts render a visually distinct, more severe state than ordinary modifications", () => {
    const project = {
      ...baseProject,
      health_status: "repository_dirty",
      health_detail_json: {
        summary: { conflicted: 1 },
        files: [{ path: "conflict.txt", status: "conflicted", staged: false }],
      },
    };
    const html = repositoryDiagnosticsPanel(project);
    expect(html).toMatch(/conflict/i);
    expect(html).toContain("var(--t-danger)");
  });

  test("inspection_error status shows a distinct message, never 'repository_dirty' wording", () => {
    const project = {
      ...baseProject,
      health_status: "inspection_error",
      health_error: "not_a_repo: fatal: not a git repository",
      health_detail_json: null,
    };
    const html = repositoryDiagnosticsPanel(project);
    expect(html).not.toContain("repository_dirty");
    expect(html).toMatch(/repository status unavailable|inspection.*failed/i);
  });

  test("dirty project with no stored detail never claims there are no local changes", () => {
    const project = { ...baseProject, health_status: "repository_dirty", health_detail_json: null };
    const html = repositoryDiagnosticsPanel(project);
    expect(html).not.toContain("No local changes");
    expect(html).toMatch(/not available yet/i);
    // The page banner still says blocked, so the panel must agree with it.
    expect(dirtyBanner(project)).toContain("blocked");
  });

  test("clean project shows no diagnostics section", () => {
    const project = { ...baseProject, health_status: "healthy", health_detail_json: null };
    expect(dirtyBanner(project)).toBe("");
    const html = repositoryDiagnosticsPanel(project);
    expect(html).not.toContain("Local changes");
  });
});
