# Execution prompt — Development Control Center MVP build

You are the execution agent for the LFD run defined in `goal.md` (same
directory). Read `goal.md` in full before writing any code — it is the
loss function you're optimizing against, not optional background reading.
Also read `harness/HARNESS_CONVENTIONS.md` before your first line of code —
it is the contract your implementation must satisfy for the frozen tests to
even be able to talk to your app.

## Working rules

1. **Load and follow the `ponytail` skill for every implementation step.**
   Before writing any function, file, or dependency addition, run it through
   the ponytail ladder: does this need to exist at all → is it already in
   this codebase → does stdlib/a native platform feature cover it → is an
   already-installed dependency the answer → can it be one line → only then
   write the minimum code that works. This is not a style suggestion, it's
   how you stay inside the token budget.
2. **Write only the code actually needed to turn eval cases green.** No
   unrequested abstractions, no interface with one implementation, no config
   for a value that never changes, no scaffolding "for later." If a PRD
   section describes a Release-1.1+-and-later feature (§33), it is out of
   scope — do not build toward it speculatively.
3. **No unnecessary refactors or broad rewrites.** If a case fails because
   of one function, fix that function. Don't restructure a package because
   it "could be cleaner" unless a case specifically requires the
   restructure to pass.
4. **Use Codex for code execution.** Fall back to Anthropic models only if
   Codex is unavailable, or produces an inadequate result on a given task
   after two attempts — try the same task with Codex twice (different
   angle/more context the second time) before switching, and note the
   fallback in that cycle's `LOG.md` entry with why.
5. **Use the cheapest capable model/effort for Codex and every sub-agent.**
   Concretely:
   - Cheapest tier: mechanical CRUD routes, fixture-shaped UI recreation
     (design tokens, static screens, form builder fields), boilerplate
     migrations directly transcribing PRD §26's column lists, the `scripts/`
     utilities in PRD §10.
   - Step up a tier only when the cheap tier fails an eval case twice:
     the transactional job queue (§24), the subscription-auth guard (§6),
     the deterministic prompt builder (§14.5–§14.7), the status-transition
     transaction atomicity (§17.3), and anything a `hard_fail: true` case in
     `eval-cases.json` covers. These are exactly the places a shortcut
     produces a VOIDing failure, not a partial-credit one — get them right
     the more expensive way rather than iterating cheaply against a
     hard-fail case.
6. **Optimize for token/cost efficiency throughout.** Batch related edits
   in one pass instead of one-file-per-turn. Don't re-read a file you
   haven't changed since your last read of it. While iterating within a
   phase, run only the eval-case subset that phase touches (`grep`
   `eval-cases.json`'s `prd_refs` for the section numbers PRD §32 assigns to
   that phase); run the full `harness/run-evals.sh` only at phase
   boundaries and before declaring a phase done.
7. **Never modify harness or eval files.** Everything under `harness/`,
   `goal.md`, and `LOG.md`'s existing entries is read-only to you (hard-fail
   #10 — a violation voids the entire attempt, not just that case). If you
   believe a specific test's assumption about an undocumented API contract
   detail is wrong (route shape, field name, selector) — and several are
   flagged as exactly that in `LOG.md`'s "Assumptions flagged by subagents"
   section — **report it**: note the mismatch in your phase commit message
   and append a `LOG.md` entry describing what you built and why the test's
   assumption doesn't fit. Do not edit the test to match your choice, and do
   not silently rename your route/field to dodge the disagreement without
   recording that you did so. If you're genuinely blocked because a test
   assumption is unworkable, say so loudly rather than routing around it
   quietly.
8. **Work phase-by-phase per PRD §32** (Foundation → Forms/tickets → AI
   config/skills → Prompt system → Planning → Plan revision → Execution →
   Validation/PR creation → Central PR dashboard → Notifications →
   Hardening). Commit inside the worktree at each phase boundary. Commit
   message must reference that phase's scorecard: run
   `harness/run-evals.sh` (writes `harness/.last-scorecard.json`), and
   include its `weighted_score`, `hard_fail_triggered`, and per-category
   breakdown in the commit body — e.g.:

   ```
   phase 3: AI configuration and skills

   scorecard: weighted=0.61 hard_fail=false
   workflow=0.55 security=0.72 determinism=0.44 frontend=0.30 operational=0.60
   ```

9. **Never skip hooks, never bypass the harness's exit code.** A phase isn't
   done until `run-evals.sh` for the cases that phase covers actually
   passes — not "would probably pass," run it.

## First action

```bash
cd /home/dutchbase/projects/dev-control-center/.worktrees/dcc-build
cat .lfd/dcc-build/goal.md
cat .lfd/dcc-build/harness/HARNESS_CONVENTIONS.md
bash .lfd/dcc-build/harness/run-evals.sh
```

Confirm the baseline run behaves as `goal.md`'s "Stage 0" section describes
(clean all-failing scorecard, not a crash) before writing any application
code. If it crashes instead, that's a harness defect — report it, don't work
around it by skipping `run-evals.sh` for the rest of the build.

## Scope reminders (from `goal.md` / PRD §8.2)

Out of scope for this build: automatic PR merge, automatic production
deployment, public user accounts, multi-tenant hosting, sprint
planning/billing/time-tracking, native mobile, AI-based ticket/prompt
approval, direct public Claude access, full GitHub review-UI replacement.
WhatsApp is a placeholder provider only (§23.5) — build the provider
interface and the disabled placeholder config, not a real WhatsApp client.
GitHub integration goes through the provider abstraction and talks to
mock-github (`GITHUB_API_BASE_URL`) in this environment — no real GitHub
credentials exist here and none should ever be requested.
