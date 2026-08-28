# dev-control Plans — Execution Index

Single repo affected by everything below: **`dutchbase/dev-control`** (this repo). Neither active plan touches any other repository — `va-jobs-platform` is referenced only as *data* (a `github_owner`/`github_repository` value on a `dev-control` project row); no code or PR in `dutchbase/va-jobs-platform` itself is ever touched.

## Previously completed (for context only — do not re-execute)

Plans `01` through `09` (GitHub policy merge eligibility, notification badge overlap, admin dashboard viewport fill, VA Jobs Platform production promotion, repository-dirty diagnostics, Nexus rebrand, open-source release readiness, AI PR review *defaults-save* error, PR bulk actions) were all planned and executed in an earlier session and are **already merged** to `master` (PRs #50-#58, confirmed via `gh pr list`). Their plan files remain in this directory as historical/investigation reference (several later investigations in this index cite specific file:line facts established while writing them) but there is nothing left to execute from them. Two more PRs (`#59` supersede-stale-deploy-attempts, `#60` WhatsApp deploy alerting) landed after that batch and are unrelated to anything below.

**Note:** plan `08`'s title ("AI PR review defaults save error") sounds related to plan `10` below but is a **different bug** in a **different code path** — plan 08 fixed an error when *saving the AI-review settings form* (`apps/web/src/pages/operate.ts`); plan 10 fixes an error during *actual AI review job execution/persistence* (`packages/domain/src/index.ts`). Confirmed unrelated by direct investigation, not assumed.

## Active plans

| # | Plan file | Source task |
|---|---|---|
| 10 | `10-ai-pr-review-parameter-type-error.md` | Fix AI PR review failures caused by `inconsistent types deduced for parameter $2` |
| 11 | `11-va-jobs-platform-preflight-placeholder-path.md` | Fix VA Jobs Platform pre-flight using stale placeholder local path |

Both source tasks from the 2026-08-27 dev-control task list are covered — one plan each, neither split nor merged with the other (they touch disjoint files and fix unrelated bugs; combining them would only obscure two independent root causes and two independent PR review surfaces).

**Verification note:** both plans' file:line citations were independently re-checked against the live repository (not taken on trust from the investigation that drafted them) — every citation checked (schema, route handlers, job handlers, test-file helper conventions) matched exactly. Plan 10's root cause was additionally reproduced live against a real migrated Postgres 16 instance (exact error, exact SQLSTATE `42P08`, exact "numeric versus bigint" detail), and the proposed fix was verified to resolve it end-to-end, including three test-code defects in the original draft (a missing fenced-JSON verdict block in two test fixtures that would have made `resumePrReviewPublication` throw instead of returning a verdict, a `parsed_verdict: null` seed that would have made the finalize `UPDATE` never match, and two `github_comment_id` assertions comparing against a number where `node-postgres` returns `bigint` columns as strings) — all three are corrected in the plan text as it stands now, and the corrected test file was re-run against real Postgres to confirm all cases pass.

---

## Investigation summary (ground truth — see each plan's own "Investigation findings" section for full file:line citations)

- **Plan 10's root cause:** `packages/domain/src/index.ts:111-128`, `recordAiUsage()`. A single `UPDATE ... RETURNING` statement binds the same positional parameter (`$2`, `$3`, `$5`, `$6`) once as a direct `bigint` column assignment and once inside a `numeric` price-arithmetic expression — Postgres rejects the whole query at prepare time with SQLSTATE `42P08`, **unconditionally**, for **every** model and job type that reports token usage (not just Sonnet, not just PR review — reproduced independently against a real Postgres 16 with the repo's actual migrations). The publication/GitHub-comment code path (`packages/domain/src/pr-review-publication.ts`) was independently verified to have **no** bug — every query there is correct, including its existing retry-safety and duplicate-comment-prevention logic (comment-body marker matching). No UUID-vs-text ambiguity exists anywhere in this path; the ticket's suspected pattern (UUID/text/jsonb reuse) was investigated and ruled out in favor of the actual bigint/numeric mismatch. No schema change is needed — only the query's cast expressions.
- **Plan 11's root cause:** not a code bug in path *resolution* — every consumer (Projects page, Merge page dropdown, Production tab, the `github.merge_preview` worker job, `project.validate`) reads the identical `projects.repository_path` DB column live, with no caching and no competing `projects.yaml` source (`packages/project-config`'s YAML loader is confirmed dead code, zero callers). The actual defect is a **data** integrity gap: `projects.slug` is the only unique constraint on the table (no constraint ties a row to a GitHub repo), and the already-merged migration `059_va_jobs_platform_project.sql` seeded a row keyed by `slug='va-jobs-platform'` with a placeholder `repository_path`, deliberately never overwriting that column on conflict. The Production tab and the production-promotion allowlist both hardcode resolution by that exact slug — so if the project's real, working path was ever configured on a *different*, pre-existing project row (plausible: the ticket's own example names the working project "**Jobs-platform**," not "VA Jobs Platform"), that real path never reaches the row this feature actually reads. Plan 11 reconciles this specific data state with a safe, non-destructive, idempotent migration, and separately hardens the two functions that would otherwise call `realpath()`/`stat()` on a placeholder (`validateProject()` and `previewRemoteBranchMerge()`) so this failure class can't recur with a raw `ENOENT` message regardless of how the underlying data ever got into a bad state again.

