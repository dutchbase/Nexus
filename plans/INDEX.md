# dev-control Plans — Execution Index

Single repo affected by everything below: **`dutchbase/dev-control`** (this repo). Plan 04 also *talks to* the external repo `dutchbase/va-jobs-platform` via the GitHub API at runtime (reading its branches/workflow runs, moving its `production` ref) — it never modifies `va-jobs-platform`'s own source or requires a PR against it. Plan 06 and 07 are the only plans that touch GitHub repository metadata (topics/description, via `gh`) rather than only code — see plan 07's Task 6.

All 9 active plans are covered:

| # | Plan file | Source task |
|---|---|---|
| 01 | `01-github-policy-merge-eligibility.md` | Allow PR merging when GitHub policy snapshots are unavailable |
| 02 | `02-notification-event-badge-overlap.md` | Fix event name and status badge overlap on Notifications event rules |
| 03 | `03-admin-dashboard-viewport-fill.md` | Make `/admin` dashboard cards fill the viewport with internal scrolling |
| 04 | `04-va-jobs-platform-production-promotion.md` | Add Production deployment tab to Merge page with `va-jobs-platform` promotion workflow |
| 05 | `05-repository-dirty-diagnostics.md` | Add actionable diagnostics for `repository_dirty` project status |
| 06 | `06-nexus-rebrand-and-visual-refresh.md` | Rename the application to Nexus, remove Internet Nederland branding, and apply the modernized shadow/focus/interaction/sidebar/logo/status-dot/CTA visual system |
| 07 | `07-open-source-release-readiness.md` | Prepare the repository for public open-source release: README, LICENSE, CONTRIBUTING, issue/PR templates, `.env.example`, secret audit, hardcoded-path audit, GitHub repo metadata |
| 08 | `08-ai-pr-review-defaults-save-error.md` | Fix false `internal error` when saving AI PR Review Defaults (model/reasoning/auto-review/auto-merge) |
| 09 | `09-pull-requests-bulk-actions.md` | Add bulk actions (AI review, Close PR, Approve & merge) to the Pull Requests page |

Every task from the original brief (the pre-existing 5-task brief, the 2026-08-27 Nexus/open-source brief, and the 2026-08-27 second-session brief covering the AI PR review defaults bug and PR bulk actions) maps to exactly one plan above — none were split, merged with each other, or left uncovered. Plans 06 and 07 were written from direct, fresh codebase investigation (not from agent self-report) — see each plan's own "Ground truth from investigation" notes for exact file:line citations. Plans 08 and 09 were likewise written from direct investigation in their own session (three dedicated read-only investigation passes — the save-flow root cause, the PR page/merge/AI-review/close machinery, and the exact merge-eligibility computation in `prs.ts` — each independently confirmed against the live file contents before the plan text was written, not taken from agent self-report).

