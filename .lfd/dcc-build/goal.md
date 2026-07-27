# Goal: Build the Development Control Center MVP (PRD v1.0) to a scored, hard-fail-free, production-safe standard

## Why this LFD's holdout looks different

This is a **build-to-spec** task, not a hidden-ground-truth task. `prd.md` and
`design-handoff/README.md` are the complete, public spec — there is nothing
to hide from you, and hiding the spec would make the task impossible, not
harder to game. The usual LFD dev/holdout split (visible cases vs. a secret
answer set) doesn't map cleanly onto "build a correct system to a public
spec," so it's adapted:

- **`harness/eval-cases.json`** (56 cases, mined line-by-line from PRD §31
  and §35, every §31 bullet covered) plays the role of the visible **dev**
  set — and also the "Stage 0 tests," since there is no separate lighter
  spec-test tier distinct from the eval here.
- **`harness/probe.sh`** plays the holdout/anti-memorization role: it
  regenerates fresh randomized ticket content every run (nothing to
  memorize), hits the live API directly with `curl` (no UI shortcuts
  possible), recomputes a SHA-256 manifest over every harness/eval file
  (drift = hard fail), and greps production build output for mock-service
  leakage. None of these are "secret answers" — they're mechanisms that stay
  hard to game even though the target is public.
- The reason this still resists gaming: the cheat vectors in a build-to-spec
  task are hardcoding responses to the *exact fixture data*, special-casing
  known eval literals, or writing a harness that looks rigorous but tests
  nothing (see `LOG.md` for a near-miss of exactly that kind, caught and
  fixed during LFD design). The probes and the grep-based static checks
  target precisely those vectors — see "Enumerated cheats" below.

## Stage 0 — Get the harness itself running clean (inner loop)

Before touching the weighted score: run `harness/run-evals.sh` from a clean
worktree checkout. On an empty `apps/`, it must:
- start Postgres, print a `DATABASE_URL`, and tear down cleanly at exit;
- run `harness/lint.sh` and pass (nothing to lint yet);
- attempt every spec file, report every one as failing (correct — nothing is
  built), and still emit a well-formed `.last-scorecard.json` with
  `weighted_score: 0`-ish and `hard_fail_triggered: true`;
- exit non-zero.

That is the expected, correct Stage-0 result on an empty repo. Confirm this
once before writing any application code — if `run-evals.sh` crashes instead
of reporting a clean all-failing scorecard, the harness itself is broken and
must be reported (not patched — harness files are read-only, see
Constraints), because a crash and "0% correctly measured" look identical to
an agent that isn't paying attention, and the whole point of Stage 0 is to
rule that out before it costs a phase's worth of wasted cycles.

Then work phase-by-phase per PRD §32 (phases 1→8 are the critical path; 9–10
may be thinner but every §31 bullet must still pass; 11 minimal). After each
phase, run the affected eval-case subset (grep `eval-cases.json` for
`prd_refs` touching that phase) — run the full `run-evals.sh` only at phase
boundaries, per the token-efficiency instructions in `EXECUTION_PROMPT.md`.

## Target (outer loop)

Weighted score across five categories, computed by `harness/score.sh`:

| Category | Weight | What it measures |
|---|---|---|
| Workflow correctness | 40% | Full PRD §17 state machine end-to-end against mocks |
| Security & gates | 20% | §6 auth guard, §27 hardening, prompt-injection resistance, secret scan, server-side gates |
| Determinism & reproducibility | 15% | Byte-stable prompts, §14.5/§14.6 order, snapshot completeness, plan/skill immutability |
| Frontend fidelity & a11y | 20% | All 24 routes, design tokens verbatim, shell metrics, a11y bar |
| Operational quality | 5% | Idempotent jobs, §28 failure paths, §10 scripts exist and run |

**Bar: weighted score ≥ 0.95, no single category < 0.85, AND zero hard-fail
cases failing.** A hard-fail case failing VOIDs the run regardless of the
weighted score — `score.sh` reports `hard_fail_triggered: true` and the
scorecard's headline number stops mattering until it's fixed. 15 of the 56
cases are marked `hard_fail: true` in `eval-cases.json`; they map directly to
the ten hard-fail conditions in `prompts/lfd-dev-control-center.md`.