---

## Dependencies between plans

**Plans 10 and 11 are functionally independent — no plan's code needs the other's to exist, and there is exactly one shared file.** Plan 10 touches `packages/domain/src/index.ts`, `packages/domain/src/ai-accounting.db.test.ts`, `packages/domain/src/pr-review-publication.db.test.ts` (new), `apps/worker/src/worker.ts`, `apps/worker/src/pr-ai-review-error-logging.test.ts` (new), `.github/workflows/ci.yml`. Plan 11 touches `packages/database/migrations/061_*.sql` (new), `packages/database/src/va-jobs-platform-reconciliation.db.test.ts` (new), `packages/project-config/src/index.ts` + its test, `packages/git-runner/package.json` + `src/index.ts` + its test, `apps/web/src/server.ts`, `apps/web/src/merge-route-regressions.test.ts`, `apps/worker/src/provider-jobs.test.ts`, **and `.github/workflows/ci.yml`** — plan 11's Task 1 Step 6 wires its own new `.db.test.ts` file into the same CI step plan 10 also edits, for the identical reason (CI silently skips any `*.db.test.ts` file not explicitly listed there). Neither plan's tasks reference a type, function, or table the other plan introduces. Both can start immediately, in parallel, with zero coordination required at implementation time.

**The one shared file:** `.github/workflows/ci.yml`, specifically the "Deployment database tests" step's file-list line — plan 10 adds `ai-accounting.db.test.ts` + `ai-usage.db.test.ts` + `pr-review-publication.db.test.ts`; plan 11 adds `va-jobs-platform-reconciliation.db.test.ts`. Both additions are new, disjoint filenames appended to the same space-separated list — a trivial line-adjacent (not logic) conflict at worst. Whichever plan's PR merges second should rebase onto the first's `ci.yml` change and confirm the merged file lists both plans' additions rather than dropping either side.

---

## What can run in parallel

**Both plans can be implemented fully in parallel** — two independent agents/worktrees against current `master`, starting immediately. Neither plan's tasks depend on the other landing first, at either the implementation or the merge stage.

---

## Recommended execution order

No ordering constraint exists between plan 10 and plan 11 — assign both to start at the same time. Suggested order is by whichever finishes review first, not by any dependency:

1. **10 — AI PR review parameter type error** (root-cause SQL fix in one file, a test-fixture bug fix, a CI wiring change, one small logging addition, and new regression tests — no schema migration, low blast radius, safe to merge as soon as reviewed).
2. **11 — VA Jobs Platform pre-flight placeholder path** (includes a live data-reconciliation migration that must actually be *run* against every real environment after merge — see Manual/deploy actions below — plus code hardening; slightly higher operational follow-through than plan 10, but no dependency ordering requirement, just sequence it after 10 if only running one reviewer at a time).

