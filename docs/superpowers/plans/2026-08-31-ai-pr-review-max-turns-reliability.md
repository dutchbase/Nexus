# AI PR Review Max-Turns Reliability Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop automated AI PR reviews from failing with "Reached maximum number of turns (10)" so they succeed on their first automatic attempt, and stop the content-sync script from being able to silently erase an admin's prompt customization.

**Architecture:** Three independent fixes: (1) make the vendored-content sync script leave any human-customized prompt alone forever, instead of treating every global prompt file as re-syncable vendor content; (2) fix the actual defect that wastes the model's turn budget (a stale, unadapted code-review rubric injected into the tool-restricted PR-review prompt); (3) add a safety net so the existing job-retry mechanism catches any remaining max-turns failures instead of surfacing them as permanent errors.

**Tech Stack:** TypeScript, Node.js, PostgreSQL-backed worker queue, Vitest.

**Spec:** This plan (no separate spec doc — investigation findings are captured below).

## Global Constraints

- Work from a feature branch/worktree; do not commit, merge, or push directly on `master`/`main`.
- Do not add a configurable AI-review turn limit or new settings/config surface — fix the root cause instead of adding a knob.
- AI review must remain non-merging unless `parsePrReviewVerdict()` returns `verdict: "approved"` — do not change merge-gating logic.
- Do not touch `prompts/global/code-reviewer.md` directly — it is mechanically synced from the upstream `superpowers` skill package by `scripts/update-superpowers.ts`/`sync-agent-content.ts` and any local edit would be overwritten on the next sync. Fix this in the *consuming* code instead.
- Do not change `syncAgentContent()`'s behavior for prompts that have never been customized by a human — dev-control's own default prompt improvements must keep auto-propagating from git into the database for any prompt nobody has edited via the admin UI.

---

## Context

### What was asked

A lot of automatic AI PR reviews fail with `"Reached maximum number of turns (10)"`, and it wasn't clear why. The goal is for every automatic review to succeed on the first try.

Partway through this investigation, a second, related concern came up: the admin UI prompt at `/admin/prompts/085364af-dff9-4676-8996-cf5df8ce73b0` (the global `pr-review` prompt) was suspected of not actually being the prompt the automated review uses. That turned out to point at a real, separate bug — see Finding 1 below — and it's now part of this plan because it's the same investigation and it directly affects trust in whatever prompt fix ships here.

### Where this runs

`apps/worker/src/worker.ts`'s `runPrAiReview()` (line 1173) is triggered automatically by `autoEnqueuePullRequestReviews()` (line 1700) on every worker sync pass. It builds a prompt from the DB-resolved `pr-review` prompt (`resolvedPromptFor(pool, "pr-review", project.id)`) plus an injected rubric (`resolvedGlobalPrompt("code-reviewer")`), then invokes Claude via `invokePlanningClaude()` (`packages/claude-runner/src/index.ts`) with `tools: ["Read", "Glob", "Grep"]` (no Bash) and `maxTurns: 10`.

### Finding 1: the content-sync script can silently erase an admin's prompt edit (confirmed — this is what triggered the user's suspicion)

`scripts/sync-agent-content.ts`'s `syncAgentContent()` was built to keep one specific file — the code-review rubric vendored from the upstream `superpowers` package (`prompts/global/code-reviewer.md`) — in sync with new upstream releases. But `buildAgentContentCatalog()` builds its `prompt_hashes`/`prompt_sources` map from **every** `.md` file under `prompts/global/` (`base`, `planning`, `plan-revision`, `execution`, `execution-repair`, `validation`, `pull-request`, `pr-review`, `pr-conflict-resolution`, `follow-up-ticket`, `code-reviewer` — all 11), not just the rubric. `syncAgentContent()`'s loop then treats a hash mismatch on *any* of them as "the vendored source changed, publish a new active version from the file" — with no distinction between the one file that's actually vendored and the other ten, which are dev-control's own prompts that admins are expected to customize live via the admin UI.

Confirmed with real data for the `pr-review` prompt (`prompt_files.id = 085364af-dff9-4676-8996-cf5df8ce73b0`):

| Version | Created | `created_by` | content_hash |
|---|---|---|---|
| 1 | 2026-07-30 | *(system seed)* | `6f7c25…` |
| 2 | 2026-07-31 | a human (admin UI) | `6f7c25…` (no-op restore) |
| 3 | 2026-08-03 | *(NULL — sync script)* | `c78bfe…` — **matches the current checked-in `prompts/global/pr-review.md` exactly** |
| 4 | 2026-08-28 | a human (admin UI) | `38839e…` — adds `"if you approve the PR then only return the json without further explanation"` |

