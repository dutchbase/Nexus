# Fix VA Jobs Platform Pre-flight Placeholder Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge pre-flight for `va-jobs-platform` fails with a raw `ENOENT`/`realpath` error against the literal placeholder path `/PLACEHOLDER/set-a-real-local-clone-path-for-va-jobs-platform` seeded by an earlier migration, even though the Projects page shows a real, correctly-configured local path. This plan (1) reconciles the specific stuck data state in the database, (2) adds config validation that treats a placeholder/empty repository path as an invalid-configuration error everywhere a local path is consumed — before any `realpath()`/git operation ever runs — so this class of bug fails clearly instead of as a raw filesystem error, and (3) adds regression coverage so it can't silently regress.

**Architecture:** Investigation (below) traced every place a project's local clone path can originate and confirmed there is only **one** live, authoritative source: the `projects.repository_path` database column, read fresh (no caching, no `projects.yaml`, no job-payload snapshot) by every consumer — the Projects page, the Merge page's project dropdown, the Production tab's `va-jobs-platform` lookup, the `github.merge_preview` worker job, and the `project.validate` "Recheck repository" job all issue a live `SELECT`/`UPDATE` against that same column and row. There is no dual-source-of-truth *code* bug. The actual defect is a **data** integrity gap: `projects.slug` is the only unique constraint on the table — nothing stops two rows from describing the same GitHub repository — and the already-merged migration `059_va_jobs_platform_project.sql` seeds a row keyed specifically by `slug='va-jobs-platform'` with a placeholder `repository_path`, deliberately never overwriting `repository_path` on conflict. The Production tab and the production-promotion allowlist (`packages/domain/src/production-promotion-allowlist.ts:11`) both hardcode resolution by that exact slug. If the project's real, working local path was ever configured on a *different* pre-existing project row (a plausible scenario given the ticket's own example shows the working project displayed under the name **"Jobs-platform"**, not "VA Jobs Platform" — i.e. a different row than the one migration 059 seeded), that real path never reaches the `slug='va-jobs-platform'` row the pre-flight/Production-tab code actually uses, and the placeholder survives indefinitely. This plan reconciles that specific data state with a safe, idempotent, non-destructive migration, and — independent of whatever the live data turns out to be — hardens `validateProject()` and `previewRemoteBranchMerge()` so a placeholder or empty path is always caught before `realpath()`/`stat()` ever runs, everywhere either function is used.

**Tech Stack:** Node.js/TypeScript monorepo (pnpm workspaces), raw `pg`, Postgres 16. `packages/project-config` (pure validation helpers, no I/O framework), `packages/git-runner` (git/filesystem primitives incl. `realpath`), `apps/worker` (job handlers), `apps/web` (routes + Projects/Merge pages). Vitest, with the same `*.db.test.ts` real-Postgres integration convention used elsewhere in this repo.

**Spec:** This plan's own investigation (below) — no separate design doc. Source task: "Fix VA Jobs Platform pre-flight using stale placeholder local path" (dev-control task list, 2026-08-27).

## Investigation findings (ground truth — verified against live code; DB row state could not be queried directly from this planning session's sandbox, which has no running Postgres instance — Task 1 below has the executor verify live data before applying the reconciliation)

- **The placeholder's origin, verbatim:** `packages/database/migrations/059_va_jobs_platform_project.sql:10-13` — already-merged (PR #58). `INSERT INTO projects (id, slug, name, github_owner, github_repository, default_branch, repository_path, config_json, health_status) VALUES (gen_random_uuid(), 'va-jobs-platform', 'VA Jobs Platform', 'dutchbase', 'va-jobs-platform', 'master', '/PLACEHOLDER/set-a-real-local-clone-path-for-va-jobs-platform', ..., 'unknown') ON CONFLICT (slug) DO UPDATE SET config_json = ..., github_owner = 'dutchbase', github_repository = 'va-jobs-platform', default_branch = 'master';` — note the `ON CONFLICT (slug) DO UPDATE` clause **never touches `repository_path`** (deliberately, per the migration's own header comment) — so if a row with that exact slug already existed with a real path, it would have survived; only a *new* row (no prior row with that exact slug) gets the placeholder, and nothing has overwritten it since. The only other occurrence of this literal string anywhere in the repo is the test fixture `apps/worker/src/provider-jobs.production-promotion.test.ts:91` (a mock, not live data).
- **`projects` table has no protection against two rows describing the same repo:** `packages/database/migrations/001_foundation.sql:32-35` — only `slug text NOT NULL UNIQUE`. No unique constraint or index on `(github_owner, github_repository)`. Confirmed by grepping every migration for `UNIQUE`/`CREATE UNIQUE INDEX` — none reference `github_owner`/`github_repository`.
- **`packages/project-config/src/index.ts`'s `loadProjectConfig()` (a `config/projects.yaml` reader) is dead code** — `rtk grep -rn "loadProjectConfig"` across `apps/` and `packages/` (excluding its own definition and tests) returns zero callers. `config/projects.yaml` itself exists but its `projects:` mapping is empty (`{}`) — it is not a competing source of truth; nothing in the running application reads it. Ruled out as a cause.
- **Every real consumer of `repository_path` reads live from the DB, with no caching:**
  - Projects page: `apps/web/src/server.ts:1712` (`GET /api/admin/projects/:id`) and `:1716-1737` (`PATCH /api/admin/projects/:id`, the edit-form save handler — `repository_path` is in the `allowed` field list at line 1728) both do a plain `SELECT`/`UPDATE ... WHERE id=$1` against `projects` on every request. `apps/web/src/pages/projects.ts:215` renders the edit form bound directly to `project.repository_path`.
  - Merge page's generic project dropdown: `apps/web/src/pages/merge.ts:17-20` — `SELECT id, name, default_branch FROM projects WHERE github_owner IS NOT NULL AND github_repository IS NOT NULL AND repository_path IS NOT NULL ORDER BY name` — this is a **live** query on every page load, but critically its `WHERE` clause only checks `repository_path IS NOT NULL`, not that it's a *real* path — a placeholder string is non-null and passes this filter, so a row with a placeholder path appears in the dropdown exactly like a correctly-configured one, with no visual distinction.
  - Merge page's Production tab: `apps/web/src/pages/merge.ts:19` — `SELECT id, config_json FROM projects WHERE slug='va-jobs-platform'` — hardcoded slug lookup, always resolves to the migration-059-seeded row specifically.
  - Pre-flight job itself: `apps/web/src/server.ts:1359-1371` (`POST /api/admin/projects/:id/merge-preview`, the route the Merge page's "Pre-flight" card calls) does `SELECT * FROM projects WHERE id=$1` (line 1361) using the `project_id` the user selected in the dropdown, then enqueues a `github.merge_preview` job with that `project_id` in the payload — **no path value is snapshotted into the job payload**, only the id. The worker handler, `apps/worker/src/provider-jobs.ts:253-268`, re-reads fresh: `const project = (await db.query("SELECT * FROM projects WHERE id=$1", [projectId])).rows[0];` (line 261), then calls `previewRemoteBranchMerge({ repositoryPath: project.repository_path, head, base })` (line 264).
  - The actual `realpath()` call and the exact reported error: `packages/git-runner/src/index.ts:847-852`, `previewRemoteBranchMerge(input: { repositoryPath, head?, base? })` → `const repository = await realpath(input.repositoryPath);` at line 852 — this is the literal call that throws `ENOENT: no such file or directory, realpath '/PLACEHOLDER/...'` when `input.repositoryPath` is still the placeholder.
  - `project.validate` ("Recheck repository", from already-merged plan 05): `apps/worker/src/project-validate-job.ts:19-24` — same pattern, `SELECT * FROM projects WHERE id=$1` then `validateProject({ repositoryPath: project.repository_path, ... })`.
  - **Conclusion: there is no code-level cache or dual-source bug.** Projects page and pre-flight read the identical column of the identical row, live, every time. If pre-flight is using the placeholder, that specific DB row's `repository_path` column is still literally the placeholder string today — the "correctly configured" project the user sees on the Projects page is very likely a **different row** (matching the ticket's own example, which names the project **"Jobs-platform"**, not "VA Jobs Platform" — consistent with a second, earlier-created project row for this same GitHub repository under a different slug/name).
