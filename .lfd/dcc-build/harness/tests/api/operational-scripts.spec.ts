import { describe, it, expect } from "vitest";
import { existsSync } from "fs";
import path from "path";

describe("OPS-05: Operational scripts exist and are discoverable", () => {
  // Resolve monorepo root: from harness/tests/api/ go up 4 levels
  // harness/tests/api/ -> harness/tests/ -> harness/ -> .worktrees/dcc-build/ -> root
  const monoRepoRoot = path.resolve(__dirname, "../../../../..");

  it("should locate monorepo root correctly", () => {
    // Verify we can find a marker file (package.json, pnpm-workspace.yaml, etc.)
    const markerExists = existsSync(path.join(monoRepoRoot, "package.json"))
      || existsSync(path.join(monoRepoRoot, "pnpm-workspace.yaml"));
    expect(markerExists).toBe(true);
  });

  it("scripts/create-admin.ts should exist", () => {
    const scriptPath = path.join(monoRepoRoot, "scripts", "create-admin.ts");
    expect(existsSync(scriptPath)).toBe(true);
  });

  it("scripts/validate-projects.ts should exist", () => {
    const scriptPath = path.join(monoRepoRoot, "scripts", "validate-projects.ts");
    expect(existsSync(scriptPath)).toBe(true);
  });

  it("scripts/validate-skills.ts should exist", () => {
    const scriptPath = path.join(monoRepoRoot, "scripts", "validate-skills.ts");
    expect(existsSync(scriptPath)).toBe(true);
  });

  it("scripts/check-claude-auth.sh should exist", () => {
    const scriptPath = path.join(monoRepoRoot, "scripts", "check-claude-auth.sh");
    expect(existsSync(scriptPath)).toBe(true);
  });

  it("scripts/sync-pull-requests.ts should exist", () => {
    const scriptPath = path.join(monoRepoRoot, "scripts", "sync-pull-requests.ts");
    expect(existsSync(scriptPath)).toBe(true);
  });

  it("scripts/cleanup-worktrees.ts should exist", () => {
    const scriptPath = path.join(monoRepoRoot, "scripts", "cleanup-worktrees.ts");
    expect(existsSync(scriptPath)).toBe(true);
  });

  // NOTE: We intentionally do NOT execute these scripts here. Execution has
  // side effects that vary significantly by environment (creating users, syncing
  // GitHub state, cleaning up worktrees, etc.). The stronger proof for
  // create-admin.ts specifically is that run-evals.sh already executes it
  // non-interactively before the test suite runs (see HARNESS_CONVENTIONS.md),
  // which exercises the real Argon2id hashing and login path end-to-end.
  //
  // This test file verifies all operational scripts are present and locatable,
  // which is sufficient for the OPS-05 requirement. Individual script
  // integration is covered by the harness bootstrap phase (run-evals.sh).
});