If a rebase is needed between the two PRs, it will only ever be the shared `.github/workflows/ci.yml` file-list line noted above — read both diffs before resolving, keep both plans' filenames in the merged list, but expect it to be trivial.

---

## Expected PR boundaries

Two PRs, both against `dutchbase/dev-control` `master`:

1. `fix: cast recordAiUsage's ambiguous bigint/numeric parameters, add regression coverage` (plan 10) — touches `packages/domain/src/index.ts`, `packages/domain/src/ai-accounting.db.test.ts`, `packages/domain/src/pr-review-publication.db.test.ts` (new), `apps/worker/src/worker.ts`, `apps/worker/src/pr-ai-review-error-logging.test.ts` (new), `.github/workflows/ci.yml`.
2. `fix: reconcile and guard against va-jobs-platform's placeholder repository path` (plan 11) — touches `packages/database/migrations/061_va_jobs_platform_placeholder_path_reconciliation.sql` (new), `packages/database/src/va-jobs-platform-reconciliation.db.test.ts` (new), `packages/project-config/src/index.ts` + test, `packages/git-runner/package.json` + `src/index.ts` + test, `apps/web/src/server.ts`, `apps/web/src/merge-route-regressions.test.ts`, `apps/worker/src/provider-jobs.test.ts`, `.github/workflows/ci.yml`.

Do not combine these into one PR — unrelated bugs, unrelated code paths, unrelated reviewers' natural scope (backend query/accounting logic vs. project-config/git-runner path validation). The two plans' only overlap is the shared `.github/workflows/ci.yml` line described in the Dependencies section above, which is not a reason to combine them — it's a routine rebase, not a coupling.

---

## Manual / deploy actions required after merging

- **Plan 11's migration must actually be run against every real environment, not just merged as code.** `061_va_jobs_platform_placeholder_path_reconciliation.sql` is a live data fix — merging the PR does nothing to the actual stuck `va-jobs-platform` row until the migration runner executes against that environment's database. Plan 11's Task 1 Step 5 requires the executing agent to run the live-verification query both *before* (to determine which of the three documented outcomes applies) and *after* (to confirm the result) applying it, and to report explicitly to the user which outcome occurred:
  - If a duplicate project row was found and reconciled automatically — confirm and report the source/target project ids.
  - If the `va-jobs-platform` row's path was already correct — no action needed, report that plan 11's other hardening (Tasks 2-3) is still valuable defense-in-depth even though nothing needed reconciling.
  - If no other row had a real path anywhere (outcome (a) in plan 11) — **an admin must still manually set a real "Local repository path" on the "VA Jobs Platform" project via the Projects page** after this PR deploys; the migration cannot invent a path that doesn't exist anywhere in the data. Report this explicitly as a required manual follow-up, not an automatic fix.
- **Plan 11 deliberately does not add a `UNIQUE (github_owner, github_repository)` constraint** on `projects` (would prevent this exact bug class at the schema level but is a larger, unaudited behavior change) — flag this to the user as a reasonable follow-up ticket, along with a Projects-page UI warning for duplicate-repo rows (also deliberately out of scope). Neither is required for this fix to work.
- **Plan 11 deliberately does not delete or rename whichever duplicate project row survives reconciliation** (if the duplicate-row scenario applies) — that is a data cleanup decision for a human, not something to automate. Report which two rows exist (if any) so the user can decide.
- **Plan 10 requires no migration and no manual data action** — the CI wiring change (adding three previously-unwired `.db.test.ts` files — `ai-accounting.db.test.ts`, `ai-usage.db.test.ts`, `pr-review-publication.db.test.ts` — to the "Deployment database tests" step) takes effect automatically on the next CI run after merge; no separate action needed.
- No other manual action, deploy step, or synchronization is required by either plan.

---

## Orchestrator execution instructions

When executing this plan set:

1. Use the **`relay`** skill to route each plan's implementation work through it (plan → workhorse execution → independent frontier review), per the relay skill's own preflight/routing rules.
2. Use the **`ponytail`** skill during execution — favor the lazy/minimal correct implementation at every step; do not let executing agents gold-plate beyond what each plan's tasks specify (in particular: plan 11 explicitly scopes out a `UNIQUE` constraint and a Projects-page duplicate-row warning as follow-ups, not this-PR work — do not let an agent add them anyway).
3. Use the **cheapest capable agent** for each task:
   - Mechanical, low-risk tasks (plan 10's Task 2 fixture-UUID find/replace, plan 10's Task 3 CI-file one-line edit, plan 11's Task 2 predicate-function addition once the pattern is established) → cheapest/fastest capable agent.
   - Tasks requiring careful multi-context reasoning or live-data verification with branching outcomes (plan 10's Task 1 — the core SQL cast fix, verify the exact parameter contexts before editing; plan 11's Task 1 — the data-reconciliation migration, which requires actually querying live data and branching on the result rather than assuming a single outcome) → a stronger/frontier agent.
   - Do not default every task to the most expensive model — match cost to the task's actual complexity, per each plan's own task breakdown.
4. **Parallelize both plans** — they have zero file overlap and no functional dependency (see Dependencies above); assign one agent/worktree per plan and start both immediately.
5. **Use separate repo-specific agents for cross-repo tasks** — not applicable to this plan set: both plans touch only `dutchbase/dev-control`. Plan 11 reads/writes `va-jobs-platform` only as *data* inside `dev-control`'s own database (a project row's `github_owner`/`github_repository` value) — it never opens a PR, commits code, or requires credentials against the `dutchbase/va-jobs-platform` repository itself.
6. Give each plan's agent its own isolated git worktree/branch (per this repo's own `.claude`/`.worktrees` convention) so the two implementations don't collide on disk while in progress, even though they have no file overlap.
7. **Follow dependencies** — there are none between these two plans; both may merge in either order. If both PRs are open simultaneously, rebase whichever merges second onto the first only if the one-line `.github/workflows/ci.yml` conflict noted above actually occurs.
8. **Create PRs in the correct repository** — both PRs go to `dutchbase/dev-control`; neither plan ever targets `dutchbase/va-jobs-platform`.
9. **Do not merge any PR automatically** — open them and stop; a human merges after review.

### Required final report to the user

After both plans have been executed and PRs created, the orchestrator must tell the user:

- **Which PRs were created and in which repo** — both in `dutchbase/dev-control`; give each PR's URL/number.
- **The exact recommended merge order** — no hard requirement either way (see Recommended execution order above); state that explicitly rather than implying a false dependency.
- **Which PRs depend on others** — none functionally; note only the one soft `ci.yml` line-overlap risk from the Dependencies section.
- **Whether rebasing is needed** — only the possible one-line `.github/workflows/ci.yml` conflict if both PRs are open at once; otherwise no rebasing expected.
- **Whether any deploy, migration, synchronization, or other manual action is required** — yes, critically: plan 11's migration `061_va_jobs_platform_placeholder_path_reconciliation.sql` must be **run** (not just merged) against every real environment, and the orchestrator must report which of the three documented outcomes actually occurred there (auto-reconciled / already-fine / needs-manual-admin-path-entry) per the Manual/deploy actions section above. Also restate plan 11's two deliberately-out-of-scope follow-ups (the `UNIQUE` constraint, the Projects-page duplicate-row warning) as candidate future tickets.
- Any deviation from a plan's tasks that the executing agent had to make, and why (e.g., if plan 11's Task 1 Step 1 live-data query revealed an outcome different from what the migration's guard logic was designed around, or if a referenced file:line had drifted since this plan was written).

---

## Post-execution verification

After PRs are opened (not merged), use the published HTML verification checklist artifact:

**https://claude.ai/code/artifact/2afad2a2-a25a-49d3-81f1-ffdecffde30d** ("AI Review & Pre-flight Fixes")

It's generated directly from plans 10 and 11's own tasks and acceptance criteria, not from the executing agents' self-reported summaries — grouped by plan, with per-item route/file context, per-plan and overall progress tracking (saved locally in the reviewer's browser), and a "must still hold" callout per plan for its key invariants. If either plan's scope changes materially during execution (not just a drifted line number), regenerate the checklist from the updated plan text before using it to verify that plan's PR.