- **`validateProject()` (`packages/project-config/src/index.ts:139-177`)** takes `repositoryPath` as a plain string and immediately does `stat(input.repositoryPath)` (line 144) with no upfront sanity check — a placeholder path reaches `stat`/`access`/`git rev-parse` exactly like a real broken path, producing `errorCode: "path_missing"` today (via `classifyInspectionError`, line 124-137, which maps `ENOENT` → `"path_missing"`) rather than a distinct "this is a known-invalid placeholder, an admin must configure a real path" signal.
- **How a validation error already surfaces cleanly today (existing UI wiring to build on, from already-merged plan 05):** `apps/worker/src/project-validate-job.ts:28-34` — on `!result.ok`, stores `health_status='inspection_error'`, `health_error = "${result.errorCode}: ${result.message}"`. `apps/web/src/pages/projects.ts:87-93` (`repositoryDiagnosticsPanel`) already renders a friendly red-bordered card for `health_status === "inspection_error"` showing `project.health_error` — **no new UI is needed**; adding a new `errorCode` in `validateProject` flows through this existing surface automatically.
- **Migration runner supports multi-statement/PL-pgSQL migration files:** `packages/database/src/migrate.ts:64` runs each migration file's entire contents as one `client.query(...)` call inside a transaction (`BEGIN`/`COMMIT` around it, lines 62-66) — a `DO $$ ... $$` block is safe to use for the conditional data-reconciliation migration in Task 1.

## Global Constraints

- Do not hardcode the real `va-jobs-platform` filesystem path anywhere in application code — only the reconciliation migration (Task 1) may reference the placeholder *string* (to detect and replace it), never a real path literal.
- Do not add a schema migration that changes column types or constraints for this ticket — the schema (columns, types) is correct; only seed *data* needs reconciling (a `DO $$...$$` data-fix migration, not a structural change), and validation logic needs hardening. Do not add a `UNIQUE (github_owner, github_repository)` constraint in this plan — that is a larger behavior change (would reject legitimate multi-checkout setups) outside this ticket's scope; flag it as a follow-up instead (see Self-Review Notes).
- Do not silently fall back to any default/placeholder path — every code path that currently would call `realpath()`/`stat()` on a placeholder must instead throw/return a distinct, typed error before doing so.
- Do not show raw `ENOENT`/`realpath` text as the primary user-facing message for a placeholder path specifically — surface "project local path is not configured correctly" (or equivalent) instead. A path that is genuinely missing/wrong for a non-placeholder reason keeps today's existing `path_missing` behavior (no regression there).
- Do not regress any other project's merge/pre-flight flow — every check added in this plan must be a no-op for a real, valid `repository_path`.
- Do not delete the duplicate project row (if one exists) — reconcile data non-destructively; leave any actual row deletion/rename as a manual decision for a human, called out explicitly in the final report.

---

## Task 1: Verify live data and reconcile the placeholder via a data-fix migration

**Files:**
- Create: `packages/database/migrations/061_va_jobs_platform_placeholder_path_reconciliation.sql`
- Test: `packages/database/src/va-jobs-platform-reconciliation.db.test.ts` (new)