Version 4 is the one actually in use today (confirmed via `prompt_snapshots` for reviews run as recently as this morning), and it is **not reflected in the git file at all** — the git file is frozen at version 3's content from 2026-08-03. The only reason the human's v4 edit has survived is that nobody has touched `prompts/global/pr-review.md` in git since then, so `syncAgentContent()`'s "unchanged since last sync" short-circuit keeps firing. `agent_content.sync` records a sync ran again as recently as today (2026-08-31 07:37 UTC) and still preserved v4 — but only by that same coincidence. **The next time anyone commits any change to that file** (or to any of the other 10 non-rubric global prompt files), the next sync run will detect the hash mismatch, see that the DB's active version doesn't match the file either, and silently overwrite the admin's customization with the stale file content — with no warning, no diff, and no way for the admin to tell it happened short of noticing the review's behavior change. This is a systemic risk across all 10 non-rubric prompt types, not just `pr-review`.

This is a genuine, separate bug from the turn-budget issue, and it's the direct answer to "the AI PR review does not use the pr-review prompt I've set in the UI" — right now it *does*, but the mechanism that could silently revert it on the next unrelated commit is real and needs fixing regardless.

### Finding 2: the injected review rubric wastes the turn budget on an impossible instruction (root cause of the turn exhaustion)

**Production data** (queried directly from the `dcc` database):

