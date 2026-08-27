# Actionable `repository_dirty` Diagnostics — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `repository_dirty` project status on the Projects page actionable: show which files are modified/staged/untracked/deleted/conflicted, why it blocks Dev Control operations, how to resolve it, and a working `Recheck repository` action — all without requiring server SSH access.

**Architecture:** The health check already runs `git status --porcelain` server-side (`packages/project-config/src/index.ts:55-83`, `validateProject()`) and returns a `changedFiles` array, but the caller (`apps/worker/src/worker.ts:1878-1888`, the `project.validate` job handler) throws that array away, collapsing it to just `healthy`/`repository_dirty`/`invalid` written to `projects.health_status`. Nothing persists the actual file list. A pre-existing, separate bug compounds this: the dirty banner on the Projects page (`apps/web/src/pages/projects.ts:159`) reads `project.config_json.uncommitted_count`, a field nothing in the codebase ever writes — so it always shows the hardcoded fallback "3" regardless of the real count. This plan: (1) makes `validateProject()` categorize `git status --porcelain` output into modified/staged/untracked/deleted/renamed/conflicted groups instead of one flat list; (2) persists that categorized detail to a new `health_detail_json` column on `projects`, written by the same worker job that already runs the check; (3) adds a diagnostics view (expandable row or dialog, matching the existing `<dialog>` pattern already used elsewhere on this page) that reads and renders it, with resolution guidance and a live-wired `Recheck repository` button reusing the existing "Refresh" no-reload pattern from the Deployment tab.

**Tech Stack:** TypeScript, `execFile` (Node `child_process`, already used), Postgres `jsonb` column, Vitest.

**Spec:** "Add actionable diagnostics for `repository_dirty` project status" task in the dev-control task list (see `plans/INDEX.md`).

## Global Constraints