**Interfaces:**
- Consumes: nothing — this is a standalone SQL data migration.
- Produces: nothing consumed by later tasks in this plan (Tasks 2-3 are independent code hardening that applies regardless of this migration's outcome) — but this task is what actually unblocks `va-jobs-platform` in the live environment, so it must run first in execution order.

- [ ] **Step 1: Verify the live data state before writing the fix (executor: run this against the real environment's database, read-only, before proceeding)**

```sql
SELECT id, slug, name, github_owner, github_repository, repository_path, config_version
FROM projects
WHERE github_owner = 'dutchbase' AND github_repository = 'va-jobs-platform';
```

Expected one of three outcomes — note which one before continuing, it changes what "already fixed" means for Step 2's migration guard:
- **(a)** Exactly one row, `slug='va-jobs-platform'`, `repository_path` is still literally `/PLACEHOLDER/set-a-real-local-clone-path-for-va-jobs-platform'` — confirms the placeholder was never overwritten and there is no second row; an admin needs to set the real path directly (Task 2's validation will make this failure mode clear going forward, but Task 1's migration has nothing to reconcile automatically in this case — it will correctly no-op, see Step 2).
- **(b)** Two (or more) rows for the same `github_owner`/`github_repository` — one with the placeholder (`slug='va-jobs-platform'`), one or more with a real, non-placeholder path under a different slug/name (e.g. "Jobs-platform") — this is the scenario Task 1's migration reconciles automatically.
- **(c)** The `slug='va-jobs-platform'` row's `repository_path` is already a real path (not the placeholder) — already fixed by a prior manual edit; Task 1's migration is a safe no-op (see the `IF target_id IS NULL THEN RETURN` guard below).

- [ ] **Step 2: Write the reconciliation migration**

Create `packages/database/migrations/061_va_jobs_platform_placeholder_path_reconciliation.sql`:

```sql
-- packages/database/migrations/061_va_jobs_platform_placeholder_path_reconciliation.sql
--
-- Migration 059 seeded a project row for slug='va-jobs-platform' with a
-- placeholder repository_path, and deliberately never overwrites
-- repository_path on a slug conflict (see 059's own header comment). The
-- Production tab (apps/web/src/pages/merge.ts) and the production-promotion
-- allowlist (packages/domain/src/production-promotion-allowlist.ts) both
-- resolve this feature by that exact slug -- so if a *different*,
-- pre-existing project row already represented this same GitHub repository
-- (dutchbase/va-jobs-platform) under a different slug, with a real local
-- path already configured there, that real path never reached the row this
-- feature actually reads, and the placeholder survived indefinitely.
--
-- This is data reconciliation, not a schema change: only act when the
-- 'va-jobs-platform' row's repository_path is still literally the exact
-- placeholder string, and only when there is exactly one unambiguous
-- non-placeholder candidate row for the same repository -- copy that row's
-- repository_path (and agent_start_path, if the target doesn't already have
-- one) onto the 'va-jobs-platform' row. Never destructive: the source row is
-- left untouched, nothing is deleted, and an ambiguous (0 or 2+ candidates)
-- state is logged via RAISE NOTICE and left for manual resolution rather
-- than guessed at.
DO $$
DECLARE
  target_id uuid;
  source_id uuid;
  source_repository_path text;
  source_agent_start_path text;
  candidate_count integer;
BEGIN
  SELECT id INTO target_id FROM projects
    WHERE slug = 'va-jobs-platform'
      AND repository_path = '/PLACEHOLDER/set-a-real-local-clone-path-for-va-jobs-platform';

  IF target_id IS NULL THEN
    RAISE NOTICE 'va-jobs-platform: repository_path is not the known placeholder (already fixed, or row missing/renamed) -- nothing to reconcile.';
    RETURN;
  END IF;

  SELECT count(*) INTO candidate_count FROM projects
    WHERE github_owner = 'dutchbase' AND github_repository = 'va-jobs-platform'
      AND id != target_id
      AND repository_path IS NOT NULL
      AND btrim(repository_path) != ''
      AND repository_path NOT LIKE '/PLACEHOLDER/%';

  IF candidate_count = 1 THEN
    SELECT id, repository_path, agent_start_path INTO source_id, source_repository_path, source_agent_start_path
      FROM projects
      WHERE github_owner = 'dutchbase' AND github_repository = 'va-jobs-platform'
        AND id != target_id
        AND repository_path IS NOT NULL
        AND btrim(repository_path) != ''
        AND repository_path NOT LIKE '/PLACEHOLDER/%';

    UPDATE projects
      SET repository_path = source_repository_path,
          agent_start_path = COALESCE(agent_start_path, source_agent_start_path),
          config_version = config_version + 1,
          updated_at = now()
      WHERE id = target_id;

    RAISE NOTICE 'va-jobs-platform: copied repository_path from project % onto the va-jobs-platform project row (%).', source_id, target_id;
  ELSIF candidate_count = 0 THEN
    RAISE NOTICE 'va-jobs-platform: no other project row has a real repository_path configured for dutchbase/va-jobs-platform -- an admin must set "Local repository path" on the "VA Jobs Platform" project via the Projects page.';
  ELSE
    RAISE NOTICE 'va-jobs-platform: % candidate rows found with a real repository_path for dutchbase/va-jobs-platform -- ambiguous, left untouched. An admin must resolve which is correct via the Projects page.', candidate_count;
  END IF;
END $$;
```

- [ ] **Step 3: Write a failing test proving the migration reconciles the duplicate-row scenario**

Create `packages/database/src/va-jobs-platform-reconciliation.db.test.ts`:

```typescript
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pg from "pg";
import { migrate } from "./migrate.ts";

const testDatabaseUrl = process.env.DCC_TEST_DATABASE_URL;
const integration = testDatabaseUrl ? describe : describe.skip;
const PLACEHOLDER = "/PLACEHOLDER/set-a-real-local-clone-path-for-va-jobs-platform";
let migrationDirectory = "";

async function migrateUpTo(name: string) {
  const client = new pg.Client({ connectionString: testDatabaseUrl });
  await client.connect();
  try { await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;"); } finally { await client.end(); }
  const all = (await (await import("node:fs/promises")).readdir(migrationDirectory)).filter((f) => f.endsWith(".sql")).sort();
  const upTo = all.filter((f) => f <= name);
  const rest = all.filter((f) => f > name);
  const { rm: rmFile } = await import("node:fs/promises");
  for (const file of rest) await rmFile(join(migrationDirectory, file));
  await migrate({ connectionString: testDatabaseUrl!, directory: migrationDirectory });
  return { restore: rest };
}

integration("va-jobs-platform placeholder path reconciliation (061)", () => {
  beforeAll(async () => {
    migrationDirectory = await mkdtemp(join(tmpdir(), "dcc-va-jobs-reconcile-"));
    await cp(new URL("../migrations/", import.meta.url), migrationDirectory, { recursive: true });
  });
  afterAll(async () => { if (migrationDirectory) await rm(migrationDirectory, { recursive: true, force: true }); });

  it("copies the real path from a pre-existing duplicate project row onto the migration-seeded row", async () => {
    // Fresh copy of migrations so this test can insert a pre-existing row
    // between migration 059 (seeds the placeholder) and 061 (this plan's fix).
    const scratch = await mkdtemp(join(tmpdir(), "dcc-va-jobs-reconcile-scratch-"));
    await cp(new URL("../migrations/", import.meta.url), scratch, { recursive: true });
    const { readdir, rm: rmFile } = await import("node:fs/promises");
    const all = (await readdir(scratch)).filter((f) => f.endsWith(".sql")).sort();
    const migration061 = all.find((f) => f.startsWith("061_"))!;
    const after059 = all.filter((f) => f > "059_va_jobs_platform_project.sql" && f !== migration061);
    for (const file of after059) await rmFile(join(scratch, file));

    const client = new pg.Client({ connectionString: testDatabaseUrl });
    await client.connect();
    try {
      await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    } finally { await client.end(); }

    // Migrate through 059 (seeds the placeholder row), then hand-insert the
    // pre-existing "Jobs-platform" row with a real path, then run 061.
    const beforeDuplicate = new pg.Client({ connectionString: testDatabaseUrl });
    await beforeDuplicate.connect();
    await beforeDuplicate.end();
    await migrate({ connectionString: testDatabaseUrl!, directory: scratch });

    const client2 = new pg.Client({ connectionString: testDatabaseUrl });
    await client2.connect();
    try {
      await client2.query(
        `INSERT INTO projects (slug, name, github_owner, github_repository, default_branch, repository_path)
         VALUES ('jobs-platform', 'Jobs-platform', 'dutchbase', 'va-jobs-platform', 'master', '/home/deploy/projects/va-jobs-platform')`,
      );
    } finally { await client2.end(); }

    // Now copy in migration 061 and re-run.
    await cp(join(migrationDirectory, migration061), join(scratch, migration061));
    await migrate({ connectionString: testDatabaseUrl!, directory: scratch });

    const check = new pg.Client({ connectionString: testDatabaseUrl });
    await check.connect();
    try {
      const rows = (await check.query(
        "SELECT slug, repository_path FROM projects WHERE github_owner='dutchbase' AND github_repository='va-jobs-platform' ORDER BY slug",
      )).rows;
      expect(rows).toEqual([
        { slug: "jobs-platform", repository_path: "/home/deploy/projects/va-jobs-platform" },
        { slug: "va-jobs-platform", repository_path: "/home/deploy/projects/va-jobs-platform" },
      ]);
    } finally { await check.end(); }
    await rm(scratch, { recursive: true, force: true });
  });

  it("is a no-op when the va-jobs-platform row already has a real path", async () => {
    await migrateUpTo("999_never_matches.sql"); // runs every migration, including 061, once
    const client = new pg.Client({ connectionString: testDatabaseUrl });
    await client.connect();
    try {
      await client.query("UPDATE projects SET repository_path='/already/real/path' WHERE slug='va-jobs-platform'");
      // Re-running migrate() is a no-op (schema_migrations already records 061 as applied) --
      // this assertion instead directly re-runs the migration body to prove idempotency.
      const migrationSql = await (await import("node:fs/promises")).readFile(
        join(migrationDirectory, (await (await import("node:fs/promises")).readdir(migrationDirectory)).find((f) => f.startsWith("061_"))!),
        "utf8",
      );
      await client.query(migrationSql);
      const row = (await client.query("SELECT repository_path FROM projects WHERE slug='va-jobs-platform'")).rows[0];
      expect(row.repository_path).toBe("/already/real/path");
    } finally { await client.end(); }
  });

  it("leaves the placeholder in place and does not throw when no other candidate row exists", async () => {
    const client = new pg.Client({ connectionString: testDatabaseUrl });
    await client.connect();
    try {
      await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    } finally { await client.end(); }
    await migrate({ connectionString: testDatabaseUrl!, directory: migrationDirectory });
    const check = new pg.Client({ connectionString: testDatabaseUrl });
    await check.connect();
    try {
      const row = (await check.query("SELECT repository_path FROM projects WHERE slug='va-jobs-platform'")).rows[0];
      expect(row.repository_path).toBe(PLACEHOLDER);
    } finally { await check.end(); }
  });
});
```

- [ ] **Step 4: Run the test to verify it fails (RED) before the migration file exists, then passes (GREEN) after**

```bash
docker run --rm -d --name dcc-plan11-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=dcc_plan11 -p 55437:5432 postgres:16
sleep 3
DCC_TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:55437/dcc_plan11" pnpm exec vitest run --no-file-parallelism packages/database/src/va-jobs-platform-reconciliation.db.test.ts
docker rm -f dcc-plan11-pg
```

Before Step 2's file exists: FAIL (`migration061` lookup returns `undefined`, or the final placeholder-row assertions never change). After Step 2: all 3 tests PASS.

- [ ] **Step 5: Apply the migration to the live environment(s)**

Run the standard migration command for this repo against every real environment (dev/staging/production) that has a `va-jobs-platform` project row — do not skip this; unlike a code deploy, a data migration only takes effect once actually run against that environment's database. Confirm via the Step 1 query (re-run it) that `slug='va-jobs-platform'` now shows a real path (outcome (b) reconciled) or report explicitly to the user which of outcomes (a)/(c) applied and what manual action (if any) remains.

- [ ] **Step 6: Wire the new test file into CI — it will never run otherwise**

`.github/workflows/ci.yml`'s "Deployment database tests" step (the only CI step that sets `DCC_TEST_DATABASE_URL` against a real Postgres) hardcodes an explicit file allowlist — `pnpm verify` alone (CI's main step) skips every `*.db.test.ts` file unconditionally, since it never sets `DCC_TEST_DATABASE_URL`. This is the exact same gap plan 10 (in this same plan set) found and fixed for `ai-accounting.db.test.ts`/`ai-usage.db.test.ts` — without this step, `va-jobs-platform-reconciliation.db.test.ts` would be added to the repo but silently never executed by CI, same as those two files were.

Re-read `.github/workflows/ci.yml` fresh first (line numbers may have shifted if plan 10 already merged and added its own files to this line):

```bash
grep -n "Deployment database tests" -A 3 .github/workflows/ci.yml
```

Add `packages/database/src/va-jobs-platform-reconciliation.db.test.ts` to that step's file list, alongside whatever plan 10 already added (or the original 3-file list if plan 10 hasn't merged yet — either way, add this one file to whatever the current list is):