Score with `harness/score.sh` (wraps `lint.sh` first — a lint violation
VOIDs the score and prints nothing else; see cheat-museum.md #12 for why the
violated literal is never named back to you). `harness/run-evals.sh` is the
one-command entry point that also handles Postgres/fixtures/app lifecycle.
`--holdout` additionally runs the regenerated-input probes; rate-limited to
6 calls/24h purely as a compute-cost control (there's no secret to leak by
calling it more, per the note above — the limit exists so the loop doesn't
burn cycles hammering it instead of building).

## Enumerated cheats (read before your first cycle)

Simulated against this specific target; each has a fence already built in:

1. **Hardcode responses to the seeded fixture tickets** (DCC-135..148) →
   fresh tickets are submitted via the real public API in most test files,
   and `probe.sh`'s determinism check regenerates entirely new randomized
   ticket bodies every run — a hardcoded response for known fixture IDs
   won't touch the fresh ones.
2. **Special-case the `.spec.ts` test files' exact request shapes** → the
   grep probes (`SEC-15`, `SEC-16`) scan production source for suspicious
   patterns; a `if (req.body.title.includes('probe-'))` branch is exactly
   the shape #9 in cheat-museum.md warns about and would show up under
   manual review of the diff even if a probe doesn't automatically flag it
   — `harness/lint.sh`'s capacity-cap section is the place to extend if this
   is ever observed.
3. **Weaken or skip the auth guard, gate checks, or secret scan** →
   `probes/gate-bypass.spec.ts` and `probes/grep-probes.spec.ts` hit these
   directly and are hard-fail cases; a weakened check fails immediately, it
   doesn't silently pass.
4. **Ship the `.dc.html` prototype or import `support.js`** → `SEC-16`
   greps for both, hard-fail.
5. **Let Claude call `git push`/`gh`/merge** → `SEC-15`/`SEC-17` grep
   production code and mock-github's request log respectively; mock-github's
   real `/merge` route always 403s by design specifically to catch this.
6. **Build the planning prompt non-deterministically "just this once" to
   unblock a hard case** → `DET-01` (hard-fail) checks two same-process
   builds; `probe.sh`'s regenerated-input check extends this to fresh inputs
   every run, so a hardcoded-lookup shortcut for known ticket text doesn't
   survive.
7. **Declare victory after one green `run-evals.sh`** → Stop conditions
   below require two consecutive clean runs from a clean checkout.
8. **Edit a failing test to make it pass** → hard-fail #10, and
   `harness/probe.sh`'s harness-integrity check (once
   `harness/freeze-integrity.sh` has been run — see Constraints) hashes
   every harness/eval file and hard-fails on drift.
9. **Seed data that mirrors what a test asserts, then "pass" against your
   own seed** → the execution agent has no write access to
   `harness/fixtures/seed.sql` (read-only, see Constraints) and most tests
   submit fresh tickets rather than relying solely on seeded ones.
10. **A harness that looks rigorous but tests nothing** (e.g. a login test
    against a hand-fabricated password hash instead of a real one) → this
    was caught during LFD design itself (see `LOG.md`) and fixed by routing
    admin creation through the real `scripts/create-admin.ts`; flagged here
    as a pattern to watch for if `HARNESS_CONVENTIONS.md` conventions are
    ever adjusted.

## Constraints

- **Token budget:** ~1.5M tokens total for execution (per
  `prompts/lfd-dev-control-center.md`); LFD design consumed roughly the
  documented ~150k budget for its own phase. Use the cheapest capable model
  per `EXECUTION_PROMPT.md`'s tiering; check spend against this ceiling
  periodically — there's no dollar ceiling to track since every external
  surface (Claude CLI, GitHub) is mocked and local, so token burn is the
  only real cost signal. `harness/status.sh` reports wall-clock and score
  history; it has no dollar/token instrumentation of its own (no paid
  surfaces exist to meter) — track token spend via your own harness's
  session accounting, not this script.
- **Surface allowlist:** only inside
  `/home/dutchbase/projects/dev-control-center/.worktrees/dcc-build/`.
  Never touch the main checkout, `master`, or `production`. `prd.md`,
  `design-handoff/`, and `prompts/` at the repo root are read-only inputs
  (they live outside the worktree's writable tree in spirit even though
  git makes them readable inside it — do not propose edits to them).
