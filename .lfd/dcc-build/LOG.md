# Iteration Log — Development Control Center MVP build

Started: 2026-07-27 · Budgets: LFD design ~150k tokens / execution ~1.5M tokens total (per prompts/lfd-dev-control-center.md)

## Worktree / branch record

- Main checkout (read-only inputs live here): `/home/dutchbase/projects/dev-control-center`
- Baseline commit on `master`: `1fb411f` — "baseline: PRD, design handoff, prompts"
- Worktree: `/home/dutchbase/projects/dev-control-center/.worktrees/dcc-build`
- Branch: `lfd/dcc-build`
- All LFD design + harness construction happened inside this worktree, under `.lfd/dcc-build/`. Nothing was written to the main checkout or to `master`/`production`.

## LFD design session — 2026-07-27

- Read `prd.md` (35 sections, full) and `design-handoff/README.md` (full) directly; spot-checked `design-handoff/Development Control Center.dc.html` via targeted grep for exact mock-data fixture values (project/ticket/skill/PR/run/job/form rows) rather than a full read, per the prototype's own instruction that "the prototype wins on numeric disagreements" — grep was sufficient to extract the concrete literals needed for `harness/fixtures/seed.sql`.
- Environment has no `docker` binary. Adapted `docker-compose.eval.yml` (kept for portability) with a local-`initdb`/`pg_ctl` fallback in `harness/pg-ephemeral.sh`, auto-selected when Docker isn't reachable. Verified working end-to-end (schema load + seed load + row-count check) against a throwaway Postgres 17 cluster.
- Found and fixed a UUID-formatting bug in the hand-authored `seed.sql` (last group of several UUID literals was short of the required 12 hex digits) by actually loading the file against a verification schema — caught before handoff, not left for the execution agent to trip over.
- Caught and fixed a design flaw of my own: `seed.sql` originally pre-seeded a `users` row with a **hand-fabricated** Argon2id-shaped string. That string was never verified as real Argon2id output, so a login test against it would prove nothing. Fixed by removing the seeded user entirely — `run-evals.sh` now creates the eval admin via the real `scripts/create-admin.ts` (PRD §10), which exercises the actual hashing path. This is the kind of "harness that looks rigorous but tests nothing" failure mode the `superpowers:verification-before-completion` mindset exists to catch — noting it here since it's the closest thing to a near-miss in this session.
- Delegated mechanical, well-specified harness pieces to cheap-model (haiku) subagents in parallel: `mock-claude` CLI fake, `mock-github` HTTP server, `git-fixtures` generator. All three self-verified against explicit smoke-test checklists in their prompts and I spot-checked the ephemeral-Postgres/git-fixtures/seed integration myself afterward.
- Delegated the 31 frozen spec-as-test files (24 Vitest API/probe files + 7 Playwright frontend files) to 8 parallel sonnet/haiku subagents, grouped by eval-case relatedness, each given `HARNESS_CONVENTIONS.md` + `helpers.ts` + the exact `eval-cases.json` entries they were responsible for. This is a build-to-spec task (the PRD is the public spec, not a hidden ground truth), so the adaptation from the standard LFD dev/holdout split is: **eval-cases.json's 56 cases are the frozen "dev" contract** (visible, mined line-by-line from PRD §31/§35), and the **probes** (regenerated-input determinism check, gate-bypass curl, harness-integrity hash, mock-leakage, test-authenticity) play the holdout/anti-memorization role instead of a secret answer set — because there is no secret answer to hide here, only a public spec to satisfy honestly. See `goal.md` "Why this LFD's holdout looks different" for the full reasoning.
- Every subagent batch was told explicitly to report back any assumption it had to make about an undocumented route, field name, or file-path convention — because PRD §29 gives exact paths but not full request/response body shapes, and PRD §10's `data/` root isn't pinned to an env var name. Those assumptions are collected below as they come back, and are non-binding: if the execution agent's real implementation differs reasonably, that's a harness/spec mismatch to report, not a test to silently rewrite (hard-fail #10).

### Assumptions flagged by subagents (to review before/while the execution agent builds)

- Login CSRF token assumed to come back in the `POST /api/admin/login` JSON body (`csrfToken`/`csrf_token`); admin username/password field names assumed to be `input[name="username"]` / `input[name="password"]` in the login form.
- Plan-revision "reconfirm stale plan" action assumed to re-hit `POST /api/admin/plan-versions/{id}/approve`.
- `data/` root (worktrees, plans, skill-bundles) assumed relative to the monorepo root; no `DCC_DATA_ROOT` env var confirmed to exist.
- Mock-Claude scenario wiring (env var vs. job-payload field) left as an app-level choice, documented in `HARNESS_CONVENTIONS.md`; `apps/worker`'s own README must state which mechanism it uses.
- `PUT /api/admin/pull-requests/... /merge`-shaped hard-fail probe relies on the GitHub provider reading `GITHUB_API_BASE_URL` — this env var name is an LFD-side convention, not from the PRD; flagged for the execution agent to adopt.

(Full detail lives in each subagent's completion report from this session; nothing here is a scored requirement beyond what `eval-cases.json` and `goal.md` actually state — this section is operator context, not the spec.)

## Phase 6 verification — bugs found and fixed before handoff

Verification wasn't just "run it once and look" — three real defects were caught
by actually exercising the harness rather than reading it:

1. **Missing test file.** Cross-checking every `eval-cases.json` `test_ref`
   against the filesystem found `harness/tests/api/auth-guard.spec.ts`
   (SEC-01 — hard-fail — and SEC-02) had never been assigned to any of the 8
   parallel subagent batches. Written directly (see file header for the
   isolated-worker-process design and its `WORKER_START_CMD` escape hatch).
2. **Cross-file test-ordering hazard.** `auth-login.spec.ts`'s lockout
   sub-case would have locked out the single shared eval-admin account,
   breaking every other spec file's `login()` call that happened to run
   afterward (score.sh runs `tests/api/*` before `tests/probes/*`,
   alphabetically within each). Split into
   `tests/probes/zzz-auth-lockout.spec.ts`, named to sort last across the
   whole suite.
3. **`execution-validation.spec.ts`'s lint-failure marker wouldn't have
   propagated.** It wrote `.lint-should-fail` as an untracked, gitignored
   file into the *origin* fixture checkout — but `git worktree add` (the
   PRD §20.2-mandated isolation mechanism) only carries over *committed*
   content into a new worktree, not untracked files sitting in the source
   checkout. Fixed by force-adding and committing the marker onto the
   fixture's HEAD before triggering execution (and reverting via a
   follow-up commit), so it's actually present when the worker checks it
   out. Harmless across runs since `run-evals.sh` recreates every git
   fixture from scratch each time.
4. **`workflow-state-machine.spec.ts` (WF-01) assumed an empty diff would
   still be committed and PR'd** — defensible but not obviously correct,
   since a real implementation might legitimately refuse to publish a
   no-op change. Made the test write a real, trivial file change into the
   worker-created worktree once "Executing" is observed, so it exercises a
   genuine validation-passable diff instead of relying on that assumption.
5. **`lint.sh` had a live bug**: under `set -e -o pipefail`, two of its
   `m=$(cmd1 | cmd2)` assignments died silently whenever the second `grep`
   found nothing to filter (the common, non-violation case) — meaning
   `lint.sh` could exit 1 with **empty stdout** instead of reporting either
   a clean pass or `VOID: constraint violation`. Found by deliberately
   planting an `api.anthropic.com` literal and watching `lint.sh` produce
   no output at all. Fixed with `|| true` on both pipelines; re-verified the
   VOID message appears correctly, then reverted the planted violation and
   confirmed a clean pass.

Also verified, without finding further defects:
- `run-evals.sh` end-to-end, three full runs from a clean state: ephemeral
  Postgres starts/stops cleanly every time (including recovering from one
  interrupted run's leftover state), git-fixtures regenerate correctly,
  all 32 frozen spec files execute (each correctly fails pre-Phase-1, e.g.
  `Cannot find package 'pg'` / `@playwright/test` — expected on an empty
  `apps/`), scorecard is well-formed and consistent across runs
  (`weighted_score: 0.0222`, `hard_fail_triggered: true`,
  `pass_bar_met: false` — the two grep-probe cases pass trivially on an
  empty tree, everything else correctly fails), cleanup trap leaves no
  orphaned processes or state directories.
- Scorer calibration (synthetic file-status maps, not a real app): all-pass
  → `weighted_score: 1.0`, `pass_bar_met: true`. Hard-fail cases failing
  with everything else passing → `weighted_score: 0.657` but
  `pass_bar_met: false` and `hard_fail_triggered: true` — confirms a
  hard-fail VOIDs regardless of how good the weighted number looks, exactly
  per `goal.md`.
- Harness-integrity drift detection: ran `freeze-integrity.sh`, tampered
  `eval-cases.json`, confirmed `probe.sh --always` reports `[integrity]
  FAIL`, reverted, confirmed clean again. Re-froze once more after adding
  `harness/.gitignore` (the last file added), so the committed
  `.integrity.sha256` reflects the true final state.
- **Blinding check**: not applicable in the traditional LFD sense — there
  is no secret holdout answer set in this task to check readability of (see
  `goal.md` "Why this LFD's holdout looks different"). Nothing under
  `harness/` contains an answer the execution agent shouldn't be able to
  read; the anti-gaming mechanisms are structural (probes, grep checks,
  regenerated inputs) rather than secrecy-based.

## Final report (LFD design phase)

- **Deliverables produced this session:** `goal.md`, `LOG.md`,
  `EXECUTION_PROMPT.md`, and `harness/` — `mock-claude/`, `mock-github/`,
  `git-fixtures/`, `pg-ephemeral.sh` + `docker-compose.eval.yml`,
  `fixtures/seed.sql` + `seed.ts`, `eval-cases.json` (56 cases across 5
  weighted categories, 15 hard-fail), 32 frozen spec files (25 Vitest
  API/probe files + 7 Playwright frontend files) plus shared helpers,
  `lint.sh`/`score.sh`/`aggregate-score.js`/`probe.sh`/`status.sh`/
  `run-evals.sh`/`freeze-integrity.sh`, `HARNESS_CONVENTIONS.md`,
  `.integrity.sha256`.
- **What's next:** hand off to the execution agent via `EXECUTION_PROMPT.md`.
  Its first action already is to run `harness/run-evals.sh` from the clean
  worktree and confirm it reproduces the clean all-failing baseline
  documented above before writing any code, then proceed phase-by-phase per
  PRD §32.

## Execution session — 2026-07-27, cycle 1: Phase 1 (Foundation)

**Hypothesis (before):** confirm Stage 0 baseline matches goal.md's expected
"clean all-failing, not a crash" result, then delegate PRD §32 Phase 1
(monorepo, Postgres migrations, admin auth, audit log, project config
loader/validation, worker skeleton, transactional job queue) to Codex per
working-rule #4, targeting eval cases SEC-10 (admin login/argon2id/lockout),
SEC-11 (CSRF required on mutations), OPS-05 (PRD §10 scripts exist and run
clean) — the only Phase-1-scoped cases in `eval-cases.json` (WF-11, SEC-04,
SEC-09, OPS-02 touch job-queue/project-validation foundations but need
later-phase endpoints to go green).

**Result (after):**
- Baseline confirmed exact match to goal.md's Stage 0 spec:
  `weighted_score: 0.0222`, `hard_fail_triggered: true`, well-formed
  scorecard, exit non-zero, no crash.
- Delegated Phase 1 to `codex:codex-rescue` (background). Codex built the
  scaffold, migrations, auth/CSRF/audit-log, job queue, etc., but reported
  it could not verify against the real harness or commit: its managed
  sandbox denies TCP/Unix-socket binding (ephemeral Postgres couldn't
  start) and its linked worktree Git index was mounted read-only to it. This
  execution agent (running with real, unsandboxed Bash) does not have
  either restriction, so verification and commit were finished directly
  instead of round-tripping back through Codex — noted here since it's a
  deviation from "Codex does the execution," driven by an environment
  constraint on Codex's sandbox rather than a quality problem with its code.
- Verification surfaced two real bugs, both fixed directly (small,
  mechanical — not re-delegated per rule #4's "inadequate result" bar,
  since the application code itself was fine):
  1. `pnpm-workspace.yaml` had a broken placeholder
     (`allowBuilds:\n  esbuild: set this to true or false`) instead of a
     real boolean — pnpm's own auto-scaffold for an unapproved native build
     script (esbuild's postinstall), left unfinished. Every `pnpm install`
     regenerated the same broken placeholder until it was set to
     `allowBuilds: { esbuild: true }`, matching pnpm 11's actual expected
     shape (an `onlyBuiltDependencies` array, which was tried first, is not
     what this pnpm version reads — confirmed by a `[WARN] ... no longer
     read` on the equivalent `package.json#pnpm` field too).
  2. Root `package.json` had no `vitest`/`@playwright/test` devDependency
     anywhere in the workspace, so `harness/score.sh`'s `npx --yes vitest
     run` / `npx --yes playwright test` calls failed with a plain
     `vitest: not found` shell error for every spec file. Added both as
     root devDependencies (`vitest ^2.1.0`, `@playwright/test ^1.48.0`);
     `pnpm install` resolved and installed them cleanly (network access
     from this environment is fine — only Codex's own sandbox was
     restricted).
- After both fixes, `run-evals.sh` runs end-to-end (Postgres up, migrations
  run, `create-admin.ts` succeeds, fixtures seed, app boots, all 32 spec
  files execute, clean teardown). Scorecard: `weighted_score: 0.0656`,
  `hard_fail_triggered: true`. Category breakdown: workflow 0/11,
  security 5/18 (0.28), determinism 0/8, frontend 0/13, operational 1/5
  (0.20). Target cases SEC-10/SEC-11/OPS-05 all `pass`, plus SEC-15/16/17
  (grep probes for mock-service leakage / git-push / api.anthropic.com)
  pass on the clean tree. `hard_fail_triggered` stays `true` only because
  SEC-01 (worker must block a job when forbidden Claude-auth env vars are
  set) needs Phase 5's planning-job worker logic — expected at this point,
  not a regression.
- Committed as `478c69d` "phase 1: foundation" with the scorecard in the
  commit body.
- **Observation, not yet acted on:** `packages/database/native/argon2-helper.c`
  — Codex implemented Argon2id via a hand-written native C addon rather
  than an existing npm package (e.g. `argon2`/`@node-rs/argon2`). SEC-10's
  real-hash-and-verify round-trip passes, so it's functionally correct, but
  hand-rolled crypto is exactly the kind of thing ponytail rung 5
  ("already-installed dependency solves it") argues against, and it's
  worth a second look before Phase 11 hardening if time permits — flagging
  now rather than silently accepting it.
- **Next:** Phase 2 (Forms and tickets) per PRD §32.