| Metric | Value |
|---|---|
| Total `pr_ai_reviews` rows | 385 |
| Rows with `status='error'` | 228 (59%) |
| Rows whose `error_message` mentions "maximum number of turns" | 93 (24% of all reviews) |
| Max-turns failure rate for `model=sonnet, reasoning_level=high` | **79 / 157 = 50%** |
| Max-turns failure rate for `model=sonnet, reasoning_level=medium` | 6 / 81 = 7% |
| Max-turns failure rate for `model=sonnet, reasoning_level=high`, `haiku, high` — before vs. after `sonnet` started defaulting to `high` (2026-08-28/29) | before: n/a (that combo didn't exist yet); after: 79/157 = 50% |
| Current default settings (`ai_review_settings` table) | `default_model=sonnet`, `default_reasoning_level=high` |

(The `pr-review.md` v4 edit from Finding 1 and the `reasoning_level=high` default both landed around 2026-08-28/29, but breaking the data down by recorded `reasoning_level` per review — not just by date — shows `reasoning_level` is the variable that actually correlates with the failure spike, not the prompt text edit: `haiku`+`high` fails at a similar elevated rate both before and after that date, while `sonnet`+`medium`, still visible in the "before" data, only failed 7% of the time.)

**Root cause (confirmed from an actual failed review's stored prompt, `agent_runs.task_prompt`):**

The rubric injected via `{{superpowers.code-reviewer}}` in `pr-review.md` is `prompts/global/code-reviewer.md`, copied verbatim from the upstream `superpowers:requesting-code-review` skill. That skill is designed for a *different* usage pattern: a human/coordinator agent fills in template placeholders (`{DESCRIPTION}`, `{PLAN_OR_REQUIREMENTS}`, `{BASE_SHA}`, `{HEAD_SHA}`) and dispatches a **Bash-enabled** subagent that runs:

```bash
git diff --stat {BASE_SHA}..{HEAD_SHA}
git diff {BASE_SHA}..{HEAD_SHA}
```

itself to fetch the diff (see `~/.claude/plugins/cache/claude-plugins-official/superpowers/6.3.0/skills/requesting-code-review/SKILL.md`).

`renderPrReviewPrompt()` (`packages/domain/src/pr-review.ts`) only substitutes double-curly `{{...}}` tokens (`pr.title`, `pr.diff`, etc.) — it never touches the rubric's single-curly `{BASE_SHA}`-style tokens. The automated PR-review flow also strips `Bash` from the tool list and already supplies the diff inline as `pr.diff`. The result, confirmed verbatim in a real failed review's prompt:

- Literal, never-filled placeholders reach the model: `Review {WHAT_WAS_IMPLEMENTED}`, `Compare against {PLAN_OR_REQUIREMENTS}`, `**Base:** {BASE_SHA}`, `**Head:** {HEAD_SHA}`.
- An explicit instruction to run `git diff` via Bash — a tool the model does not have.

The model has to reconcile a prompt that both hands it the diff directly *and* tells it to go fetch the diff itself with a tool it doesn't have, using placeholder values that are literally the string `{BASE_SHA}`. That confusion burns turns on unproductive exploration before it ever gets to reviewing the actual diff. `reasoning_level=high` makes the model *more* thorough/rule-following about trying to satisfy every instruction it's given (including the impossible one), which is why "high" fails far more often than "medium" despite reviewing the exact same prompt defect.

### Finding 3: max-turns failures never get a retry, even though they're safe to retry

`shouldRetryPrReview()` (`apps/worker/src/worker-boundary.ts:154`) explicitly does *not* retry a max-turns failure — it only retries when `rawOutput` already exists (publication retry) or the error is a `GitHubProviderError` with code `transient`/`rate_limited`. A max-turns failure produces no `rawOutput` and isn't a `GitHubProviderError`, so it is never retried even though the job already has `maxAttempts: 3` budget and the failure happens with zero side effects (nothing published to GitHub, nothing merged). Every max-turns failure is therefore terminal on attempt 1, requiring a human to manually re-click "AI review".

### Why this plan has three fixes

1. **Stop the sync script from being able to erase admin customizations** (Finding 1) — directly resolves the trust problem the user raised, and closes a live risk that isn't specific to `pr-review`.
2. **Fix the prompt defect** (Finding 2, the actual root cause of turn exhaustion) — strip the impossible git-diff-via-Bash instruction and fill the remaining stray placeholders with PR-review-appropriate text, entirely in the consuming code so it survives the next upstream rubric sync.
3. **Let max-turns failures use the existing retry budget** (Finding 3, safety net) — for the residual cases (e.g. a genuinely huge diff under `high` effort) where even a clean prompt might need more than 10 turns, let the job's already-configured 3 attempts actually kick in instead of failing permanently on attempt 1.

**Out of scope** (separate, already-tracked issues, not related to max-turns): the `42P08` Postgres type error (`plans/10-ai-pr-review-parameter-type-error.md` already covers it), `opencode_failed` (DeepSeek/OpenCode path, exit code 1 with no stderr — different model/runner entirely), and `"pull request base changed before AI review"` (correct-by-design abort when the PR moves mid-review).

---

## File Structure

- Modify: `scripts/sync-agent-content.ts` — never let the sync loop overwrite a prompt whose active version was created by a human.
- Modify: `scripts/superpowers-content.test.ts` — regression test proving a human-customized prompt survives a source-file change.
- Modify: `packages/domain/src/pr-review.ts` — add a rubric sanitizer and call it from `renderPrReviewPrompt()`.
- Modify: `packages/domain/src/pr-review.test.ts` — regression tests for the sanitizer.
- Modify: `apps/worker/src/worker-boundary.ts` — let `shouldRetryPrReview()` retry max-turns exhaustion.
- Modify: `apps/worker/src/task-7.test.ts` — regression test for the new retry condition (this file already holds all `shouldRetryPrReview` tests).

### Task 1: Never let the content sync overwrite a human-customized prompt

**Files:**
- Modify: `scripts/sync-agent-content.ts`
- Modify: `scripts/superpowers-content.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `syncAgentContent()` keeps its existing return shape `{ promptsUpdated, promptsPreserved, skillsSynced }` plus one new field, `manualOverridesPreserved: number`, so operators can see in the sync log that a customization was intentionally left alone (distinct from "unchanged since last check").

- [ ] **Step 1: Write the failing test**

Add to `scripts/superpowers-content.test.ts`, after the existing `"publishes a new immutable prompt version when the tracked source changes"` test (after line 157):

```ts
it("never overwrites a prompt a human has customized, even when its source file changes", async () => {
  const { root } = await fixture();
  await mkdir(join(root, "prompts", "global"), { recursive: true });
  await writeFile(join(root, "prompts", "global", "base.md"), "changed source\n");
  const catalog = await buildAgentContentCatalog({ root, manifest: { superpowers: { tag: "v4.1.0" } }, skills: [] });
  const calls: { sql: string; values?: unknown[] }[] = [];
  const client = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      if (sql.includes("FROM agent_content")) return { rows: [{ sync: { prompt_hashes: { base: hash("old source") } } }] };
      if (sql.includes("FROM prompt_files")) {
        return { rows: [{ id: "prompt-1", active_content_hash: hash("admin's customized prompt"), active_created_by: "user-1" }] };
      }
      return { rows: [] };
    },
  };

  expect(await syncAgentContent(client, catalog)).toMatchObject({ promptsUpdated: 0, promptsPreserved: 1, manualOverridesPreserved: 1 });
  expect(calls.some((call) => call.sql.startsWith("UPDATE prompt_files"))).toBe(false);
  expect(calls.some((call) => call.sql.includes("INSERT INTO prompt_versions"))).toBe(false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run scripts/superpowers-content.test.ts -t "never overwrites a prompt a human has customized"`
Expected: FAIL — today's `syncAgentContent()` has no concept of `active_created_by`, so it falls through to the clobber branch and the assertions on `promptsUpdated`/`INSERT INTO prompt_versions` fail.

- [ ] **Step 3: Implement the guard**

In `scripts/sync-agent-content.ts`, update the per-prompt-type loop inside `syncAgentContent()`:

```ts
export async function syncAgentContent(client: QueryClient, catalog: AgentContentCatalog) {
  const syncRow = await client.query("SELECT sync FROM agent_content WHERE id=true FOR UPDATE");
  const previous = syncRow.rows[0]?.sync ?? {};
  let promptsUpdated = 0;
  let promptsPreserved = 0;
  let manualOverridesPreserved = 0;
  for (const skill of catalog.skills) {
    await client.query(
      `INSERT INTO skills (slug,name,description,category,source_type,filesystem_path,enabled,version,content_hash,configuration_json)
       VALUES ($1,$2,$3,'superpowers','vendored',$4,true,$5,$6,$7::jsonb)
       ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description,category=EXCLUDED.category,source_type=EXCLUDED.source_type,filesystem_path=EXCLUDED.filesystem_path,enabled=true,version=EXCLUDED.version,content_hash=EXCLUDED.content_hash,configuration_json=EXCLUDED.configuration_json,updated_at=now()`,
      [skill.slug, skill.name, skill.description, `${catalog.vendor_path}/${skill.slug}/SKILL.md`, skill.version, skill.content_hash,
        JSON.stringify({ phases: skill.phases, required_phases: skill.phases, allowed_phases: skill.phases, inspiration_only: skill.inspiration_only })],
    );
  }
  await client.query(
    "UPDATE skills SET enabled=false,updated_at=now() WHERE source_type='vendored' AND category='superpowers' AND NOT (slug = ANY($1::text[]))",
    [catalog.skills.map((skill) => skill.slug)],
  );
  for (const [promptType, sourceHash] of Object.entries(catalog.prompt_hashes)) {
    if (previous.prompt_hashes?.[promptType] === sourceHash) { promptsPreserved++; continue; }
    const file = (await client.query(
      // active_created_by is set only when the active version was published through the
      // admin UI (see apps/web/src/server.ts's prompt-version routes, which always pass
      // created_by). A system-synced version (this same loop's own INSERT below) never
      // sets it. Once a human has customized a prompt, this sync must never touch it
      // again — a routine vendored-content sync silently overwriting a live admin edit
      // is exactly the bug this guard exists to prevent (docs/superpowers/plans, AI PR
      // review max-turns investigation).
      `SELECT pf.id,pv.content_hash active_content_hash,pv.created_by active_created_by FROM prompt_files pf LEFT JOIN prompt_versions pv ON pv.id=pf.active_version_id WHERE pf.scope='global' AND pf.prompt_type=$1 FOR UPDATE OF pf`, [promptType],
    )).rows[0];
    if (file?.active_content_hash === sourceHash) { promptsPreserved++; continue; }
    if (file?.active_created_by) { promptsPreserved++; manualOverridesPreserved++; continue; }
    const promptFile = file ?? (await client.query(
      "INSERT INTO prompt_files (scope,prompt_type,file_path) VALUES ('global',$1,$2) RETURNING id", [promptType, `prompts/global/${promptType}.md`],
    )).rows[0];
    const content = catalog.prompt_sources[promptType];
    const version = (await client.query("SELECT COALESCE(max(version),0)+1 AS version FROM prompt_versions WHERE prompt_file_id=$1", [promptFile.id])).rows[0].version;
    const created = (await client.query(
      "INSERT INTO prompt_versions (prompt_file_id,version,content,content_hash) VALUES ($1,$2,$3,$4) RETURNING id", [promptFile.id, version, content, sourceHash],
    )).rows[0];
    await client.query("UPDATE prompt_files SET active_version_id=$2,updated_at=now() WHERE id=$1", [promptFile.id, created.id]);
    promptsUpdated++;
  }
  await client.query(
    "INSERT INTO agent_content (id,sync) VALUES (true,$1::jsonb) ON CONFLICT (id) DO UPDATE SET sync=EXCLUDED.sync,updated_at=now()",
    [JSON.stringify({ catalog_hash: catalog.catalog_hash, prompt_hashes: catalog.prompt_hashes })],
  );
  return { promptsUpdated, promptsPreserved, manualOverridesPreserved, skillsSynced: catalog.skills.length };
}
```

Also update `main()`'s log line so the new count is visible when this runs in CI/deploy:

```ts
async function main() {
  const manifest = JSON.parse(await readFile(path.join(root, "config", "agent-content.json"), "utf8"));
  const catalog = await readImportedAgentContentCatalog({ manifest });
  const result = await inTransaction((client) => syncAgentContent(client, catalog));
  console.log(`synced ${result.skillsSynced} skills and ${result.promptsUpdated} prompts (${result.manualOverridesPreserved} manual prompt customizations left untouched)`);
}
```

Do not change the `skills` sync loop above it, and do not change the two existing hash-comparison short-circuits — only add the new `active_created_by` check between them and the clobber branch.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run scripts/superpowers-content.test.ts`
Expected: PASS — the new test passes, and all pre-existing tests in this file still pass unchanged (their mock `FROM prompt_files` rows never set `active_created_by`, so `file?.active_created_by` is `undefined`/falsy and they fall through to the same behavior as before).

- [ ] **Step 5: Commit**

```bash
git add scripts/sync-agent-content.ts scripts/superpowers-content.test.ts
git commit -m "fix: never let vendored-content sync overwrite a human-customized prompt"
```

### Task 2: Sanitize the injected review rubric for the diff-only, no-Bash PR-review context

**Files:**
- Modify: `packages/domain/src/pr-review.ts`
- Modify: `packages/domain/src/pr-review.test.ts`

**Interfaces:**
- Consumes: nothing new — operates on `vars.superpowersCodeReviewer: string` already passed into `renderPrReviewPrompt()`.
- Produces: `export function sanitizeReviewRubricForPrReview(rubric: string): string`, used internally by `renderPrReviewPrompt()`. No signature change to `renderPrReviewPrompt()` itself, so `apps/worker/src/worker.ts`'s call site needs no changes.

- [ ] **Step 1: Write the failing tests**

Add to `packages/domain/src/pr-review.test.ts` (new `describe` block, alongside the existing `"PR review prompt"` block):

```ts
describe("review rubric sanitization", () => {
  const rubricWithGitRangeSection = [
    "# Code Review Agent",
    "",
    "**Your task:**",
    "1. Review {WHAT_WAS_IMPLEMENTED}",
    "2. Compare against {PLAN_OR_REQUIREMENTS}",
    "",
    "## What Was Implemented",
    "",
    "{DESCRIPTION}",
    "",
    "## Requirements/Plan",
    "",
    "{PLAN_REFERENCE}",
    "",
    "## Git Range to Review",
    "",
    "**Base:** {BASE_SHA}",
    "**Head:** {HEAD_SHA}",
    "",
    "```bash",
    "git diff --stat {BASE_SHA}..{HEAD_SHA}",
    "git diff {BASE_SHA}..{HEAD_SHA}",
    "```",
    "",
    "## Review Checklist",
    "",
    "**Code Quality:**",
    "- Clean separation of concerns?",
  ].join("\n");

  it("removes the git-diff-via-Bash section entirely", () => {
    const sanitized = sanitizeReviewRubricForPrReview(rubricWithGitRangeSection);
    expect(sanitized).not.toContain("Git Range to Review");
    expect(sanitized).not.toContain("git diff");
    expect(sanitized).not.toContain("{BASE_SHA}");
    expect(sanitized).not.toContain("{HEAD_SHA}");
  });

  it("fills remaining stray placeholders instead of leaving them literal", () => {
    const sanitized = sanitizeReviewRubricForPrReview(rubricWithGitRangeSection);
    expect(sanitized).not.toContain("{WHAT_WAS_IMPLEMENTED}");
    expect(sanitized).not.toContain("{PLAN_OR_REQUIREMENTS}");
    expect(sanitized).not.toContain("{DESCRIPTION}");
    expect(sanitized).not.toContain("{PLAN_REFERENCE}");
  });

  it("keeps the rest of the rubric (checklist, output format) intact", () => {
    const sanitized = sanitizeReviewRubricForPrReview(rubricWithGitRangeSection);
    expect(sanitized).toContain("## Review Checklist");
    expect(sanitized).toContain("Clean separation of concerns?");
  });

  it("is applied automatically inside renderPrReviewPrompt", () => {
    const prompt = renderPrReviewPrompt(template, {
      superpowersCodeReviewer: rubricWithGitRangeSection,
      project: { name: "Control Center" },
      pr: { title: "Title", author: "octocat", head_branch: "branch", base_branch: "main", body: "body", diff: "diff" },
    });
    expect(prompt).not.toContain("{BASE_SHA}");
    expect(prompt).not.toContain("git diff");
    expect(prompt).toContain("## Review Checklist");
  });
});
```

Add `sanitizeReviewRubricForPrReview` to the existing import line at the top of the file:

```ts
import { parsePrReviewVerdict, PrReviewVerdictError, renderPrReviewPrompt, sanitizeReviewRubricForPrReview } from "./pr-review.ts";
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run packages/domain/src/pr-review.test.ts`
Expected: FAIL — `sanitizeReviewRubricForPrReview` is not exported yet, and the last two existing behaviors (placeholders/git-diff still present) aren't implemented.

- [ ] **Step 3: Implement the sanitizer and wire it in**

In `packages/domain/src/pr-review.ts`, add above `flatten()`:

```ts
// The injected code-review rubric (prompts/global/code-reviewer.md) is synced
// verbatim from the upstream superpowers:requesting-code-review skill, which
// expects a Bash-enabled reviewer to fetch its own diff via `git diff
// {BASE_SHA}..{HEAD_SHA}` and a caller to fill {DESCRIPTION}/{PLAN_REFERENCE}
// placeholders. The automated PR-review flow supplies the diff inline instead
// and has no Bash tool, so left unsanitized this section sent the model literal
// `{BASE_SHA}` placeholders plus an instruction to run a tool it doesn't have —
// turns burned reconciling that, not reviewing the diff (root cause of the
// "Reached maximum number of turns" failures; see docs/superpowers/plans).
const GIT_RANGE_SECTION = /\n## Git Range to Review\n[\s\S]*?(?=\n## )/;