- **Read-only to the execution agent:** `goal.md`, everything under
  `.lfd/dcc-build/harness/` (including `eval-cases.json` and every
  `tests/**/*.spec.ts` file), and `LOG.md`'s existing entries (append new
  cycle entries, never rewrite old ones). If a frozen test's assumption
  about an undocumented route/field genuinely conflicts with a defensible
  API design, report it in your own commit message and in a new `LOG.md`
  entry — do not edit the test.
- **No real external calls, ever:** no `ANTHROPIC_API_KEY`/
  `ANTHROPIC_AUTH_TOKEN`/Bedrock/Vertex/Foundry, no `api.anthropic.com`, no
  real GitHub API calls (point the GitHub provider at
  `GITHUB_API_BASE_URL=http://127.0.0.1:8991`, mock-github's address). This
  is absolute — hard-fail #1 and the SEC-01/SEC-16 cases exist to catch any
  slip.
- **Capacity caps:** no lookup table, keyword list, or literal-matching
  branch keyed on eval-case IDs, ticket titles/bodies, or test file names
  may exist anywhere in production source. There is no legitimate reason
  for production code to reference a string like "DCC-144" or "probe-"
  except as data flowing through the system, never as a conditional branch.
- **Immutability is structural, not a style preference:** plan versions,
  prompt snapshots, skill snapshots, and run snapshots must be genuinely
  append-only at the database/filesystem level (no UPDATE/overwrite path
  reachable from any API route) — `DET-06`/`DET-07` verify this by mutating
  inputs after the fact and checking the stored artifact didn't move.

## Cycle protocol

1. Pick the next PRD §32 phase (or the next failing case within the current
   phase).
2. Run the affected eval-case subset (`grep` `eval-cases.json`'s
   `prd_refs`/`id` for the phase or case you're targeting) — not the full
   suite, per token-efficiency guidance in `EXECUTION_PROMPT.md`.
3. Implement the minimum code to turn that subset green — ponytail
   discipline: reuse before adding, stdlib/native before a dependency,
   shortest correct diff.
4. Run `harness/run-evals.sh` at phase boundaries (not every cycle) for the
   full-suite signal, and always before claiming a phase done.
5. Commit inside the worktree with the scorecard JSON referenced in the
   commit message (per `EXECUTION_PROMPT.md`).
6. Append a `LOG.md` cycle entry: hypothesis written before the change,
   result after.

## Entropy rules

- **Stall rule:** if a case's status hasn't moved in two consecutive
  attempts, the next attempt must be structurally different (e.g. stop
  tweaking a validation regex and re-read the actual PRD section instead of
  re-guessing) — same-knob-harder is banned.
- **Escalation, not exploration quota:** this is a convergent build task,
  not an open-ended search — there's no "try a structurally different
  approach every K cycles" requirement. Instead, escalate model tier (see
  `EXECUTION_PROMPT.md`) after two failed attempts at the SAME case rather
  than grinding indefinitely at the cheap tier.

## Stop conditions

- **Done:** weighted score ≥ 0.95, no category < 0.85, zero hard fails,
  `run-evals.sh` green twice consecutively from a clean checkout (fresh
  Postgres, fresh git-fixtures, fresh `pnpm install`).
- **Diminishing returns:** 3 consecutive phase-boundary `run-evals.sh` runs
  improving the weighted score by < 2% → stop, write the gap analysis in
  `LOG.md` (`harness/status.sh` computes this check automatically from
  `.cycle-log.jsonl`), surface to the operator.
- **Budget:** execution exceeds ~1.5M tokens total → pause and report status
  rather than pushing on silently.
- Score incrementally per phase — early phases lock green before later ones
  start, per PRD §32's ordering.

## Before the execution agent's first cycle

Run once, from this worktree, before handing off:

```bash
cd /home/dutchbase/projects/dev-control-center/.worktrees/dcc-build/.lfd/dcc-build/harness
./freeze-integrity.sh   # hashes every harness/eval file; scoring hard-fails on drift thereafter
```

This must run AFTER all harness files are finalized (it was deliberately not
run automatically during LFD design construction, to avoid re-freezing on
every edit) — see `harness/freeze-integrity.sh` itself.