- Diagnostic-only for the first implementation is explicitly acceptable per the task spec — do not implement `git reset --hard`/`git clean` or any other destructive action. A `Stash changes` action is optional and, if added, must require explicit confirmation and never run silently.
- Server-side only: repository inspection runs on the existing worker process against `project.repository_path`, which is already sourced exclusively from the DB row (never from client input) — preserve that invariant; do not add any route that accepts a path from the browser.
- Never expose file *contents* — file names and status/type only.
- Escape all file paths and git output before rendering (this app already uses `escapeHtml` universally — follow that convention).
- Distinguish "repository inspection failed" (missing path, not a git repo, permission denied, git binary unavailable, timeout) from `repository_dirty` — these must never be reported as the dirty status.
- Fix the pre-existing `uncommitted_count` bug as part of this work (it's the same code path and the task explicitly calls for an accurate count).

---

## File Structure

- **Modify** `packages/project-config/src/index.ts:55-83` (`validateProject`) — categorize `git status --porcelain` output instead of returning a flat `changedFiles` array; add explicit distinct error results for missing-path/not-a-repo/permission-denied/timeout instead of letting `execFile` throw generically.
- **Create** `packages/database/migrations/059_project_health_detail.sql` — adds `projects.health_detail_json jsonb` and `projects.health_error text`.
- **Modify** `apps/worker/src/worker.ts:1859-1888` (`project.validate` job handler) — persist the categorized detail and, on inspection failure, a distinct `invalid`-with-`health_error` state instead of folding failures into `repository_dirty`.
- **Modify** `apps/web/src/pages/projects.ts` — replace the static/inert "Last validation" panel (~lines 141-144) and the broken `uncommitted_count` banner (~line 159) with real diagnostics rendering; add a diagnostics dialog/expandable section.
- **Modify** `apps/web/src/ui.ts` — wire the `Recheck repository` action (reusing the existing no-reload "Refresh" pattern from the deployment panel, `ui.ts:500` per prior investigation) instead of the current blind-2s-reload `Run validation` button behavior.
- **Modify** `apps/web/src/server.ts` — no new route required (`POST /api/admin/projects/:id/validate` already exists and already enqueues `project.validate`); confirm the existing GET project route returns the new `health_detail_json`/`health_error` fields to the page.
- **Create** `packages/project-config/src/index.test.ts` additions (existing file — extend) for the categorization logic.
- **Create** `apps/worker/src/project-validate-job.test.ts` (new, or extend an existing worker test file if one already covers `project.validate` — check first) for the persistence behavior.

---

### Task 1: Categorize `git status --porcelain` output in `validateProject`

**Files:**
- Modify: `packages/project-config/src/index.ts:55-83`
- Test: `packages/project-config/src/index.test.ts` (existing file, currently only covers `agent_start_path` per prior investigation — add a new `describe` block)

**Interfaces:**
- Produces: `validateProject` return type gains a `changedFileDetail` field: `Array<{ path: string; status: "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflicted"; staged: boolean }>`, alongside the existing `changedFiles: string[]` (kept for backward compatibility with any other current consumer — grep for other callers before removing it). Consumed by Task 3 (worker persistence).

- [ ] **Step 1: Read the current implementation in full**

Read `packages/project-config/src/index.ts:1-90` completely (the file is short per prior investigation — under 90 lines). Confirm the exact current git commands (lines 62-68: `rev-parse --git-dir`, `show-ref --verify`, `status --porcelain`, `remote`) and how `changedFiles` is currently derived from `status --porcelain` stdout (line 64-65, stripping the 3-char porcelain prefix).

- [ ] **Step 2: Write the failing tests**

```typescript
// packages/project-config/src/index.test.ts (add a new describe block)
import { describe, expect, test, vi } from "vitest";
import { validateProject } from "./index.ts";

// Follow this file's existing pattern for stubbing execFile/child_process —
// read the top of this file's existing "planning agent start path" tests
// (per prior investigation, this file currently only tests agent_start_path;
// confirm whether execFile is already mockable here, or whether these new
// tests need to shell out to a real temp git repo instead — prefer a real
// temp repo via `git init` in a tmp dir if no execFile-mocking convention
// already exists in this package, since that's more faithful to real porcelain
// output parsing and avoids inventing a mock format that might not match
// real git output).

describe("git status categorization", () => {
  test("modified tracked file is categorized as modified, unstaged", async () => {
    // Arrange: temp repo, commit a file, modify it without staging.
    const result = await validateProject({ repository_path: /* tmp repo path */ "", default_branch: "main" });
    expect(result.changedFileDetail).toContainEqual({ path: "file.txt", status: "modified", staged: false });
  });

  test("staged modification is categorized as modified, staged", async () => {
    // Arrange: temp repo, commit a file, modify and `git add` it.
    const result = await validateProject({ repository_path: "", default_branch: "main" });
    expect(result.changedFileDetail).toContainEqual({ path: "file.txt", status: "modified", staged: true });
  });

  test("untracked file is categorized as untracked", async () => {
    const result = await validateProject({ repository_path: "", default_branch: "main" });
    expect(result.changedFileDetail).toContainEqual({ path: "new-file.txt", status: "untracked", staged: false });
  });

  test("deleted tracked file is categorized as deleted", async () => {
    const result = await validateProject({ repository_path: "", default_branch: "main" });
    expect(result.changedFileDetail).toContainEqual({ path: "gone.txt", status: "deleted", staged: false });
  });

  test("renamed staged file is categorized as renamed", async () => {
    const result = await validateProject({ repository_path: "", default_branch: "main" });
    expect(result.changedFileDetail).toContainEqual({ path: "renamed-to.txt", status: "renamed", staged: true });
  });

  test("unresolved merge conflict is categorized as conflicted, distinct from ordinary modifications", async () => {
    // Arrange: temp repo with two divergent branches merged to produce a
    // porcelain 'UU' (both modified/unmerged) status line.
    const result = await validateProject({ repository_path: "", default_branch: "main" });
    expect(result.changedFileDetail).toContainEqual({ path: "conflict.txt", status: "conflicted", staged: false });
  });

  test("multiple dirty-state types in one repo are all grouped correctly", async () => {
    // Arrange: one modified, one untracked, one staged-added file simultaneously.
    const result = await validateProject({ repository_path: "", default_branch: "main" });
    const statuses = result.changedFileDetail.map((entry) => entry.status).sort();
    expect(statuses).toEqual(["added", "modified", "untracked"].sort());
  });

  test("clean repository returns an empty changedFileDetail and valid:true", async () => {
    const result = await validateProject({ repository_path: "", default_branch: "main" });
    expect(result.changedFileDetail).toEqual([]);
    expect(result.valid).toBe(true);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm test:unit -- packages/project-config/src/index`
Expected: FAIL — `changedFileDetail` doesn't exist yet.

- [ ] **Step 4: Implement the categorization**

Git porcelain v1 format (the existing command has no `--porcelain=v2` flag, per the current implementation — keep v1 for minimal diff, since v2 would change the parsing entirely): each line is `XY PATH` (or `XY PATH -> NEWPATH` for renames), where `X` is the staged/index status and `Y` is the unstaged/worktree status. Add a categorization function:

```typescript
// packages/project-config/src/index.ts
type ChangedFileDetail = { path: string; status: "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflicted"; staged: boolean };

function categorizePorcelainLine(line: string): ChangedFileDetail | null {
  if (line.length < 4) return null;
  const indexStatus = line[0];
  const worktreeStatus = line[1];
  const rest = line.slice(3);
  const path = rest.includes(" -> ") ? rest.split(" -> ")[1] : rest;
  const conflictCodes = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);
  const code = `${indexStatus}${worktreeStatus}`;
  if (conflictCodes.has(code)) return { path, status: "conflicted", staged: false };
  if (indexStatus === "?" && worktreeStatus === "?") return { path, status: "untracked", staged: false };
  if (indexStatus === "R") return { path, status: "renamed", staged: true };
  if (indexStatus === "A") return { path, status: "added", staged: true };
  if (indexStatus === "D") return { path, status: "deleted", staged: true };
  if (indexStatus === "M") return { path, status: "modified", staged: true };
  if (worktreeStatus === "D") return { path, status: "deleted", staged: false };
  if (worktreeStatus === "M") return { path, status: "modified", staged: false };
  return { path, status: "modified", staged: false };
}
```

In `validateProject`, after the existing `git status --porcelain` call (line 64), add:

```typescript
const changedFileDetail = statusOutput.split("\n").filter(Boolean).map(categorizePorcelainLine).filter((entry): entry is ChangedFileDetail => entry !== null);
```

Add `changedFileDetail` to the function's return object alongside the existing `changedFiles`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test:unit -- packages/project-config/src/index`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/project-config/src/index.ts packages/project-config/src/index.test.ts
git commit -m "feat: categorize git status --porcelain output into modified/staged/untracked/deleted/renamed/conflicted"
```

---

### Task 2: Distinguish inspection failures from `repository_dirty`

**Files:**
- Modify: `packages/project-config/src/index.ts` (`validateProject`)
- Test: `packages/project-config/src/index.test.ts`

**Interfaces:**
- Produces: `validateProject` returns a discriminated result: on success, `{ ok: true, valid: boolean, changedFiles, changedFileDetail }`; on inspection failure, `{ ok: false, errorCode: "path_missing" | "not_a_repo" | "permission_denied" | "git_unavailable" | "timeout" | "unknown", message: string }`. Consumed by Task 3 (worker) to set a distinct status instead of `repository_dirty`.

- [ ] **Step 1: Write the failing tests**

```typescript
describe("inspection failure handling", () => {
  test("nonexistent repository path returns ok:false, errorCode:'path_missing', not repository_dirty", async () => {
    const result = await validateProject({ repository_path: "/nonexistent/path/xyz", default_branch: "main" });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("path_missing");
  });

  test("a directory that exists but is not a git repository returns errorCode:'not_a_repo'", async () => {
    // Arrange: a real tmp directory with no .git.
    const result = await validateProject({ repository_path: "" /* tmp non-git dir */, default_branch: "main" });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("not_a_repo");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test:unit -- packages/project-config/src/index`
Expected: FAIL — current code likely throws an unhandled exception rather than returning a typed failure (confirm exact current behavior by reading the function first).

- [ ] **Step 3: Implement**

Wrap the existing `git -C <repo> rev-parse --git-dir` call (line 62) — this is already the function's first git call and is already positioned as an implicit existence/repo check — in a `try/catch`. On failure, inspect the error: `ENOENT`/`ENOTDIR` on the path → `path_missing`; git's own "not a git repository" stderr message → `not_a_repo`; `EACCES` → `permission_denied`; `execFile` binary-not-found (`ENOENT` on the `git` command itself, distinguishable from a path-ENOENT by checking `error.path` or `error.syscall`) → `git_unavailable`; a timeout (if `execFile` is called with a `timeout` option — add one if not already present, e.g. 10000ms, to satisfy the "timeout while checking status" requirement) → `timeout`; anything else → `unknown`. Return `{ ok: false, errorCode, message: error.message }` instead of letting the exception propagate.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test:unit -- packages/project-config/src/index`
Expected: PASS

- [ ] **Step 5: Run the full package test suite for regressions**

Run: `pnpm test:unit -- packages/project-config`
Expected: PASS (existing `agent_start_path` tests still pass)

- [ ] **Step 6: Commit**

```bash
git add packages/project-config/src/index.ts packages/project-config/src/index.test.ts
git commit -m "fix: return a typed inspection failure instead of throwing or reporting repository_dirty for missing/invalid repos"
```

---

### Task 3: Migration + persist diagnostics from the worker job

**Files:**
- Create: `packages/database/migrations/059_project_health_detail.sql`
- Modify: `apps/worker/src/worker.ts:1859-1888`
- Test: create `apps/worker/src/project-validate-job.test.ts` (check first whether an existing test file already covers this job handler and extend it instead)

**Interfaces:**
- Consumes: `validateProject`'s new return shape from Tasks 1-2.
- Produces: `projects.health_detail_json` (categorized file list + summary counts) and `projects.health_error` (set only on inspection failure) — consumed by Task 4 (Projects page rendering).

- [ ] **Step 1: Write the migration**

```sql
-- packages/database/migrations/059_project_health_detail.sql
ALTER TABLE projects
  ADD COLUMN health_detail_json jsonb,
  ADD COLUMN health_error text;
```

- [ ] **Step 2: Read the current job handler**

Read `apps/worker/src/worker.ts:1859-1888` in full (the `project.validate` claim + handler) to confirm the exact current `UPDATE projects SET health_status=...` call before changing it.

- [ ] **Step 3: Write the failing test**

```typescript
// apps/worker/src/project-validate-job.test.ts
import { expect, test } from "vitest";
// Follow this file's/an existing worker test file's DB-fixture and job-runner
// conventions (seed a project row, enqueue/directly invoke the job handler,
// assert on the resulting row) — read apps/worker/src/provider-jobs.deployment.test.ts
// for the established pattern in this codebase before writing new setup code.

test("a dirty repo persists categorized file detail, not just the health_status enum", async () => {
  // Arrange: a project row pointing at a real tmp git repo with one modified
  // and one untracked file.
  // Act: run the project.validate job handler directly.
  // Assert: projects.health_status === 'repository_dirty', and
  // projects.health_detail_json contains both files with correct categories
  // and a summary shape usable by the UI (e.g. {modified:1, untracked:1, ...}
  // plus the full per-file list).
});

test("an inspection failure (missing path) sets a distinct status, not repository_dirty", async () => {
  // Arrange: a project row with repository_path pointing nowhere.
  // Act: run the job handler.
  // Assert: projects.health_status is something other than 'repository_dirty'
  // (e.g. 'invalid' — confirm this doesn't collide with the existing 'invalid'
  // meaning for a repo that exists but fails the default-branch check; add a
  // new enum value if needed, e.g. 'inspection_error', checking first whether
  // health_status has a CHECK constraint that would need updating — grep the
  // migrations for "health_status" to find it), and projects.health_error is set
  // to the errorCode from Task 2.
});

test("a repository that becomes clean after being dirty clears health_detail_json", async () => {
  // Act: run the job handler against a clean repo.
  // Assert: health_status='healthy', health_detail_json is null or empty.
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `pnpm test:unit -- project-validate-job`
Expected: FAIL

- [ ] **Step 5: Check the `health_status` CHECK constraint**

Run: `grep -rn "health_status" packages/database/migrations/*.sql` — read `001_foundation.sql:32-48`'s exact constraint (if any) on this column. If it's an unconstrained `text` column (per the prior investigation's summary, no explicit `CHECK` was mentioned), a new `inspection_error` value needs no migration change beyond documentation; if a `CHECK` constraint exists, add an `ALTER TABLE ... DROP CONSTRAINT ... ADD CONSTRAINT` to Task 3's migration to include the new value.

- [ ] **Step 6: Implement**

Replace the worker's collapsing logic (`worker.ts:1884-1887`, currently `result.valid ? "healthy" : result.changedFiles.length ? "repository_dirty" : "invalid"`):

```typescript
const result = await validateProject(project);
if (!result.ok) {
  await pool.query(
    `UPDATE projects SET health_status='inspection_error',health_error=$2,health_detail_json=NULL,last_validated_at=now(),updated_at=now() WHERE id=$1`,
    [project.id, `${result.errorCode}: ${result.message}`],
  );
  return;
}
const summary = result.changedFileDetail.reduce((acc, entry) => ({ ...acc, [entry.status]: (acc[entry.status] ?? 0) + 1 }), {} as Record<string, number>);
const healthStatus = result.valid ? "healthy" : result.changedFileDetail.length ? "repository_dirty" : "invalid";
await pool.query(
  `UPDATE projects SET health_status=$2,health_error=NULL,health_detail_json=$3::jsonb,last_validated_at=now(),updated_at=now() WHERE id=$1`,
  [project.id, healthStatus, healthStatus === "repository_dirty" ? JSON.stringify({ summary, files: result.changedFileDetail }) : null],
);
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm test:unit -- project-validate-job`
Expected: PASS

- [ ] **Step 8: Run the full worker test suite for regressions**

Run: `pnpm test:unit -- apps/worker`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add packages/database/migrations/059_project_health_detail.sql apps/worker/src/worker.ts apps/worker/src/project-validate-job.test.ts
git commit -m "feat: persist categorized dirty-file detail and distinguish inspection failures from repository_dirty"
```

---

### Task 4: Projects page diagnostics UI

**Files:**
- Modify: `apps/web/src/pages/projects.ts` (the dirty banner ~line 159, the inert "Last validation" panel ~lines 141-144, the status badge rendering)
- Test: extend whatever existing test covers `projects.ts` page rendering (check for an existing file first; if none, create `apps/web/src/project-health-detail.test.ts`)

**Interfaces:**
- Consumes: `health_detail_json`, `health_error` from Task 3.

- [ ] **Step 1: Read the current banner and validation panel**

Read `apps/web/src/pages/projects.ts` around lines 112 (`dirty` computation), 141-144 (the static "Last validation" tab), and 159 (the broken `uncommitted_count` banner) in full before editing.

- [ ] **Step 2: Write the failing tests**

```typescript
test("dirty project shows a real file count, not the hardcoded fallback of 3", () => {
  // Render the project detail page for a project with health_status='repository_dirty'
  // and health_detail_json={summary:{modified:2,untracked:1},files:[...]}.
  // Assert the banner text reflects "2 modified" and "1 untracked", NOT the literal "3".
});

test("dirty diagnostics list each changed file with its category", () => {
  const html = ""; // render, as above
  expect(html).toContain("app/routes/admin.tsx");
  expect(html).toContain("Modified");
});

test("merge conflicts render a visually distinct, more severe state than ordinary modifications", () => {
  // health_detail_json with a 'conflicted' entry.
  const html = "";
  expect(html).toMatch(/conflict/i);
});

test("inspection_error status shows a distinct message, never 'repository_dirty' wording", () => {
  // health_status='inspection_error', health_error='not_a_repo: ...'
  const html = "";
  expect(html).not.toContain("repository_dirty");
  expect(html).toMatch(/repository status unavailable|inspection.*failed/i);
});

test("clean project shows no diagnostics section", () => {
  const html = ""; // health_status='healthy'
  expect(html).not.toContain("Local changes");
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm test:unit -- <the test file from Task 4>`

- [ ] **Step 4: Implement**

Replace the `uncommitted_count`-based banner (line 159) with rendering driven by `project.health_detail_json`:

```typescript
const healthDetail = project.health_detail_json as { summary: Record<string, number>; files: Array<{ path: string; status: string; staged: boolean }> } | null;
const summaryLine = (detail: typeof healthDetail) => detail
  ? Object.entries(detail.summary).map(([status, count]) => `${count} ${status}${count === 1 ? "" : "d"} file${count === 1 ? "" : "s"}`).join(", ")
  : "";
```

Replace the static "Last validation" panel's six hardcoded checklist items (~lines 141-144) with a real rendering that groups `healthDetail.files` by `status` (Modified / Staged / Untracked / Deleted / Renamed / Conflicted — conflicted rendered with a distinct visually-severe class, e.g. `banner-danger` matching the existing convention used elsewhere in this file for validation-failure banners), each file path escaped via the existing `escapeHtml` helper, plus a short blocking-explanation line ("This blocks: planning, execution" — confirm the exact set of blocked operations by checking what actually gates on `health_status === 'repository_dirty'` elsewhere in the codebase, e.g. the `approve-planning` 409 gate found during investigation at `server.ts:1842-1859`, and any execution-start gate — grep for `repository_dirty` across `apps/web/src` and `apps/worker/src` to enumerate all current blocking call sites before writing this list, so it's accurate rather than guessed) and copy-pasteable resolution commands using the project's actual `repository_path`:

```typescript
const resolutionGuidance = (path: string) => `<pre><code>cd ${escapeHtml(path)}

git status</code></pre>
<p>Keep the changes:</p>
<pre><code>git add &lt;files&gt;
git commit -m "Describe the change"</code></pre>
<p>Temporarily set them aside:</p>
<pre><code>git stash push -u</code></pre>
<p>Or remove/ignore unwanted local files.</p>`;
```

For an `inspection_error` status, render a distinct panel using `project.health_error` (escaped) instead of any of the above, explicitly stating the repository could not be inspected and why — never reusing `repository_dirty` wording.

Add a `Recheck repository` button using the existing `<dialog>`/button pattern already present on this page (per prior investigation, `projects.ts:67-74` for `<dialog>` usage, `projects.ts:158` for the existing "Run validation" button) — see Task 5 for its JS wiring.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test:unit -- <the test file from Task 4>`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/pages/projects.ts <test file>
git commit -m "feat: render actionable repository-dirty diagnostics with real file counts and resolution guidance"
```

---

### Task 5: Wire `Recheck repository` to refresh in place (no full reload)

**Files:**
- Modify: `apps/web/src/ui.ts` (currently `projects.ts:158`'s button triggers the blind-2s-reload handler at `ui.ts:330-333`, per prior investigation)

**Interfaces:**
- Consumes: `POST /api/admin/projects/:id/validate` (existing route, `server.ts:1545-1550`, unchanged) and the existing project GET route (must now return the new `health_detail_json`/`health_error` fields — confirm it does, since it likely already does `SELECT *`).

- [ ] **Step 1: Read the existing "Refresh" no-reload pattern**

Read `apps/web/src/ui.ts` around line 500 (the deployment panel's `data-refresh-deployment` handler, per prior investigation: `POST .../deployment/sync` then `setTimeout(loadStatus, 1500)`) to copy its exact structure.

- [ ] **Step 2: Write the failing test**

Since this is DOM/client-JS behavior, prefer an e2e test over a unit test:

```typescript
// tests/e2e/project-dirty-diagnostics.spec.ts (new file)
import { test, expect } from "@playwright/test";
import { loginViaUI } from "./helpers";

test("Recheck repository updates diagnostics in place without a full page reload", async ({ page }) => {
  await loginViaUI(page);
  // Navigate to a project seeded (or made, via the fixture harness) dirty.
  await page.goto("/admin/projects/<a dirty fixture project slug>");
  const beforeNavId = await page.evaluate(() => performance.navigation ? performance.navigation.type : (window as any).__navCount ?? 0);
  await page.locator("[data-recheck-repository]").click();
  await page.waitForTimeout(2000);
  // Assert the diagnostics section updated (e.g. file list changed or a
  // "Last checked" timestamp advanced) without window.location having
  // triggered a full navigation — confirm via a marker set once on initial
  // load that would be cleared by a full reload.
});

test("repository becomes healthy after changes are resolved, confirmed via Recheck", async ({ page }) => {
  // Requires a fixture project + the ability to clean its working tree
  // between the dirty check and the recheck (e.g. the e2e harness owns a real
  // tmp git checkout for its fixture projects — confirm this exists before
  // writing this test; if the harness fixtures are read-only, this test may
  // need to run against a project created fresh in the test and committed to
  // cleanly, then dirtied, then cleaned, all via shell commands the test
  // controls directly rather than relying on pre-seeded fixtures).
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd tests/e2e && ./run-e2e.sh project-dirty-diagnostics.spec.ts`

- [ ] **Step 4: Implement**

In `apps/web/src/ui.ts`, replace the existing `[data-validate-button]` handler (currently: enqueue job, `alert`, blind `setTimeout(() => location.reload(), 2000)`) — or add a new `[data-recheck-repository]` handler if Task 4 used a distinct attribute name — with the deployment-panel's no-reload pattern:

```javascript
document.querySelector("[data-recheck-repository]")?.addEventListener("click", async () => {
  const button = event.target;
  button.disabled = true;
  button.textContent = "Checking…";
  await fetch(`/api/admin/projects/${projectId}/validate`, { method: "POST", headers: { "x-csrf-token": csrf } });
  setTimeout(async () => {
    const response = await fetch(`/api/admin/projects/${projectId}`);
    const project = await response.json();
    renderDirtyDiagnostics(project); // re-render the diagnostics DOM in place from the fresh project row
    button.disabled = false;
    button.textContent = "Recheck repository";
  }, 2000); // project.validate is an enqueued job, not synchronous — this
            // matches the existing deployment-refresh polling delay; if the
            // job hasn't completed by then, a second click re-triggers it,
            // which is safe since project.validate is idempotent per project.
});
```

`renderDirtyDiagnostics` needs to either be a small client-side re-render function mirroring the server-side template from Task 4 (duplicating minimal markup, acceptable given this codebase's existing pattern of client-side re-render functions like `loadStatus` in the deployment panel), or the simpler fallback of re-fetching the whole project page fragment via an existing partial-render endpoint if one exists (check for one before duplicating markup — grep for other `renderDirtyDiagnostics`-shaped patterns like `loadStatus` at `ui.ts:405` to see whether this codebase already has a "fetch project JSON, re-render one section" helper to extend rather than duplicate).

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd tests/e2e && ./run-e2e.sh project-dirty-diagnostics.spec.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/ui.ts tests/e2e/project-dirty-diagnostics.spec.ts
git commit -m "feat: wire Recheck repository to refresh diagnostics in place without a full reload"
```

---

## Self-Review Notes (completed during plan authoring)

- **Spec coverage**: categorization of all required file states including conflicts (Task 1), distinguishing inspection failure from dirty (Task 2), persistence (Task 3), real file counts fixing the pre-existing `uncommitted_count` bug (Task 4), blocking-operations explanation sourced from actual gating code rather than guessed (Task 4 Step 4), resolution guidance without destructive defaults (Task 4 Step 4), working recheck (Task 5). Optional `Stash changes` action explicitly deferred per the spec's own allowance ("acceptable for the first implementation to be diagnostic-only plus Recheck repository").
- **Security**: no new client-supplied path anywhere; `repository_path` continues to come exclusively from the DB row (Global Constraints section states this explicitly); file contents never exposed, only names/status.
- **No placeholders**: Task 3 Step 5 and Task 5 Step 4 both explicitly instruct checking existing code/constraints before proceeding rather than assuming a shape — these are "verify then implement" steps with concrete fallback instructions, not vague deferrals.