Plans 01, 02, 03, and 05 were reviewed against fresh, independent codebase investigation in this session (direct code reading, not just agent self-report) — all four were found accurate and complete; plan 01 received no changes (independently re-verified against the real `pull-request-policy.ts`/`pull-request-sync.ts`/`pr-merge.ts` code — its diagnosis and fix are correct); plan 02 was independently re-verified against the real `design-tokens.css`/`notifications.ts` code and confirmed correct (the `.event-row` CSS shipped in commit `290f7b6` already looks structurally sound — the plan's live-verification step is the right next action, not a further code change).

**Plan 04 was rewritten during this session after independent investigation contradicted its first draft.** An earlier draft proposed a brand-new parallel table/job-type system for production promotion; two independent, fully-cited investigations of the actual PR #49 code (already merged, already shipping a generic `deployment_status_snapshots`/`production_releases`/`deployment.*`-job promotion system whose core ref-write primitive already matches this task's exact requirement) concluded that a parallel system would be a **safety regression** — two independent systems able to move the same `refs/heads/production` ref, each with its own single-flight guard. Plan 04 as it stands now **extends** the existing system (new `github_actions_jobs` deployment mechanism, opt-in per project) instead of duplicating it. If re-reading this index after a break: plan 04's migrations are `058_production_promotion_actions_tracking.sql` (additive columns) and `059_va_jobs_platform_project.sql` (seed data), not `057_production_promotions.sql` — trust the plan file itself over any older summary.

---

## Dependencies between plans

**Eight of the 9 plans are fully independent — no other plan's code needs to be merged first.** The one real functional dependency: **plan 09's Task 3 depends on plan 01.** Plan 01 extracts the inline PR-detail-page policy-eligibility computation (`apps/web/src/pages/prs.ts`, the `policyIssue`/`mergeBlocker` derivation) into a shared `derivePolicyStatus()` function in `packages/domain/src/pull-request-policy-status.ts`. Plan 09's bulk-merge pre-flight classifier needs that exact same underlying logic. Plan 09's Task 3 is written with an explicit conditional (check whether `packages/domain/src/pull-request-policy-status.ts` exists yet; import it if so, else use a clearly-flagged temporary duplicate) so plan 09 is not *blocked* on plan 01 — but **plan 01 should merge before plan 09** to avoid a diverging duplicate implementation ever existing, even briefly. All other tasks in plan 09 (Tasks 1, 2, 4-9) have zero dependency on plan 01 or any other plan.

Beyond that one case, plans share no new types, no new tables, no new functions with each other — the rest of what follows is **file overlap**, which creates *merge-order* risk (git conflicts / rebase need), not *functional* dependency:

| File | Touched by |
|---|---|
| `apps/web/src/server.ts` | 01 (rewires the `approve` action), 04 (adds 1 new route, `promote-force`, and adds `maxAttempts:1` to the existing `promote` route's enqueue call), 05 (adds 1 new route), **08** (wraps the `ai-review` settings-save handler's audit call, adds `RETURNING`), **09** (extracts `evaluateApproveEligibility`/`startAiReview` from the `approve`/`ai-review` PR-action handlers — the same handler plan 01 rewires — adds 2 new bulk routes, adds an `id` filter to the list route) |
| `apps/web/src/ui.ts` | 04 (adds a Production-tab script to the existing `/admin/merge` block), 05 (adds a diagnostics-dialog script near the existing `/admin/projects` block), **06** (rewrites the sidebar brand block, breadcrumb fallback, login page, header worker indicator, and public form header — see plan 06 Task 1/6), **08** (rewrites the `data-ai-review-settings-form` submit handler inside the `/admin/settings` block), **09** (adds a large new block scoped to `/admin/pull-requests`, the list page — distinct from the existing detail-page block) |
| `apps/web/src/design-tokens.css` | 02 (only if its live-verification step finds a real bug — see plan 02's constraints, likely no change), 03 (adds scoped `@media` dashboard rules), **06** (redefines `--shadow`, adds `--shadow-sm`/`--ring`, edits `.brand-mark`, `.sidebar`, `.button.primary`, global interaction/focus rules — see plan 06 Tasks 2-5, 7) |
| `apps/web/src/pages/prs.ts` | 01 (replaces the inline `policyIssue`/`mergeBlocker` derivation, lines ~50-72, with `derivePolicyStatus()`), **09** (adds a `classifyBulkMergeEligibility()` export — reads but does NOT modify the same `mergeBlocker` lines 01 rewrites; adds checkbox column + bulk toolbar + pre-flight `<dialog>` markup to the list view) — **this is the one file both plan 01 and plan 09 touch; see the note below** |
| `apps/web/src/pages/dashboard.ts` | **06 only** (adds a box-shadow to the existing active-run pulse dot at line 42) |
| `apps/web/src/pages/runs.ts` | **06 only** (adds a new active-run status dot near the existing `statusBadge` call) |
| `apps/web/src/pages/operate.ts` | **08 only** — no markup change needed (plan 08 reuses the existing `.error` div rather than adding a new element; verify no other plan is mid-flight on this file at merge time regardless, since it's small) |
| `tests/e2e/visual-sweep.spec.ts` | 02 (adds narrow-width assertions, only if needed), 03 (adds `/admin`-specific vertical-fill assertions), 04 (does not modify it unless it already sweeps `/admin/merge`) |
| `tests/e2e/ai-models.spec.ts` | **08 only** (extends the existing settings-save journey with no-reload/success-state/duplicate-submit assertions) |
| `tests/e2e/pr-actions.spec.ts` | **09 only** (adds bulk-selection/bulk-action journeys; does not modify the existing single-PR tests in this file) |
| `packages/domain/src/index.ts` (barrel file — confirmed present, uses `export * from "./<module>.ts"` per-file re-exports, e.g. `export * from "./pull-request-policy.ts"` at line 8) | 01 (adds `export * from "./pull-request-policy-status.ts"` + `.../pull-request-on-demand-sync.ts`), 04 (adds `export * from "./production-promotion-allowlist.ts"` + `.../production-promotion.ts`) |
| `packages/github-provider/src/index.ts` | **09 only** (adds `closePullRequest`, sibling to the existing `updatePullRequestBase`) |
| `apps/worker/src/provider-jobs.ts` | 04 (extends the existing `deployment.sync_status`/`promote_check`/`promote` handlers in place), **09** (adds a new `github.close_pull_request` job type/handler, sibling to the existing `github.merge_pull_request` block — both plans add disjoint blocks to this file) |
| `README.md` | **07 only** (full restructure — see plan 07 Task 6) |
| `package.json` | **07 only** (adds `"license": "MIT"`, `description`, `repository`, `homepage`, `bugs`, renames `name` to `"nexus"` — see plan 07 Task 1) |
| `deploy.sh`, `webhook-server.js`, `webhook-runner.sh`, `docs/DEPLOYMENT-RUNBOOK.md` | **07 only** (replaces the hardcoded `/home/deploy/projects/dev-control` default path and the real `vps-nederland` SSH host alias with generic values — see plan 07 Task 4) |
| `.lfd/dcc-build/`, `prompts/lfd-dev-control-center.md` | **07 only** (deleted from the tracked tree — see plan 07 Task 5) |
| `.gitignore` | **07 only** (un-ignores `.env.example`, ignores `.lfd/` — see plan 07 Tasks 2 and 5) |

None of these are the same lines — each plan adds new, disjoint blocks (new routes, new script sections, new `@media` rules, new export lines, new CSS custom properties, new markup within the same template-literal functions but at different string locations) — so conflicts, where they occur, are expected to be trivial line-adjacent conflicts, resolved by rebase, not logic conflicts. **Two places worth extra care at merge time:**
1. Plan 06 rewrites `ui.ts:62`'s sidebar brand markup and `design-tokens.css`'s `:root`/`.button.primary`/`.sidebar` blocks in the same general regions plans 04/05/09 add script tags and plans 02/03 add `@media` rules — read plan 06's diff against whichever of 02/03/04/05/09 already merged before resolving any conflict, rather than accepting either side blindly.
2. `apps/web/src/pages/prs.ts` — plan 01 and plan 09 both touch this file in the same function (`renderDetail`'s eligibility computation region and the list-rendering region immediately below it). They are functionally compatible (09 reads 01's extracted function; 09 never edits the lines 01 rewrites) but positionally close — **merge plan 01 before plan 09** (see Dependencies above) so plan 09's executor writes against the post-01 file shape from the start, rather than writing against pre-01 and then needing a rebase that touches the same function twice.

---

## What can run in parallel

**All 9 plans can be implemented in parallel** — spin up 9 independent agents/worktrees against current `master`, one per plan, right now. No plan needs to wait on another to *start* implementation. Plans 06 and 07 in particular have zero file overlap with each other and are the lowest-risk pair to run fully concurrently, including their merges — reorder them to the very front or back of the sequence below without changing anything else.

The one exception to "start immediately": **plan 09's Task 3 benefits from plan 01 having merged first** (see Dependencies above) — plan 09 can still *start* in parallel (Tasks 1, 2, 4-9 have no dependency), but whoever executes Task 3 should check whether plan 01 has landed and use its real `derivePolicyStatus()` export if so, rather than the documented fallback.

The rest of the serialization needed is at **merge time**, because of the shared-file table above.

---

## Recommended merge order

Smallest/lowest-risk footprint first, so each subsequent PR rebases against as little new churn as possible; the largest, most novel plans (09, then 04) go last so they're built on top of an already-stable set of the smaller changes rather than the reverse. Plans 06 and 07 are inserted where their actual file overlap puts them — 07 touches nothing any other plan touches, so it can merge literally anywhere in this order (placed first below, since it's pure docs/config and carries zero rebase risk); 06 touches `ui.ts`/`design-tokens.css` like 02/03/04/05/09 do, so it's placed after the smaller plans to minimize the rebase 06 has to do. Plan 08 is small/self-contained and slots in early. Plan 09 must merge after plan 01 (the one real functional dependency — see Dependencies above), so 01 is pulled forward of 06 in this ordering:

1. **07 — Open-source release readiness** (README/LICENSE/CONTRIBUTING/templates/`.env.example`/`deploy.sh`/`webhook-server.js`/`package.json`; zero file overlap with any other plan — merge whenever convenient, first is simplest)
2. **02 — Notification event badge overlap** (verification + regression test only; likely zero production-code diff)
3. **03 — Admin dashboard viewport fill** (`dashboard.ts` + scoped CSS + `visual-sweep.spec.ts`)
4. **05 — Repository dirty diagnostics** (`project-config`, `server.ts` new route, `projects.ts`, `ui.ts`, `shared.ts`)
5. **08 — AI PR review defaults save error fix** (`server.ts` one handler, `ui.ts` one form's submit handler, `operate.ts` unchanged, small/self-contained — no dependency on any other plan)
6. **01 — GitHub policy merge eligibility** (`domain`, `project-config`, `prs.ts`, `server.ts` `approve` route) — merge before 09, since 09's Task 3 wants `derivePolicyStatus()` to already exist.
7. **06 — Nexus rebrand and visual refresh** (`ui.ts`, `design-tokens.css`, `dashboard.ts`, `runs.ts`) — merge after 02/03/05/08 so its `ui.ts`/`design-tokens.css` rewrite lands on top of their smaller, already-settled additions rather than forcing them to rebase a large branding/CSS diff.
8. **09 — Pull Requests bulk actions** (new `github.close_pull_request` job + provider function, extraction of `evaluateApproveEligibility`/`startAiReview` in `server.ts`, new bulk routes, `prs.ts` list-page markup + classifier, large `ui.ts` addition) — merge after 01 (real dependency) and after 06 (so its large `ui.ts` addition lands on the post-rebrand file rather than forcing 06 to rebase around it); rebase onto the tip of 01/05/06/08 first, since it touches `server.ts`, `ui.ts`, and `prs.ts`, all already modified by earlier merges in this order.
9. **04 — VA Jobs Platform production promotion** (2 new migrations, 1 new provider file + edits to 2 existing provider files, 2 new domain files + edits to `project-config`, edits to the existing worker job handlers, 1 new route + 1 edited route, `merge.ts`/`ui.ts` restructure) — merge last; rebase onto the tip of everything above first, since it touches `server.ts`, `ui.ts`, `apps/worker/src/provider-jobs.ts`, and (if it exists) `packages/domain/src/index.ts`, all already modified by earlier merges in this order.

**Rebasing is expected to be needed** for every PR after the first one merges, specifically wherever the file-overlap table above lists more than one plan touching the same file. Each rebase should be a small, mechanical conflict (adjacent added lines), not a logic rewrite — if a rebase produces anything larger than that, stop and re-read both diffs before resolving, don't guess. Two rebases are most likely to need actual attention (not just adjacent-line auto-resolve): plan 06's rebase onto 02/03/05/08 (both 06 and those plans touch `ui.ts`/`design-tokens.css` in structurally similar areas — page-shell markup, CSS rule blocks), and plan 09's rebase onto 01/06 (`prs.ts`'s eligibility-computation region and `ui.ts`'s large template-literal structure both get touched by more than one plan) — read both diffs before resolving either.

---

## Expected PR boundaries

One PR per plan, nine PRs total, all against `dutchbase/dev-control` `master`:

1. `docs: prepare repository for open-source release` (plan 07)
2. `fix: verify and guard against notifications event-row overlap` (plan 02)
3. `feat: fill admin dashboard cards to viewport height with internal scroll` (plan 03)
4. `feat: actionable repository_dirty diagnostics on Projects page` (plan 05)
5. `fix: don't report internal error when AI PR review defaults save succeeds` (plan 08)
6. `fix: allow merge when no applicable GitHub policies are configured` (plan 01)
7. `feat: rename to Nexus and modernize the visual system` (plan 06)
8. `feat: add bulk actions (AI review, close, approve & merge) to Pull Requests page` (plan 09)
9. `feat: VA Jobs Platform production promotion (Production tab on Merge page)` (plan 04)

Do not combine any of these into one PR — they are unrelated features/fixes with independent review surfaces, per each plan's own scope. In particular, do not fold plan 06 (visual/branding) and plan 07 (docs/OSS-readiness) into a single PR even though they're thematically related ("the Nexus rebrand") — they have different reviewers' natural scope (UI/CSS vs. docs/repo-metadata) and, per the file-overlap table, no file-level reason to be combined. Likewise, plan 08 (a bug fix) and plan 09 (a new feature) both touch the Pull Requests/AI-review surface area but are unrelated in scope and must stay as separate PRs.

---

## Manual / deploy actions required after merging

- **Plan 02 requires an operational check, not just a merge**: its Task 1 explicitly investigates whether the *already-deployed* server process is serving a stale in-memory copy of `design-tokens.css` from before commit `290f7b6` (this app loads its CSS into memory once at process startup, see `apps/web/src/ui.ts:5-6`, and serves it with a 300s cache). **Whoever executes plan 02 must report back explicitly whether a server restart/redeploy is needed** to actually fix the originally-reported bug in production, independent of whether any code changes were made. **The same stale-in-memory-CSS mechanism applies to plan 06** — after plan 06 merges and deploys, restart/redeploy is required for the new visual system to actually take effect in production, not just in a fresh `pnpm dev`.
- **Plan 04 needs two DB migrations applied** on every environment before its worker jobs/routes go live: `058_production_promotion_actions_tracking.sql` (additive columns on the existing `deployment_status_snapshots`/`production_releases` tables — low risk) and `059_va_jobs_platform_project.sql` (seeds/updates the `va-jobs-platform` project row with its deployment config — **the executing agent must first check whether a `va-jobs-platform` row already exists with different `github_owner`/`github_repository`/`default_branch` values**, per that migration's own Step 1, and flag any discrepancy to the user before it applies rather than silently overwriting).
- **Plan 04 needs GitHub credential/permission verification** in whatever environment runs the worker: `contents:write` on `dutchbase/va-jobs-platform` (for the production ref PATCH), `actions:read` (for workflow run/job lookups), and optionally `read:packages` (for the GHCR manifest check — the feature degrades gracefully without it: GHCR is advisory-only in this plan's design, never blocking, but confirm that's actually exercised in the target environment, not just unit-tested).
- **Plan 04's `repository_path` placeholder**: migration 059 seeds the `va-jobs-platform` project row with a placeholder `repository_path` (the Production-tab feature itself never reads it — it resolves master/production SHAs live via the GitHub API — but other dev-control features for this project, like the generic Merge-branches dropdown or planning/execution, would need a real local clone path). Not a blocker for this feature; flag it so it isn't forgotten if those other features are ever wanted for this project.
- **Plan 04 flags a known, intentionally-unfixed residual risk**: `apps/web/src/pages/projects.ts:127-136` has a pre-existing "Merge branches" panel on the project Overview tab that can still push a merge commit onto any branch including `production`, bypassing this feature's safeguards. Plan 04 deliberately does not touch it (out of its scope per its own constraints) — this should become a follow-up ticket.
- **Plan 07 needs a `DCC_ROOT` environment variable verified** on every environment that runs `deploy.sh`/`webhook-server.js`/`webhook-runner.sh` (the built-in auto-deploy flow) **before that PR deploys** — plan 07's Task 4 changes the hardcoded fallback default from `/home/deploy/projects/dev-control` to the generic `/opt/nexus`. This does **not** fail closed: if the current production host relies on the old implicit default and does *not* already have `DCC_ROOT` set explicitly in its systemd/pm2/webhook environment, the next deploy webhook invocation will silently fall back to `/opt/nexus` instead of the real checkout path. **Report this explicitly to the user as a required pre-deploy verification, not just a merge** — confirm `DCC_ROOT` is set on the real deploy host before this PR's deploy runs.
- **Plan 07's `gh repo edit` (description + topics) is the only "deploy" action for that plan that's actually a live write to GitHub, not a code change** — confirm it ran successfully (Task 7 Step 1) and report the before/after description+topics to the user, since this doesn't show up in a PR diff. Task 7 deliberately does not change repo visibility (stays `PRIVATE`) — flipping to public is a separate, explicit human decision the orchestrator must not make on its own, and should be surfaced to the user as an open follow-up once plan 07 merges.
- **Plan 07 removes `.lfd/dcc-build/` and `prompts/lfd-dev-control-center.md` from the tracked tree only, not from git history** — both reference the operator's real home-directory path and (per `docs/DEPLOYMENT-RUNBOOK.md`) the real SSH host alias `vps-nederland` remains in past commits. Flag to the user that a full history rewrite (`git filter-repo`/BFG) is a required decision before this repository is ever made public, independent of this PR merging.
- **Plan 08 flags (but does not fix) an identical latent bug** in the neighboring `POST /api/admin/settings/pull-request-merge` handler (`server.ts:864-869` as of plan 08's investigation) — same unguarded-`audit()`-after-write shape, out of scope for plan 08 since it's a different settings screen. Surface this to the user as a candidate follow-up ticket once plan 08 merges.
- **Plan 09 requires no migration** (no new tables/columns — reuses existing `pull_requests`/`jobs`/`audit_events` columns and `metadata_json`/`payload_json` for batch correlation). The one thing to verify post-merge: the new `github.close_pull_request` job type needs the same GitHub credential scope the existing `github.merge_pull_request` job already uses (no new scope required — it's a PR-state PATCH, same permission tier as the existing merge/base-update calls) — confirm this wasn't accidentally scoped differently in whatever environment runs the worker.
- **Plan 09 deliberately ships a reduced version of live batch progress** — the source task's mockup shows a live "2/5 complete" counter during bulk merge; plan 09 implements an immediate post-submit summary + page reload instead (see plan 09's own Self-Review Notes for the explicit reasoning: this codebase has no polling/WebSocket infrastructure to build genuine live progress on, and adding one would be over-engineering relative to how every other async action in this app already works). Flag this to the user as a known, intentional scope reduction — not a bug — when plan 09's PR is reviewed.
- No other plan requires a migration, a config change, or a manual data backfill.

---

## Orchestrator execution instructions

When executing this plan set:

1. Use the **`relay`** skill to route each plan's implementation work through it (plan → workhorse execution → independent frontier review), per the relay skill's own preflight/routing rules.
2. Use the **`ponytail`** skill during execution — favor the lazy/minimal correct implementation at every step; do not let executing agents gold-plate beyond what each plan's tasks specify.
3. Use the **cheapest capable agent** for each task:
   - Mechanical, low-risk tasks (adding a CSS media query, a barrel-file export line, a pure-data registry file, a Playwright assertion following an existing pattern, plan 08's frontend handler rewrite once the pattern is copied from the existing ticket-AI-config form) → cheapest/fastest capable agent.
   - Tasks requiring multi-file reasoning, new worker job logic, extraction refactors that must preserve exact existing behavior, or API route wiring with security implications (plan 01's Task 1, plan 04's Tasks 6/8/8b/9 — the allowlist, the worker job extension, and the force-promote route; plan 09's Task 2 — the `evaluateApproveEligibility`/`startAiReview` extraction, and Task 5 — the bulk routes) → a stronger/frontier agent.
   - Do not default every task to the most expensive model — match cost to the task's actual complexity, per each plan's own task breakdown and per the relay skill's own workhorse-vs-frontier routing.
4. **Parallelize independent plans where safe** — 8 of the 9 plans have no functional dependency on any other (see "What can run in parallel" above) and can start simultaneously. The one exception: plan 09's Task 3 should wait for plan 01 to land (or use its documented fallback if it truly can't wait) — everything else in plan 09 can start in parallel with plan 01.
5. **Use separate repo-specific agents for cross-repo tasks.** In this plan set, every code change targets a single repo, `dutchbase/dev-control` — no plan requires a PR against any other repository. Plan 04 is the one exception worth naming explicitly: it *reads and writes* GitHub state in `dutchbase/va-jobs-platform` at runtime (via the GitHub API — branch/workflow-run lookups, moving the `production` ref) but never opens a PR or commits code there, so no separate `va-jobs-platform` implementation agent is needed — only `dutchbase/dev-control` GitHub credentials with the scopes plan 04 itself lists (`contents:write`, `actions:read`, optionally `read:packages` on `va-jobs-platform`) are required for the *worker process*, not for a coding agent.
6. Regardless of the single-repo scope here, still give each plan's agent its **own isolated git worktree/branch** (per this repo's own `.claude` worktree convention already visible in `.worktrees/`) so the 9 implementations don't collide on disk while in progress, even though they'll need sequential rebase-and-merge per the order above.
7. **Follow dependencies** — implementation can be parallel per point 4 above, but **merging must happen one PR at a time, in the recommended order**, with each subsequent PR rebased onto the previous merge before it goes up (or before it's finalized, if opened earlier).
8. **Create PRs in the correct repository** — for this plan set, that is `dutchbase/dev-control` for all 9 plans; no other repository ever receives a PR from this plan set.
9. **Do not merge any PR automatically** — open them and stop; a human merges after review, in the recommended order.

### Required final report to the user

After all 9 plans have been executed and PRs created, the orchestrator must tell the user:

- **Which PRs were created and in which repo** — all 9 are in `dutchbase/dev-control`; give each PR's URL/number.
- **The exact recommended merge order** (as above: 07 → 02 → 03 → 05 → 08 → 01 → 06 → 09 → 04).
- **Which PRs depend on others** — the one functional dependency (09 needs 01 merged first, per Task 3) plus the file-overlap table above, so the human reviewer knows why the order matters even for plans with no true functional dependency.
- **Whether rebasing is needed** — for any PR at open-time, and whether further rebasing will be needed at merge-time given the recommended order (plan 06 onto 02/03/05/08, and plan 09 onto 01/06, are the two rebases flagged above as needing real attention, not just auto-resolve).
- **Whether any deploy, migration, synchronization, or other manual action is required** — the full list above: plan 02's server-restart/redeploy check (and the same stale-in-memory-CSS mechanism for plan 06), plan 04's two migrations + GitHub permission verification + the `repository_path` placeholder follow-up + the flagged `projects.ts` merge-commit risk, plan 07's `DCC_ROOT` pre-deploy verification + the live `gh repo edit` write + the git-history-rewrite follow-up, plan 08's flagged sibling-bug follow-up in the `pull-request-merge` settings handler, and plan 09's GitHub credential-scope confirmation for the new `github.close_pull_request` job + its intentionally-reduced live-progress scope note.
- Any deviation from a plan's tasks that the executing agent had to make, and why (e.g. if a referenced file/line number had drifted since the plan was written, or if plan 09's Task 3 landed before plan 01 and used the documented fallback).

---

## Post-execution verification

After PRs are opened (not merged), use the published HTML verification checklist artifact:

**https://claude.ai/code/artifact/8008bc7f-9f2e-4ea1-955b-465162923678** ("Nexus Verification")

It's generated directly from all 9 plans' own acceptance criteria (Global Constraints + each task's stated goal), not from the executing agents' self-reported summaries — grouped by plan, with per-item route/file context, per-plan and overall progress tracking (saved locally in the reviewer's browser), and a "must still hold" callout per plan for its key invariants. This checklist was generated once, ahead of execution, in the same session that wrote these plans; if any plan's scope changes materially during execution (not just a drifted line number), regenerate it from the updated plan text before using it to verify that plan's PR.