const RUBRIC_PLACEHOLDER_FALLBACKS: Record<string, string> = {
  WHAT_WAS_IMPLEMENTED: "the supplied pull request diff and checked-out repository",
  PLAN_OR_REQUIREMENTS: "the pull request's stated intent (title and description above) — no separate plan document applies",
  DESCRIPTION: "See the pull request title, description, and diff already supplied above.",
  PLAN_REFERENCE: "Not applicable — this is an automated pull-request review with no separate plan document.",
};

export function sanitizeReviewRubricForPrReview(rubric: string): string {
  const withoutGitRange = rubric.replace(GIT_RANGE_SECTION, "");
  return withoutGitRange.replace(/\{([A-Z_]+)\}/g, (match, key: string) => RUBRIC_PLACEHOLDER_FALLBACKS[key] ?? match);
}
```

Then update `renderPrReviewPrompt()` to sanitize before use:

```ts
export function renderPrReviewPrompt(template: string, vars: PrReviewPromptVars): string {
  const sanitizedRubric = sanitizeReviewRubricForPrReview(vars.superpowersCodeReviewer);
  const values = flatten({ ...vars, superpowersCodeReviewer: sanitizedRubric });
  const rendered = template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_match, key: string) => values[key] ?? _match);
  return /\{\{\s*superpowers\.code-reviewer\s*\}\}/.test(template)
    ? rendered
    : `${rendered}\n\n## Required immutable review rubric\n\n${sanitizedRubric}`;
}
```

Do not change `flatten()`'s other keys, `parsePrReviewVerdict()`, or `validateVerdictJson()`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run packages/domain/src/pr-review.test.ts`
Expected: PASS — all new tests green, and all pre-existing tests in this file still pass unchanged (they pass rubric strings with no `{BASE_SHA}`-style tokens, so sanitization is a no-op for them).

