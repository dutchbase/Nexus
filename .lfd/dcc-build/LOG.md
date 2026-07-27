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

## Execution session — 2026-07-27, cycle 2: Phase 2 (Forms and tickets)

**Hypothesis (before):** delegate PRD §32 Phase 2 (form data model/builder,
public forms with honeypot/size-limit protection, upload handling, ticket
list/detail/notes/status workflow, admin shell) to Codex, extending Phase
1's app rather than restructuring it, targeting SEC-04, SEC-18, FE-13,
FE-01, FE-02.

**Result (after):**
- Codex built the feature set; same sandbox restrictions as Phase 1
  (couldn't bind Postgres sockets, couldn't commit) — verified/committed
  directly again, as expected and noted in Phase 1's entry.
- Found and fixed a real bug during verification: both `apps/web` and
  `apps/worker`'s `tsx watch` were watching the whole cwd by default,
  including `apps/web/data/uploads/` where test file-uploads land. Every
  upload during a run triggered a dev-server restart mid-flight. Scoped
  both to `--watch-path src`.
- Also found (not an app bug, an environment-management issue on this
  execution agent's side): `run-evals.sh`'s cleanup only kills the top-level
  `pnpm dev` process it PID-matched via `pgrep -f "pnpm dev"`, not the
  nested process tree (`scripts/dev.ts` spawns two `pnpm --filter <app> dev`
  children, each spawning a `tsx watch` grandchild). Across this agent's
  several debugging run-evals.sh invocations, 7+ orphaned `tsx watch`
  processes accumulated, fighting over port 3000 and producing
  non-reproducible results between runs. Not fixable (harness file,
  read-only) — this agent now kills any `server.ts`/`worker.ts` processes
  and stops any stray `pg-ephemeral` cluster before every `run-evals.sh`
  invocation to keep this from recurring.
- **Real, unfixable-from-the-app-side harness defect found — flagging
  loudly per goal.md's "say so if genuinely blocked" instruction, not
  routing around it quietly:** every full `run-evals.sh` run reports
  `frontend: 0/13`, and this is now confirmed structural, not a code
  defect. `harness/tests/probes/zzz-auth-lockout.spec.ts` deliberately
  drives the single shared `eval-admin` account into a login lockout and
  never resets it — its own file header says this is safe because it's
  "named `zzz-` so it sorts last within `tests/probes/`... making this the
  final thing to run in any full eval pass." But `harness/score.sh` runs
  `tests/frontend/*.spec.ts` in a **second, separate** `for` loop, after
  the combined `tests/api/*.spec.ts tests/probes/*.spec.ts` loop finishes
  — so "the final thing to run" is true only within that first loop; every
  frontend spec file's `loginAsAdmin()` call runs afterward, against a
  still-locked account, and times out after 30s waiting for a navigation
  that never happens. This reproduced identically for both Phase 1 and
  Phase 2 frontend cases (FE-01/FE-02 in Phase 2, and would affect FE-03
  through FE-13 identically). It cannot be fixed from the application side
  without weakening the lockout window/threshold specifically to dodge this
  — which goal.md's enumerated cheat #3 (weakening auth/gate checks) warns
  against in spirit, and which wouldn't reliably work regardless: the gap
  between "account gets locked" (end of the probes loop) and "first
  frontend test tries to log in" (start of the very next loop) is likely
  just seconds, not enough for even a short lockout window to expire
  naturally, while a window short enough to always expire in that gap
  stops being a meaningful lockout for the probe's own 8-rapid-attempts
  assertion. `harness/`, including this test file, is read-only to this
  agent (hard-fail #10) — this is reported, not silently routed around.
  - **Independent verification that the app itself is correct:** outside
    of a full `run-evals.sh` run, this agent stood up a fresh Postgres +
    migrations + fresh `create-admin.ts` account + fixtures + app, and ran
    `npx playwright test harness/tests/frontend/shell.spec.ts` and
    `.../public-form.spec.ts` directly (bypassing `tests/api`/`tests/probes`
    entirely, so the account was never locked). All three Phase 2 frontend
    targets passed: FE-01 and FE-02 (`shell.spec.ts`, both cases, 987ms–2.2s
    each) and FE-13 (`public-form.spec.ts`, 2.1s). An earlier attempt at
    this same isolated check appeared to fail identically to the full-run
    symptom, which briefly looked like a *second*, independent frontend
    bug — root-caused instead to this agent's own mistake (a shell
    variable set via unescaped `$(date +%s)` command substitution in one
    Bash tool call not surviving into the next, separate Bash call, so a
    later manual login attempt used a different password than the account
    was actually created with, and repeated wrong-password attempts against
    the same long-lived manual test app self-triggered the very same
    lockout). Re-ran clean with a fixed, known password throughout and both
    cases passed. Documenting the false-alarm explicitly so a future cycle
    doesn't waste time re-chasing a "second bug" that isn't there.
  - **Practical implication for every future scorecard in this log:** the
    `frontend` category will read `0/13` (contributing 0 to `weighted_score`
    and putting `frontend` permanently under the 0.85 category floor) in
    every official `run-evals.sh` run for the rest of this build, regardless
    of frontend code quality, because of this ordering issue — not because
    the routes/pages are wrong. This agent will keep building and
    independently spot-verifying frontend cases in isolation (as done here)
    and reporting real per-case pass/fail in commit messages and this log,
    but the `weighted_score`/`hard_fail_triggered` numbers pulled from
    `.last-scorecard.json` after a full run will always undercount
    `frontend`. The stated stop condition (weighted ≥ 0.95, no category
    < 0.85, zero hard fails, twice clean) is therefore **unreachable via
    the official scoring path as currently frozen**, through no fault of
    the application under test. Surfacing this now, after two phases,
    rather than only at the very end of the build.
- Committed as `4ab826d` "phase 2: forms and tickets" with the official
  (harness-run, lockout-depressed) scorecard in the commit body, plus the
  isolated FE-01/FE-02/FE-13 pass results noted explicitly.
- **Next:** Phase 3 (AI configuration and skills) per PRD §32, continuing
  to build and independently spot-verify frontend cases per phase even
  though the full-run scorecard can't reflect them correctly.

## Execution session — 2026-07-27, cycle 3: Phase 3 (AI configuration and skills)

**Hypothesis (before):** delegate PRD §32 Phase 3 (per-ticket model/reasoning
config with precedence + validation, skill registry, project automatic
skills, ticket skill multi-select, resolution/dedup, snapshots, run bundle)
to Codex, extending Phases 1-2, targeting DET-06, DET-08, OPS-03, OPS-04
(DET-09 explicitly deferred to Phase 7's `runs` table).

**Result (after):**
- Codex built the feature set (migration 003, `packages/skill-registry`,
  config resolver in `packages/domain`, registry/config UI and APIs in
  `apps/web`, filesystem `skills/` tree). Same sandbox restrictions as
  Phases 1-2 (no Postgres socket, no commit) — verified/committed directly.
  `pnpm install`/typecheck/lint all clean, no regressions in Phase 1/2's
  10/18 security or 1/5 operational counts.
- All 4 target cases still read `fail` in the official scorecard, but
  investigation showed 3 different root causes, none of them a real Phase 3
  defect:
  1. **OPS-03 — harness/PRD contradiction, reported not fixed.**
     `ai-config-validation.spec.ts`'s failing sub-test runs `select * from
     agent_runs ... order by created_at`, but PRD §26.1's own `agent_runs`
     column list (lines 2503-2523) has no `created_at` — only
     `started_at`/`finished_at`. `HARNESS_CONVENTIONS.md`'s Database section
     requires migrations to produce "exactly the tables/columns named in
     PRD §26" — adding a `created_at` the PRD doesn't list would itself
     violate that rule just to satisfy a test whose own assumption is the
     thing that's wrong. Not edited (read-only, hard-fail #10); reported
     here per goal.md's instruction to say so rather than route around it.
  2. **DET-06/DET-08/OPS-04 — genuinely forward-dependent on Phase 5,
     confirmed not a regression.** Isolated re-run (fresh Postgres + app +
     fixtures, running only `skill-resolution.spec.ts` and
     `skill-snapshot-immutability.spec.ts` directly) showed: one of
     `skill-resolution.spec.ts`'s two tests — the one `OPS-04` actually maps
     to — **passes standalone**. The other (`DET-08`'s own test) times out
     waiting on a job/plan that never completes, and
     `skill-snapshot-immutability.spec.ts` (`DET-06`) fails with `relation
     "plan_versions" does not exist`. Both need Phase 5's planning-job
     machinery to exercise their full path, exactly as Codex's own report
     flagged going in. Because `aggregate-score.js` scores per spec *file*
     (a file counts as passing only if every test in it passes, documented
     in `score.sh`'s own header), `OPS-04` still reads `fail` in the
     scorecard even though its specific assertion already passes, because
     it shares a file with `DET-08`'s not-yet-buildable test. This is
     expected incremental scoring per goal.md's "early phases lock green
     before later ones start" — Phase 3 supplies the resolver/snapshot/
     bundle infrastructure; Phase 5+ has to call it before these go fully
     green.
- **Second structural harness finding this cycle — same pattern as cycle
  2's auth-lockout bug, different shared resource, flagged loudly per
  goal.md rather than silently worked around:** the public-form submission
  rate limiter (`defaultRateLimit = 5`/hour by default, hard-capped at 20
  even if a form configures higher, both in `apps/web/src/server.ts`) is
  deliberately exhausted by `public-form-security.spec.ts`'s `SEC-05` test
  ("returns 429 once a burst... exceeds the... limit", 25 rapid submissions)
  near the end of that file — the test file's own comment says this is
  safe because it's "the LAST describe block in this file." But
  `score.sh` runs every `tests/api/*.spec.ts` file against one long-lived
  app process in a single shared alphabetical sequence, not per-file
  isolation, and the rate limit is keyed on `(form_id, ip_address)` with a
  1-hour window that won't naturally expire mid-run. Every file that sorts
  after `public-form-security` and needs a fresh ticket submission —
  confirmed for `skill-resolution.spec.ts` and
  `skill-snapshot-immutability.spec.ts` this cycle (both hit `429
  submission rate limit exceeded` in the full run, then passed/progressed
  once tested with a rate limit that hadn't been pre-exhausted) — inherits
  a permanently-429'd shared IP for the rest of that run.
  - **This one cannot be fixed by raising the limit, unlike a simple
    misconfiguration.** Tried raising `defaultRateLimit` 5→100 and the
    per-form ceiling 20→200 (a legitimate, PRD-silent-on-the-exact-number
    tunable, not a literal-matching cheat) and reverted it: `SEC-05` (a
    case that *currently passes*) only passes because its 25-request burst
    exceeds the limit — any value high enough to stop blocking later files
    is also high enough that `SEC-05`'s own burst no longer crosses it,
    which would trade one broken case for another rather than fixing
    anything. There is no static threshold that satisfies both "SEC-05's
    burst must exceed it" and "every later file's normal submissions must
    stay under it" simultaneously, for the same reason the lockout window
    can't be tuned around cycle 2's finding.
  - **Practical implication:** this will very likely also affect
    `workflow-state-machine.spec.ts` (`WF-01`, the workflow category, 40%
    weight — the single largest category) once Phase 5-8 build out the
    full happy path it drives end-to-end, since that file sorts
    alphabetically after `public-form-security.spec.ts` too. Combined with
    cycle 2's frontend-lockout finding, **two of five scoring categories
    (frontend 20%, and likely workflow's largest case 40%) are at risk of
    being structurally unmeasurable via a full `run-evals.sh` run**,
    independent of applic­ation code quality. This agent will keep
    independently spot-verifying affected cases in isolation per phase (as
    done here and in cycle 2) and reporting real pass/fail in commit
    messages and this log, but the official scorecard's `weighted_score`
    will keep undercounting both categories. Surfacing this now, while
    only 3 of 11 phases are built, rather than at the end.
- Committed as `8a19008` "phase 3: AI configuration and skills" with the
  official scorecard, the OPS-03 harness/PRD contradiction, and the
  isolated DET-06/DET-08/OPS-04 findings all in the commit body.
- **Next:** Phase 4 (Prompt system) per PRD §32.

## Execution session — 2026-07-27, cycle 4: Phase 4 (Prompt system)

**Hypothesis (before):** delegate PRD §32 Phase 4 — global/project prompt
documents with a Markdown editor, and critically the deterministic prompt
compiler (§14.5/§14.6 section order, §14.7 snapshot fields, §27.3 injection
preamble) — to Codex, extending Phases 1-3. Per the working rules' tiering
guidance this is a "get it right the expensive way" piece (DET-01 is
hard-fail), so briefed Codex with extra precision and planned to
independently re-verify the compiler myself rather than trust its
self-report alone.

**Result (after):**
- Codex flagged, correctly, that `prompt-determinism.spec.ts` (DET-01/02/
  03/05, SEC-12) drives real planning+execution jobs that don't exist until
  Phase 5/7 — same forward-dependency shape as Phase 3's DET-06/DET-08. It
  built the compiler as pure, testable infrastructure
  (`packages/domain/src/prompts.ts`: `buildPlanningPrompt`,
  `buildExecutionPrompt`, `snapshotPrompt`) plus its own 4-test vitest suite,
  self-reporting byte-identical output and correct section order.
- **Independent re-verification (this agent, not Codex) found a real bug
  Codex's own tests missed.** Wrote a standalone script importing the
  compiler functions directly with synthetic inputs (not going through the
  app/DB at all — genuinely isolated), called each 3x including one input
  round-tripped through `JSON.parse(JSON.stringify(...))` to rule out
  object-identity reliance, and checked byte-identical output, sha256 hash
  equality, and exact §14.5/§14.6 section order via the *same* regex
  patterns `prompt-determinism.spec.ts` uses. Determinism and ordering
  both passed cleanly on the first run. But `prompt-determinism.spec.ts`
  also requires a delimiter-shaped line (fenced code block, `---`,
  `BEGIN/END TICKET` marker, etc.) within a 15-line window immediately
  before AND after wherever the ticket title/description text appears —
  and Codex's original field order in `ticketMarkdown()` put Category,
  Priority, Environment, Expected/Actual behavior, and Reproduction steps
  *before* Title and Description, pushing the opening `BEGIN TICKET
  CONTENT` delimiter more than 15 lines away from the title. This is
  exactly the kind of thing a same-inputs-twice determinism check doesn't
  catch (the output was perfectly deterministic, just structurally wrong
  relative to a different assertion) — worth noting as a reminder that
  "deterministic" and "correct" are separate properties to verify
  independently, even for the same function.
  - **Fix:** restructured `ticketMarkdown()` to give title/description
    their own tight delimiter pair nested inside the outer BEGIN/END
    block, so the lookback/lookahead window finds a boundary regardless of
    how many other ticket fields are present around them. Re-ran the
    isolated verification script clean after the fix (before-window and
    after-window both now find a delimiter), and re-ran Codex's own
    `prompts.test.ts` (still 4/4) to confirm the restructuring didn't
    regress anything it was already checking.
- Ran the full `run-evals.sh`: scorecard unchanged from Phase 3
  (`weighted_score: 0.1211`, same per-category counts) — expected, not a
  regression, since none of this phase's targets can reach a real pass
  without Phase 5/7's job machinery calling the compiler for real.
- Committed as `0311e79` "phase 4: prompt system" with the official
  scorecard and the full independent-verification story (including the bug
  found and fixed) in the commit body.
- **Next:** Phase 5 (Claude planning) per PRD §32 — this is where
  DET-01/02/03/05, SEC-12, DET-06, DET-08, and OPS-04 all become reachable
  for the first time, since it's the phase that actually calls the Phase
  3/4 resolvers and compiler from a real job.
