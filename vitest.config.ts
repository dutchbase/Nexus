import { configDefaults, defineConfig } from "vitest/config";

// ponytail: tests/e2e/** are Playwright specs — vitest collecting them fails
// with "Playwright Test did not expect test() to be called here" and has kept
// CI red since the journey suite landed.
// .worktrees/** holds stale source copies from feature worktrees; running
// their test suites produces duplicate, drifting results.
export default defineConfig({ test: { testTimeout: 15_000, exclude: [...configDefaults.exclude, ".lfd/**", "tests/e2e/**", "data/worktrees/**", ".worktrees/**"] } });