- [ ] **Step 5: Confirm the real synced rubric sanitizes cleanly**

Run this one-off check (not a permanent test — just confirms the regex matches the actual current file, since `sanitizeReviewRubricForPrReview` is exercised against fixture text in the unit tests, not the live file):

```bash
pnpm exec tsx -e "
import { sanitizeReviewRubricForPrReview } from './packages/domain/src/pr-review.ts';
import { readFileSync } from 'node:fs';
const rubric = readFileSync('prompts/global/code-reviewer.md', 'utf8');
const sanitized = sanitizeReviewRubricForPrReview(rubric);
console.log('contains BASE_SHA:', sanitized.includes('{BASE_SHA}'));
console.log('contains git diff:', sanitized.includes('git diff'));
console.log('contains Review Checklist:', sanitized.includes('## Review Checklist'));
"
```

Expected output:
```
contains BASE_SHA: false
contains git diff: false
contains Review Checklist: true
```

If `sync-agent-content.ts` has re-synced `code-reviewer.md` with a differently-worded git-range heading by the time you run this, adjust `GIT_RANGE_SECTION`'s heading text to match — the goal is that no unresolved single-curly placeholder or Bash instruction survives into the rendered PR-review prompt.

- [ ] **Step 6: Commit**

```bash
git add packages/domain/src/pr-review.ts packages/domain/src/pr-review.test.ts
git commit -m "fix: strip Bash-only git-diff instructions from the automated PR-review rubric"
```