```yaml
      - name: Deployment database tests
        run: pnpm exec vitest run --no-file-parallelism --testTimeout=15000 scripts/webhook-deployments.test.ts packages/database/src/migrate.test.ts packages/domain/src/notifications.db.test.ts packages/database/src/va-jobs-platform-reconciliation.db.test.ts
        env:
          DCC_TEST_DATABASE_URL: postgresql://postgres:postgres@127.0.0.1:5432/dcc_test
```

(If plan 10 already merged and added its own files to this same line, merge this addition onto that list rather than reverting plan 10's entries — do not remove any file another plan already added.)

- [ ] **Step 7: Commit**

```bash
git add packages/database/migrations/061_va_jobs_platform_placeholder_path_reconciliation.sql packages/database/src/va-jobs-platform-reconciliation.db.test.ts .github/workflows/ci.yml
git commit -m "fix: reconcile va-jobs-platform's placeholder repository_path

Migration 059 seeded a project row for slug='va-jobs-platform' with a
placeholder repository_path and deliberately never overwrites it on
conflict. The Production tab and the production-promotion allowlist
both resolve this feature by that exact slug -- so a pre-existing,
differently-slugged project row for the same GitHub repository with a
real, already-configured path never reached the row this feature
actually reads. This migration copies a real path over, but only when
exactly one unambiguous candidate exists; ambiguous or absent cases
are logged and left for manual resolution, never guessed. Also wires
the new reconciliation test into CI's real-Postgres test step, which
otherwise silently never runs *.db.test.ts files (same gap plan 10
found and fixed for two other files)."
```

---

## Task 2: Reject placeholder/empty repository paths before any `realpath()`/`stat()` call

**Files:**
- Modify: `packages/project-config/src/index.ts`
- Modify: `packages/git-runner/package.json`
- Modify: `packages/git-runner/src/index.ts:843-855`
- Test: `packages/project-config/src/index.test.ts` (existing file — add cases)
- Test: `packages/git-runner/src/index.test.ts` (existing file — add cases)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `isPlaceholderRepositoryPath(path: string | null | undefined): boolean`, exported from `packages/project-config/src/index.ts` — consumed by `packages/git-runner/src/index.ts` (this task) and available for Task 3's route-level check.
- Produces: `validateProject()`'s `ValidateProjectResult` union gains one new member shape (`errorCode: "placeholder_path"` and `errorCode: "path_not_configured"`), consumed by the existing `project-validate-job.ts` wiring unchanged (no code change needed there — it already forwards whatever `errorCode`/`message` it receives).

- [ ] **Step 1: Write the failing tests for the new predicate and `validateProject` behavior**

In `packages/project-config/src/index.test.ts`, add (following the existing file's `describe`/`it` conventions — read the file first to match its exact import style and test grouping before inserting):

```typescript
import { isPlaceholderRepositoryPath, validateProject } from "./index.ts";

describe("isPlaceholderRepositoryPath", () => {
  it("flags the known va-jobs-platform seed placeholder", () => {
    expect(isPlaceholderRepositoryPath("/PLACEHOLDER/set-a-real-local-clone-path-for-va-jobs-platform")).toBe(true);
  });
  it("flags any /PLACEHOLDER/ prefixed path, case-insensitively", () => {
    expect(isPlaceholderRepositoryPath("/placeholder/anything-else")).toBe(true);
    expect(isPlaceholderRepositoryPath("/PLACEHOLDER/anything-else")).toBe(true);
  });
  it("flags empty, whitespace-only, and nullish paths", () => {
    expect(isPlaceholderRepositoryPath("")).toBe(true);
    expect(isPlaceholderRepositoryPath("   ")).toBe(true);
    expect(isPlaceholderRepositoryPath(null)).toBe(true);
    expect(isPlaceholderRepositoryPath(undefined)).toBe(true);
  });
  it("does not flag a real absolute path", () => {
    expect(isPlaceholderRepositoryPath("/home/deploy/projects/va-jobs-platform")).toBe(false);
  });
});

describe("validateProject placeholder rejection", () => {
  it("returns errorCode placeholder_path without ever calling stat/realpath on a placeholder path", async () => {
    const result = await validateProject({ repositoryPath: "/PLACEHOLDER/set-a-real-local-clone-path-for-va-jobs-platform", defaultBranch: "master" });
    expect(result).toEqual({ ok: false, errorCode: "placeholder_path", message: "repository path is a placeholder and has not been configured" });
  });
  it("returns errorCode path_not_configured for an empty repositoryPath", async () => {
    const result = await validateProject({ repositoryPath: "", defaultBranch: "master" });
    expect(result).toEqual({ ok: false, errorCode: "path_not_configured", message: "repository path is not configured" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm exec vitest run packages/project-config/src/index.test.ts
```

Expected: FAIL — `isPlaceholderRepositoryPath` is not exported; `validateProject` does not yet short-circuit (it would instead attempt `stat("/PLACEHOLDER/...")` and return `errorCode: "path_missing"`, not `"placeholder_path"`).

- [ ] **Step 3: Implement the predicate and wire it into `validateProject`**

In `packages/project-config/src/index.ts`, add the exported predicate near the top (after the existing imports, before `loadProjectConfig`):

```typescript
// Placeholder paths are seeded by migrations for projects that need admin
// configuration before local-clone-dependent features (pre-flight, planning,
// execution) can run -- see packages/database/migrations/059_va_jobs_platform_project.sql.
// Treat one as invalid configuration, not as a real (if broken) filesystem
// path, so callers never attempt stat()/realpath() against it.
export function isPlaceholderRepositoryPath(path: string | null | undefined): boolean {
  if (path === null || path === undefined) return true;
  const trimmed = path.trim();
  if (!trimmed) return true;
  return /^\/placeholder\//i.test(trimmed);
}
```

Extend `InspectionErrorCode` (currently `"path_missing" | "not_a_repo" | "permission_denied" | "git_unavailable" | "timeout" | "unknown"`, line 114) to add the two new codes:

```typescript
export type InspectionErrorCode = "path_missing" | "not_a_repo" | "permission_denied" | "git_unavailable" | "timeout" | "unknown" | "placeholder_path" | "path_not_configured";
```

Then in `validateProject` (line 139), add the check as the very first thing in the function body, before the existing `errors.push(...await validateAgentStartPath(input.agentStartPath));` line:

```typescript
export async function validateProject(input: ProjectValidationInput): Promise<ValidateProjectResult> {
  const trimmedPath = input.repositoryPath?.trim() ?? "";
  if (!trimmedPath) return { ok: false, errorCode: "path_not_configured", message: "repository path is not configured" };
  if (isPlaceholderRepositoryPath(trimmedPath)) return { ok: false, errorCode: "placeholder_path", message: "repository path is a placeholder and has not been configured" };

  const errors: string[] = [];
  errors.push(...await validateAgentStartPath(input.agentStartPath));
  // ... rest of the function unchanged (the existing `try { stat(...) } ...` block and below)
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm exec vitest run packages/project-config/src/index.test.ts
```

Expected: PASS.

- [ ] **Step 5: Wire the same check into `previewRemoteBranchMerge` — the exact function that throws the reported error**

Add `@dcc/project-config` as a dependency of `packages/git-runner/package.json` (check the file's current shape first — if it has no `"dependencies"` key at all today, add one):

```json
{
  "name": "@dcc/git-runner",
  "private": true,
  "type": "module",
  "exports": "./src/index.ts",
  "dependencies": {
    "@dcc/project-config": "workspace:*"
  }
}
```

(Merge this into whatever the file's existing keys are — do not remove any existing dependency entries.)

In `packages/git-runner/src/index.ts`, add the import near the top with the other imports, and update `previewRemoteBranchMerge` (currently starting at line 847):

```typescript
import { isPlaceholderRepositoryPath } from "@dcc/project-config";
```

```typescript
export async function previewRemoteBranchMerge(input: {
  repositoryPath: string;
  head?: string;
  base?: string;
}): Promise<BranchMergePreview> {
  if (isPlaceholderRepositoryPath(input.repositoryPath)) {
    throw new Error("Project local repository path is not configured correctly. Set a real local clone path for this project on the Projects page before running merge pre-flight.");
  }
  const repository = await realpath(input.repositoryPath);
  if (input.head !== undefined) await assertRemoteBranchName(input.head);
  if (input.base !== undefined) await assertRemoteBranchName(input.base);
  // ... rest unchanged
```

- [ ] **Step 6: Write the failing test for `previewRemoteBranchMerge`'s new guard, then verify it passes**

In `packages/git-runner/src/index.test.ts`, add (matching the existing file's test setup/mocking conventions for this function — read the file first to see how `previewRemoteBranchMerge`'s existing tests stub `exec`/`realpath`):

```typescript
it("rejects a placeholder repositoryPath with a clear configuration error, before calling realpath", async () => {
  await expect(previewRemoteBranchMerge({ repositoryPath: "/PLACEHOLDER/set-a-real-local-clone-path-for-va-jobs-platform" }))
    .rejects.toThrow(/project local repository path is not configured correctly/i);
});
```

```bash
pnpm exec vitest run packages/git-runner/src/index.test.ts
```

Expected: FAIL before Step 5's change (the real `realpath()` call would throw the raw `ENOENT` message instead, or — if the test's existing mocking stubs `realpath` unconditionally to succeed — the test would fail because no error is thrown at all), PASS after.

- [ ] **Step 7: Commit**

```bash
git add packages/project-config/src/index.ts packages/project-config/src/index.test.ts packages/git-runner/package.json packages/git-runner/src/index.ts packages/git-runner/src/index.test.ts
git commit -m "fix: reject placeholder/empty repository paths before realpath/stat

validateProject() and previewRemoteBranchMerge() both now check for a
known-placeholder or empty repositoryPath before touching the
filesystem, returning/throwing a clear configuration error instead of
letting a raw ENOENT/realpath error surface as the pre-flight failure
message. This fixes the reported failure class regardless of which
project row ends up holding a placeholder in the future."
```

---

## Task 3: Reject a placeholder path at merge-preview enqueue time (fail before the job even starts)

**Files:**
- Modify: `apps/web/src/server.ts:1359-1371`
- Test: `apps/web/src/merge-route-regressions.test.ts` (existing file — add a case)

**Interfaces:**
- Consumes: `isPlaceholderRepositoryPath` from `@dcc/project-config` (Task 2).
- Produces: nothing consumed elsewhere — this is the outermost, earliest possible check in the pre-flight request path, on top of Task 2's job-level guard (defense in depth: a 400 at request time is a better UX than waiting for an async job to fail, per the ticket's "only then start Git operations" requirement).

- [ ] **Step 1: Write the failing test**

`apps/web/src/merge-route-regressions.test.ts` currently has no coverage at all for the `/merge-preview` route (only `/merge-branches` and `/jobs/:id`) — this step adds the first test for it, following the file's exact existing conventions verbatim (its `request()`/`newResponse()` helpers, its `pool.query.mockImplementation` pattern keyed on SQL substring, and its `pool.query.mock.calls.some(([sql]) => sql.includes(...))` style for asserting whether a job was enqueued). Add this test at the end of the file, after the existing `"jobs status endpoint rejects malformed ids..."` test:

```typescript
test("merge-preview returns 400 with a clear message for a placeholder repository_path, without enqueuing a job", async () => {
  pool.query.mockImplementation(async (sql: string) =>
    sql.includes("FROM projects")
      ? { rows: [{ id: projectId, name: "VA Jobs Platform", github_owner: "dutchbase", github_repository: "va-jobs-platform", default_branch: "master", repository_path: "/PLACEHOLDER/set-a-real-local-clone-path-for-va-jobs-platform" }] }
      : { rows: [] });
  const response = newResponse();

  await adminApi(request({}), response, new URL(`http://test/api/admin/projects/${projectId}/merge-preview`), { user_id: "admin" });

  expect(response.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
  const body = JSON.parse(String(response.end.mock.calls[0][0]));
  expect(body.error).toMatch(/local repository path is not configured correctly/i);
  expect(pool.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO jobs"))).toBe(false);
});

test("merge-preview still enqueues a job for a project with a real repository_path (no regression)", async () => {
  pool.query.mockImplementation(async (sql: string) =>
    sql.includes("FROM projects")
      ? { rows: [{ id: projectId, name: "Widgets", github_owner: "acme", github_repository: "widgets", default_branch: "main", repository_path: "/home/deploy/projects/widgets" }] }
      : { rows: [] });
  const response = newResponse();

  await adminApi(request({}), response, new URL(`http://test/api/admin/projects/${projectId}/merge-preview`), { user_id: "admin" });

  expect(response.writeHead).toHaveBeenCalledWith(202, expect.any(Object));
  expect(pool.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO jobs"))).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm exec vitest run apps/web/src/merge-route-regressions.test.ts
```

Expected: the first new test FAILs — today this request would 202 and enqueue a `github.merge_preview` job (which would then fail asynchronously per Task 2's now-fixed job-level error) instead of returning 400. The second new test should already PASS (it documents current correct behavior for a real path) — it stays green throughout this task, proving Step 3 below is a no-op for valid paths.

- [ ] **Step 3: Add the check to the route**

In `apps/web/src/server.ts`, update the `mergePreviewMatch` handler (currently lines 1359-1371):

```typescript
  const mergePreviewMatch = url.pathname.match(/^\/api\/admin\/projects\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/merge-preview$/i);
  if (mergePreviewMatch && request.method === "POST") {
    const project = (await pool.query("SELECT * FROM projects WHERE id=$1", [mergePreviewMatch[1]])).rows[0];
    if (!project) return json(response, 404, { error: "project not found" });
    if (!project.repository_path) return json(response, 400, { error: "project has no local repository configured" });
    if (isPlaceholderRepositoryPath(project.repository_path)) {
      return json(response, 400, { error: `${project.name} repository path is not configured correctly: set a real local clone path on the Projects page before running merge pre-flight.` });
    }
    const body = await bodyOf(request);
    // ... rest unchanged
```

Add the import alongside `server.ts`'s existing `@dcc/project-config` import (it already imports `validateAgentStartPath`/`validateDeploymentConfig` from that package per the investigation — add `isPlaceholderRepositoryPath` to that same import line rather than a new one).

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm exec vitest run apps/web/src/merge-route-regressions.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/server.ts apps/web/src/merge-route-regressions.test.ts
git commit -m "fix: reject placeholder repository_path at merge-preview request time

Gives an immediate 400 with a clear, project-named message instead of
enqueuing a github.merge_preview job that would only fail
asynchronously (Task 2's job-level guard remains as defense in
depth for any other caller of previewRemoteBranchMerge)."
```

---

## Task 4: Regression coverage — other projects unaffected, path changes picked up live, no fallback ever occurs

**Files:**
- Test: `packages/project-config/src/index.test.ts` (existing file — add cases, extends Task 2's additions)
- Test: `apps/worker/src/provider-jobs.test.ts` (existing file — add a case for the `github.merge_preview` job handler)

**Interfaces:**
- Consumes: `isPlaceholderRepositoryPath`, `validateProject` (Task 2).
- Produces: nothing consumed elsewhere — terminal regression-coverage task for this plan.

- [ ] **Step 1: Write the failing tests**

In `packages/project-config/src/index.test.ts`, add:

```typescript
describe("validateProject real-path regression (no false positives)", () => {
  it("does not flag a real, existing directory as a placeholder", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const exec = promisify(execFile);
    const dir = await mkdtemp(join(tmpdir(), "dcc-real-repo-"));
    try {
      await exec("git", ["-C", dir, "init", "-q"]);
      await exec("git", ["-C", dir, "commit", "--allow-empty", "-q", "-m", "init"]);
      await exec("git", ["-C", dir, "branch", "-m", "master"]);
      const result = await validateProject({ repositoryPath: dir, defaultBranch: "master", requireRemote: false });
      expect(result.ok).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("path changes are picked up on the next call -- no caching inside validateProject", async () => {
    const first = await validateProject({ repositoryPath: "/PLACEHOLDER/anything", defaultBranch: "master" });
    expect(first).toMatchObject({ ok: false, errorCode: "placeholder_path" });
    const second = await validateProject({ repositoryPath: "/definitely/does/not/exist/on/this/machine", defaultBranch: "master" });
    expect(second).toMatchObject({ ok: false, errorCode: "path_missing" });
  });
});
```

`apps/worker/src/provider-jobs.test.ts` mocks `previewRemoteBranchMerge` itself (`const previewRemoteBranchMerge = vi.fn();` at line 33, wired via `vi.mock` for `@dcc/git-runner`) — so Task 2's real placeholder guard inside `previewRemoteBranchMerge` can never execute through this file (that guard is already directly tested in `packages/git-runner/src/index.test.ts` by Task 2 Step 6). What's worth confirming at *this* layer is narrower and just as important: that `runProviderJob`'s `github.merge_preview` branch propagates a rejection from `previewRemoteBranchMerge` verbatim, rather than swallowing it or wrapping it in a less useful message — i.e. the worker layer doesn't undo Task 2's clear error on its way to `failJob`. Add this case following the exact `db(...)` fixture helper and job-shape already used by the existing `"merge_preview persists a read-only preview into result_json"` test at line 203:

```typescript
test("merge_preview propagates a placeholder-path configuration error unchanged", async () => {
  const database = db([{ id: "proj-1", repository_path: "/PLACEHOLDER/set-a-real-local-clone-path-for-va-jobs-platform", github_owner: "dutchbase", github_repository: "va-jobs-platform" }]);
  previewRemoteBranchMerge.mockRejectedValueOnce(new Error("Project local repository path is not configured correctly. Set a real local clone path for this project on the Projects page before running merge pre-flight."));

  await expect(runProviderJob({
    id: "job-10", type: "github.merge_preview",
    idempotency_key: "g07:github.merge_preview:two", payload_json: { actor_id: "admin-1", project_id: "proj-1" },
  }, database as any)).rejects.toThrow(/local repository path is not configured correctly/i);

  expect(previewRemoteBranchMerge).toHaveBeenCalledWith({ repositoryPath: "/PLACEHOLDER/set-a-real-local-clone-path-for-va-jobs-platform", head: undefined, base: undefined });
  const resultUpdate = database.queries.find((q) => q.text.includes("result_json"));
  expect(resultUpdate).toBeUndefined();
});
```

The existing `"merge_preview persists a read-only preview into result_json"` test (line 203, unmodified by this plan) already proves a project with a real `repository_path` is unaffected — no new "no regression" test is needed alongside it.

- [ ] **Step 2: Run tests to verify they fail, then pass**

```bash
pnpm exec vitest run packages/project-config/src/index.test.ts apps/worker/src/provider-jobs.test.ts
```

Expected: the `project-config` tests FAIL before Task 2's `validateProject` change is present (same as Task 2 Step 2), then PASS. The `provider-jobs.test.ts` addition doesn't depend on Task 2's code (it mocks `previewRemoteBranchMerge` directly) so it passes as soon as it's written — it exists to lock in current+future behavior (the worker layer must never re-wrap or swallow this error), not to prove Task 2's fix by itself.

- [ ] **Step 3: Run each existing project's full test suite once to confirm no regression in currently-passing projects**

```bash
pnpm exec vitest run apps/worker/src/provider-jobs.test.ts packages/project-config/src/index.test.ts packages/git-runner/src/index.test.ts apps/web/src/merge-route-regressions.test.ts
```

Expected: PASS, including every pre-existing test in these files (not just the new ones) — confirms Tasks 2-3's guard is a true no-op for real, valid paths.

- [ ] **Step 4: Commit**

```bash
git add packages/project-config/src/index.test.ts apps/worker/src/provider-jobs.test.ts
git commit -m "test: regression coverage for placeholder-path rejection

Confirms a real repository path is never misclassified as a
placeholder, that validateProject reads fresh on every call (no
caching to go stale when a project's path is edited), that
github.merge_preview surfaces a clear configuration error instead of
a raw realpath ENOENT for a placeholder path, and that a project with
a real, valid path is completely unaffected by the new guard."
```

---

## Self-Review Notes

- **Spec coverage:** "reproduce specifically with dutchbase/va-jobs-platform" and "confirm the actual configured local path is correct" → Task 1 Step 1 (live verification, branches on the actual data state rather than assuming). "trace where pre-flight obtains its path" / "identify why it resolves the placeholder" → fully documented in this plan's Investigation section with file:line citations for every hop, Projects page vs. pre-flight compared directly. "search for PLACEHOLDER string" → done (single migration + single test-fixture mock, both cited). "determine authoritative source" → DB `projects.repository_path`, confirmed the sole live source (`projects.yaml`/`loadProjectConfig` proven dead code). "remove/neutralize stale placeholder configuration" → Task 1's migration. "path resolution should continue to work if the configured local path changes later" → Task 4's dedicated no-caching regression test. "treat placeholder paths as invalid configuration, don't realpath+ENOENT" → Task 2 (both `validateProject` and `previewRemoteBranchMerge`) and Task 3 (request-time short-circuit). "Projects page and pre-flight read from the same source" → confirmed already true by investigation, documented rather than "fixed" (nothing to fix). "specific errors for missing/placeholder/non-existent/non-directory/non-repo/permission paths" → `path_not_configured`/`placeholder_path` are new; `path_missing`/`not_a_repo`/`permission_denied`/`git_unavailable` already existed and are unchanged/unregressed (Task 4 Step 3 confirms). "other configured projects continue to work" → Task 4 Step 3. "no code path falls back to /PLACEHOLDER/... when valid config exists" → Task 2/3's guards make this structurally impossible going forward (they reject before any git/filesystem operation, they don't silently substitute a fallback).
- **Deliberately out of scope, flagged as follow-ups (do not implement in this plan):** (1) adding a `UNIQUE (github_owner, github_repository)` constraint on `projects` — would prevent this exact class of duplicate-row bug at the schema level, but is a behavior change with unclear blast radius on any legitimate multi-row setups that might exist today; needs its own ticket with a proper audit of current data first. (2) A UI warning on the Projects page when two rows share the same `github_owner`/`github_repository` — would have caught this bug at creation time; reasonable follow-up, out of scope for "fix the placeholder path" specifically. (3) Renaming/deleting whichever duplicate row survives after Task 1's reconciliation — left as a manual decision, reported to the user per this plan's Task 1 Step 5 note, not automated.
- **Placeholder scan:** no "TBD"/"handle appropriately" language. Tasks 3-4's test additions were re-verified against the actual current contents of `apps/web/src/merge-route-regressions.test.ts` and `apps/worker/src/provider-jobs.test.ts` (both read in full during planning) and use their real, existing helper names (`request`/`newResponse`/`pool.query.mockImplementation` from the former; `db(...)`/`previewRemoteBranchMerge`/`runProviderJob` from the latter) rather than invented placeholder names.
- **Type consistency:** `isPlaceholderRepositoryPath(path: string | null | undefined): boolean` used identically in `packages/project-config/src/index.ts` (Task 2), `packages/git-runner/src/index.ts` (Task 2), and `apps/web/src/server.ts` (Task 3). `ValidateProjectResult`'s `errorCode` values (`"placeholder_path"`, `"path_not_configured"`) match between the `InspectionErrorCode` type extension and every test's `toMatchObject`/`toEqual` assertion.
