import { configDefaults, defineConfig } from "vitest/config";

// ponytail: tests/e2e/** are Playwright specs — vitest collecting them fails
// with "Playwright Test did not expect test() to be called here" and has kept
// CI red since the journey suite landed.
export default defineConfig({ test: { exclude: [...configDefaults.exclude, ".lfd/**", "tests/e2e/**", "data/worktrees/**"] } });