### Task 3: Let the existing retry budget catch a max-turns exhaustion

**Files:**
- Modify: `apps/worker/src/worker-boundary.ts`
- Modify: `apps/worker/src/task-7.test.ts`

**Interfaces:**
- Consumes: the `error` thrown by `invokePlanningClaude()` on non-zero exit, whose `.message` is built by `summarizeClaudeFailure()` (`packages/claude-runner/src/index.ts:431`) and contains the literal string `"Reached maximum number of turns (N)"` straight from Claude's JSON `errors` array.
- Produces: `shouldRetryPrReview()` keeps its existing signature `(error: unknown, rawOutput: string | null, attempt: number, maxAttempts: number): boolean`; only its retryable-condition logic changes. No caller changes needed — `apps/worker/src/worker.ts:1403` already calls it as-is.

- [ ] **Step 1: Write the failing test**

Add to the existing `shouldRetryPrReview` test group in `apps/worker/src/task-7.test.ts` (near the other `test.each(["transient", "rate_limited"])` case, around line 172):

```ts
test("retries a max-turns exhaustion before any output is persisted", () => {
  const shouldRetry = (workerBoundary as any).shouldRetryPrReview;
  expect(shouldRetry(new Error("Reached maximum number of turns (10)"), null, 1, 3)).toBe(true);
  expect(shouldRetry(new Error("Reached maximum number of turns (10)"), null, 3, 3)).toBe(false);
  expect(shouldRetry(new Error("some other failure"), null, 1, 3)).toBe(false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run apps/worker/src/task-7.test.ts -t "shouldRetryPrReview"`
