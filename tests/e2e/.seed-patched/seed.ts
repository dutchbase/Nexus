#!/usr/bin/env node
// Loads harness/fixtures/seed.sql into DATABASE_URL via psql.
//
// Deliberately dependency-free (no `pg` package) so this runs before/without
// packages/database being scaffolded. Substitutes the four __REPO_PATH_*__
// placeholders with the real git-fixture checkout paths so agent_runs.working_directory
// and projects.repository_path point at repos that actually exist on disk.
//
// Usage:
//   DATABASE_URL=postgresql://... \
//   FIXTURE_REPO_VA_JOBS_PLATFORM=/path \
//   FIXTURE_REPO_CORPORATE_SITE=/path \
//   FIXTURE_REPO_CUSTOMER_PORTAL=/path \
//   FIXTURE_REPO_BILLING_API=/path \
//   node seed.ts   (or: npx tsx seed.ts)
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("seed.ts: DATABASE_URL is required");
  process.exit(1);
}

const REQUIRED_PATH_VARS = [
  "FIXTURE_REPO_VA_JOBS_PLATFORM",
  "FIXTURE_REPO_CORPORATE_SITE",
  "FIXTURE_REPO_CUSTOMER_PORTAL",
  "FIXTURE_REPO_BILLING_API",
];
for (const v of REQUIRED_PATH_VARS) {
  if (!process.env[v]) {
    console.error(`seed.ts: ${v} is required (run harness/git-fixtures/create-fixtures.sh first and export its FIXTURE_REPO_* output)`);
    process.exit(1);
  }
}

const sqlPath = path.join(__dirname, "seed.sql");
let sql = fs.readFileSync(sqlPath, "utf8");

sql = sql
  .replaceAll("__REPO_PATH_VA_JOBS_PLATFORM__", process.env.FIXTURE_REPO_VA_JOBS_PLATFORM)
  .replaceAll("__REPO_PATH_CORPORATE_SITE__", process.env.FIXTURE_REPO_CORPORATE_SITE)
  .replaceAll("__REPO_PATH_CUSTOMER_PORTAL__", process.env.FIXTURE_REPO_CUSTOMER_PORTAL)
  .replaceAll("__REPO_PATH_BILLING_API__", process.env.FIXTURE_REPO_BILLING_API);

const tmpPath = path.join(require("os").tmpdir(), `dcc-seed-${Date.now()}.sql`);
fs.writeFileSync(tmpPath, sql);

try {
  execFileSync("psql", [DATABASE_URL, "-v", "ON_ERROR_STOP=1", "-f", tmpPath], {
    stdio: "inherit",
  });
  console.error("seed.ts: loaded seed.sql into", DATABASE_URL.replace(/:[^:@]*@/, ":***@"));
} finally {
  fs.unlinkSync(tmpPath);
}
