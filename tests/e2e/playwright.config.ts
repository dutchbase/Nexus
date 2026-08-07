import { defineConfig } from "@playwright/test";

// End-user journey suite. Run via tests/e2e/run-e2e.sh, which boots the
// hermetic stack (ephemeral Postgres, mock-claude, mock-github, web+worker)
// and exports APP_BASE_URL / DATABASE_URL / admin credentials.
export default defineConfig({
  testDir: __dirname,
  testMatch: "**/*.spec.ts",
  // Journeys mutate shared app state (tickets, jobs, worker queue) — run
  // them sequentially so DB polling assertions stay unambiguous.
  workers: 1,
  fullyParallel: false,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  outputDir: `${__dirname}/.results`,
  use: {
    baseURL: process.env.APP_BASE_URL ?? "http://127.0.0.1:3100",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
