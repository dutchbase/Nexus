import { configDefaults, defineConfig } from "vitest/config";

// ponytail: tests/e2e/*.spec.ts are Playwright specs — vitest collecting them fails
// with "Playwright Test did not expect test() to be called here" and has kept
// CI red since the journey suite landed.
// **/data/worktrees/** and **/.worktrees/** hold stale source copies from
// feature worktrees and the ticket-execution worker's own per-ticket
// worktrees (including other repos entirely, e.g. apps/worker/data/worktrees/<repo>/...)
// — running their test suites produces duplicate, drifting, and even
// foreign-project results. The un-prefixed "data/worktrees/**" only matched
// the top-level directory, silently missing apps/worker/data/worktrees/** —
// discovered 2026-09-18 when that nested directory alone had grown to 875
// test files and was OOMing deploy verify.
export default defineConfig({ test: { testTimeout: 15_000, exclude: [...configDefaults.exclude, ".lfd/**", "tests/e2e/**/*.spec.ts", "**/data/worktrees/**", "**/.worktrees/**"] } });