Expected: FAIL — the first assertion returns `false` today because a plain `Error` with no `rawOutput` and no `GitHubProviderError` type never satisfies the current condition.

- [ ] **Step 3: Implement the retry condition**

In `apps/worker/src/worker-boundary.ts`, near `shouldRetryPrReview` (line 154):

```ts
// A max-turns exhaustion happens before any GitHub side effect or raw_output
// write (see runPrAiReview in worker.ts) — retrying it is exactly as safe as
// retrying a transient GitHub error, and the job already has maxAttempts
// budget for it that was previously never used for this failure mode.
function isMaxTurnsExhaustion(error: unknown): boolean {
  return error instanceof Error && /Reached maximum number of turns/i.test(error.message);
}

export function shouldRetryPrReview(error: unknown, rawOutput: string | null, attempt: number, maxAttempts: number) {
  if (error instanceof PrReviewDestinationError) return false;
  return attempt < maxAttempts && (Boolean(rawOutput)
    || error instanceof GitHubProviderError && ["transient", "rate_limited"].includes(error.code)
    || isMaxTurnsExhaustion(error));
}
```

Do not change the `PrReviewDestinationError` early return — a destination mismatch must stay non-retryable regardless of its message text.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run apps/worker/src/task-7.test.ts -t "shouldRetryPrReview"`
Expected: PASS — new test green, and the pre-existing `shouldRetryPrReview` tests (transient/rate_limited, publication retry, destination-mismatch) still pass unchanged.

- [ ] **Step 5: Run the full worker test suite**

Run: `pnpm exec vitest run apps/worker`
Expected: PASS — confirms nothing else depended on max-turns errors being non-retryable (e.g. no test asserts a max-turns failure terminalizes on attempt 1).

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/worker-boundary.ts apps/worker/src/task-7.test.ts
git commit -m "fix: retry PR reviews that exhaust their turn budget before producing output"
```

### Task 4: Verify in the deployed app and confirm the failure rate actually drops

**Files:** none (verification only).

- [ ] **Step 1: Manual acceptance check — PR review**

From `/admin/pull-requests/<project-slug>/<number>` on a PR that previously failed with a max-turns error (or any open PR), click **AI review**. Confirm the newest history entry becomes **APPROVED** or **REJECTED** with a review summary — not stuck on a max-turns error.

- [ ] **Step 2: Manual acceptance check — prompt customization survives a sync**

Run the content-sync script once (`pnpm exec tsx scripts/sync-agent-content.ts` or however it's wired into deploy) after making an unrelated whitespace-only change to `prompts/global/pr-review.md` (to force a hash mismatch), then re-check the admin UI at `/admin/prompts/085364af-dff9-4676-8996-cf5df8ce73b0`: the active version and its content must remain the human-authored v4 content, not the file's content. Revert the whitespace change afterward.

- [ ] **Step 3: Confirm the rendered review prompt is clean for a real PR**

After deploying, pick the most recent `pr_ai_reviews` row and check its prompt snapshot no longer contains the defect:

```bash
export PGPASSWORD=<see .env DATABASE_URL>
psql -h 127.0.0.1 -p 5433 -U dcc -d dcc -c "
SELECT ar.task_prompt ILIKE '%{BASE_SHA}%' AS has_base_sha_placeholder,
       ar.task_prompt ILIKE '%git diff%' AS has_git_diff_instruction
FROM agent_runs ar
JOIN pr_ai_reviews pr ON pr.agent_run_id = ar.id
WHERE pr.mode IS NOT NULL
ORDER BY ar.created_at DESC
LIMIT 1;
"
```

Expected: both columns `false`.

- [ ] **Step 4: Track the failure rate going forward**

A week or so after deploying, re-run the diagnostic query used during this investigation to confirm the max-turns failure rate has dropped substantially from the pre-fix baseline (93 failures / 385 reviews, 50% for `sonnet`+`high`):

```bash
psql -h 127.0.0.1 -p 5433 -U dcc -d dcc -c "
SELECT model, reasoning_level,
       count(*) FILTER (WHERE error_message ILIKE '%maximum number of turns%') AS max_turns_failures,
       count(*) AS total
FROM pr_ai_reviews
WHERE created_at > now() - interval '7 days'
GROUP BY 1,2
ORDER BY 4 DESC;
"
```

If `sonnet`/`high` still fails frequently after Task 2's fix, that means the clean prompt genuinely needs more than 10 turns for some PRs at that effort level — in that case, revisit whether `high` should remain the default (a product decision, not covered by this plan) rather than adding new code.

---

## Self-Review

- **Spec coverage:** Task 1 fixes the sync-clobbering bug the user flagged directly, without touching the legitimate auto-propagation path for never-customized prompts (verified against the existing `superpowers-content.test.ts` fixtures, which keep passing unchanged). Task 2 fixes the confirmed root cause of turn exhaustion (unresolved placeholders + impossible Bash instruction). Task 3 ensures the job's already-budgeted 3 attempts actually get used for that failure mode instead of terminalizing on attempt 1. Task 4 verifies all three in the running system. Out-of-scope error codes are named explicitly so their continued presence in `pr_ai_reviews` isn't mistaken for this fix not working.
- **Placeholder scan:** no TBD/TODO markers; all code steps show full, runnable code; no references to undefined types or functions.
- **Type consistency:** `sanitizeReviewRubricForPrReview(rubric: string): string` is defined once in Task 2 and consumed only inside `renderPrReviewPrompt()` in the same file — no cross-task signature drift. `shouldRetryPrReview`'s signature is unchanged in Task 3, so `apps/worker/src/worker.ts:1403`'s existing call site needs no edits. `syncAgentContent()`'s return type in Task 1 only gains one additional field (`manualOverridesPreserved`), which is additive and doesn't break `main()`'s existing consumption of `promptsUpdated`/`skillsSynced`.
