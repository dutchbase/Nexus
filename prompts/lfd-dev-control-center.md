# LFD Prompt — Development Control Center (full MVP build)

You are an autonomous agent about to run `/lfd-design`. Read this brief completely before doing anything. Your job: produce the LFD loss function, eval harness, and specs for building the **Development Control Center** — a self-hosted feedback→ticket→AI-plan→AI-execution→PR-review platform — including its full admin frontend, then write the execution prompt that a second agent will use to build it.

---

## GLOBAL GROUND RULES FOR THIS RUN

- Always use the absolute project path:
  `/home/dutchbase/projects/dev-control-center`
- Always create a git worktree before doing anything else.
- Worktrees must be created inside:
  `/home/dutchbase/projects/dev-control-center/.worktrees/`
- Do not work directly in the main checkout above.
- Do not work directly on `master` or `production`.
- Use sub-agents when useful, but keep the work token-efficient and cost-efficient.
- Always use the cheapest capable model for sub-agent work.
- Spend as little money/tokens as possible while still producing a correct, production-safe LFD plan.
- The `.lfd/` folder is planning/execution scaffolding only. It does not need to be tracked or merged into `master`.
- After the LFD loss function files are created, create a second prompt for the AI agent that will execute the goals from the loss function.
- Store that execution prompt inside the worktree's `.lfd/` folder.
- The execution prompt must instruct the execution agent to:
  - use the ponytail skill
  - only write the code actually needed
  - avoid unnecessary refactors or broad rewrites
  - use Codex for code execution (fall back to Anthropic models if Codex is unavailable or inadequate)
  - use the cheapest capable model for Codex and sub-agent execution
  - optimize for token/cost efficiency
- After creating and storing the execution prompt, advise which orchestrator agent to use (`haiku`, `sonnet`, `opus`) and which effort level to pick for executing the goals together with Codex.

---

## Repository and worktree setup

**Pre-step — the directory is not yet a git repository.** Before anything else:

```bash
cd /home/dutchbase/projects/dev-control-center
git init -b master
cat > .gitignore <<'EOF'
node_modules/
data/
uploads/
logs/
worktrees/
.worktrees/
.env
.env.*
secrets/
dist/
.next/
EOF
git add .gitignore prd.md design-handoff/ prompts/
git commit -m "baseline: PRD, design handoff, prompts"
```

Then create the worktree:

```bash
cd /home/dutchbase/projects/dev-control-center
git worktree add /home/dutchbase/projects/dev-control-center/.worktrees/dcc-build -b lfd/dcc-build
cd /home/dutchbase/projects/dev-control-center/.worktrees/dcc-build
```

If the worktree already exists, inspect it first and either reuse it safely
or create a new uniquely named worktree, for example:
`/home/dutchbase/projects/dev-control-center/.worktrees/dcc-build-2`

Record the selected worktree path and branch in:
`/home/dutchbase/projects/dev-control-center/.worktrees/dcc-build/.lfd/dcc-build/LOG.md`

---

## Source documents (read all three before designing anything)

| Path | What it is |
| --- | --- |
| `/home/dutchbase/projects/dev-control-center/prd.md` | Complete PRD v1.0 — 35 sections. The functional contract. §31 (MVP acceptance criteria) and §35 (Definition of Done) are the release bar. §32 gives the 11-phase build order. |
| `/home/dutchbase/projects/dev-control-center/design-handoff/README.md` | Self-sufficient frontend implementation spec: 22 admin routes + login + public form, application shell, per-screen layouts, design tokens (§7 — copy verbatim), state mapping (§8), fixtures (§9), a11y bar (§11). |
| `/home/dutchbase/projects/dev-control-center/design-handoff/Development Control Center.dc.html` | Clickable HTML prototype. Design reference only — **never ship it or port its runtime**. Where README and prototype disagree on a number, the prototype wins. |

---

## Goal

Build the version-1 MVP of the Development Control Center as a pnpm monorepo (workspace layout per PRD §10) with:

1. **Web app** — public intake forms + full admin dashboard implementing every route in PRD §25 / handoff §3, faithfully recreating the design handoff (tokens, typography, shell, per-screen specs, light/dark/auto themes, 980px mobile breakpoint, a11y requirements in handoff §11). Choose a React meta-framework with SSR (Next.js is the natural fit); no frontend exists yet.
2. **Worker service** — PostgreSQL-backed transactional job queue (PRD §24), Claude Code subprocess runner behind a version-aware CLI adapter (§5, §18.3, §20.4), subscription-only auth guard (§6), Git worktree isolation (§20.2), independent validation pipeline (§20.5), worker-controlled commit/push/draft-PR (§21), PR sync (§22.7), event-driven notifications behind a provider interface (§23).
3. **PostgreSQL schema** — all tables in PRD §26, with migrations.
4. **Deterministic prompt builder** — assembles planning/execution prompts in the exact §14.5/§14.6 order, zero AI involvement, byte-stable, snapshotted with SHA-256 hashes (§14.7), untrusted-input delimiters (§27.3).
5. **API routes** — exactly PRD §29.

Why it matters: this platform is the operator's central control layer for AI-assisted development across all their projects; the two human approval gates and the no-API-auth guarantee are its entire reason to exist. A build that "mostly works" but leaks past a gate is worthless.

**Scope discipline:** everything in PRD §8.2 is out of scope. WhatsApp is a placeholder provider only (§23.5). GitHub integration goes through a provider abstraction and is exercised against a mock in evals — no real GitHub credentials exist in this environment.

---

## Constraints

- Work only inside the worktree. Never touch the main checkout, `master`, or anything outside `/home/dutchbase/projects/dev-control-center`.
- `prd.md`, `design-handoff/`, and `prompts/` at repo root are read-only inputs.
- pnpm monorepo, TypeScript throughout, structure per PRD §10 (`apps/web`, `apps/worker`, `packages/*`).
- PostgreSQL only — no Redis, no external queue (PRD §24.1, §34.2). Evals run against ephemeral Postgres (Docker).
- No real Claude CLI calls, no Anthropic API calls, no real GitHub calls in the harness — everything AI/Git-remote-shaped is mocked (see Harness).
- Design tokens from handoff §7 copied verbatim; every UI colour must be one of those variables. Cormorant Garamond / DM Sans / JetBrains Mono. No icon libraries, no images, no SVG illustrations (handoff §10).
- Approval gates enforced **server-side** (API layer), with the UI mirroring them — never UI-only.
- All security requirements of PRD §27 are in scope for the MVP: Argon2id, session hardening, CSRF, public-form rate limiting + honeypot, image-only/no-SVG uploads, secret scanning before commit, audit events.

---

## Hard fail conditions

Any of these means the attempt is wrong — stop, do not iterate around it:

1. Any code path that reads or sends `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` to authenticate, or any Anthropic HTTP API client in production code. Subscription-only via `CLAUDE_CODE_OAUTH_TOKEN`; the worker must refuse to start a job when any of the five §6.4 variables is present (status `blocked_auth_configuration`, no fallback).
2. Prompt construction that involves an AI model, randomness, or timestamps inside hashed content — the same inputs must produce byte-identical prompts.
3. Execution reachable without an approved, hash-matched plan version; or planning reachable without ticket approval. Includes direct API calls bypassing the UI.
4. Any automatic merge call, or Claude-controlled `git push` / `gh` / PR creation. Git publishing belongs to the worker exclusively.
5. Claude execution running in the primary project checkout instead of an isolated worktree.
6. Immutable records (plan versions, prompt snapshots, skill snapshots, run snapshots) that can be overwritten after creation.
7. Status transitions performed outside the transaction of their triggering event (§17.3).
8. The `.dc.html` prototype or `support.js` shipped or imported by production code.
9. `data/`, `.env`, `secrets/`, uploads, or worktrees committed to git.
10. Harness/eval files modified by the execution agent to make evals pass.

---

## Scoring — what "good" measurably looks like

Weight the loss function roughly as:

- **40% — workflow correctness**: the full state machine (PRD §17) driven end-to-end through the API against mocks: submission → triage → approval → planning → plan review/revision → plan approval → execution → validation → commit/push/draft-PR → sync → merged. Every §17.2 transition fires exactly as specified; §17.3 statuses cannot be set manually.
- **20% — security & gates**: §6 auth guard, §27 auth/form/upload hardening, prompt-injection preamble + delimiters, secret scan blocking commits, protected-path enforcement, server-side gate enforcement.
- **15% — determinism & reproducibility**: prompt builder byte-stability, §14.5/§14.6 assembly order, snapshot completeness (§4.5, §14.7, §13.8), plan/skill immutability.
- **20% — frontend fidelity & a11y**: all 24 routes render with fixture data reproducing the handoff's states (including the four unhappy paths in handoff §9); tokens verbatim with no one-off hex; shell metrics (246px sidebar, 64px header, breadcrumbs, badges as live counts); theme toggle; 980px responsive behaviour incl. grid-list→card-row collapse; handoff §11 a11y items (focus visible, Escape closes modals, focus trap, `aria-current`, tab semantics, 44px touch targets).
- **5% — operational quality**: idempotent jobs (§30.1), failure paths of §28 (at least: dirty repo blocks, validation failure preserves worktree+logs, push/PR retry idempotent, notification failure never blocks workflow), scripts in §10 exist and run.

Passing bar: all hard fail conditions clear **and** weighted score ≥ 0.95, with no single category below 0.85.

---

## Eval cases

No eval data exists yet — Phase 3 of `/lfd-design` must turn these scenarios into concrete, runnable eval cases (extend to ~40–60 total by mining PRD §31 and §35 line-by-line; every §31 bullet becomes at least one eval):

1. Valid public submission → ticket `Submitted`, `DCC-*` number, appears in admin list, `ticket.created` notification queued.
2. Honeypot filled → rejected, no ticket row. Rate limit exceeded → 429.
3. SVG upload rejected; PNG stored under a random name outside Postgres.
4. Build the planning prompt twice for identical ticket/config/skills → byte-identical, identical SHA-256; sections in exact §14.5 order; ticket body wrapped in delimiters with the §27.3 untrusted-data preamble.
5. Worker preflight with `ANTHROPIC_API_KEY` set → job `blocked_auth_configuration`, mock `claude` binary never invoked.
6. Planning run (mock CLI returns a valid §18.4 plan) → `plan_versions` v1 in DB **and** `data/tickets/{n}/plans/v1.md`, ticket → `Plan Ready for Review`.
7. Plan feedback → v2 created, v1 bytes untouched; revision resumes the session ID.
8. `POST /execute` with no approved plan → blocked. Approve v2 (approval carries plan hash) → execution allowed; worktree at `data/worktrees/{project}/{ticket}/{attempt}`, branch `feedback/DCC-…`.
9. Ticket edited after plan approval → plan flagged `potentially_stale`, execution blocked until reconfirmation.
10. Validation step fails (harness makes lint fail) → no commit, no push, no PR, ticket `Validation Failed`, worktree and logs preserved; repair attempt receives plan + diff + failed output.
11. Validation passes → worker commits, pushes to the local bare remote fixture, creates draft PR via mock GitHub provider with the full §21.2 body; ticket `PR Ready for Review`.
12. Mock GitHub reports external merge → ticket `Merged` → `Completed`; close-without-merge → `Closed Without Merge`.
13. Skill resolution: global mandatory + project automatic + ticket-selected + phase-required, deduped by ID; snapshot records versions/hashes/paths; editing a `SKILL.md` after snapshot does not change the run's bundle; bundle materialised at `data/skill-bundles/{run-id}/.claude/skills/`.
14. Automatic skill removable only when project config allows overrides; missing skill blocks the run naming the skill.
15. Invalid model/effort combination blocks approval with a message; no silent downgrade.
16. Login: Argon2id hash format, rate limit + lockout, audit rows for success and failure; session cookie HttpOnly/SameSite; CSRF token required on mutations.
17. Job queue: duplicate approval clicks yield one job (idempotency key); crash between plan store and status update leaves no partial state (both or neither).
18. Frontend (Playwright): `/admin` shell — sidebar 246px, header 64px sticky, four nav groups with live-count badges, worker pill; computed styles resolve to token variables.
19. Frontend: ticket detail has 8 tabs; **Start execution** disabled pre-approval; skill picker toggle updates chips *and* the resolved-references block in the same tick, and the same lines appear in the Prompt tab.
20. Frontend: theme control writes `data-theme` on `<html>`; Auto follows `prefers-color-scheme`; both palettes match handoff §7.
21. Frontend: viewport < 980px → sidebar becomes off-canvas drawer with scrim; tickets/runs/queue/PR grid lists render as card rows, not collapsed unlabelled columns.
22. Notification delivery fails (mock 504) → retried with backoff, delivery row shows error, ticket workflow unaffected, manual retry works.
23. Dirty repository fixture → planning and execution blocked, changed files shown, checkout never auto-reset.
24. Seed fixtures reproduce handoff §9 including the unhappy paths (dirty `customer-portal`, failed validation DCC-144, failed delivery ND-8841, timed-out RUN-0898).

---

## Harness scripts (must exist before scoring anything)

Build under `.lfd/dcc-build/harness/`:

- `docker-compose.eval.yml` — ephemeral Postgres.
- `mock-claude/` — a fake `claude` executable put on `PATH` for worker tests. Supports `-p`, `--session-id`, `--model`, `--effort`, `--permission-mode`, `--tools`, `--append-system-prompt-file`, `--add-dir`, `--output-format json|stream-json`, `--max-turns`, and `auth status` (exit 0 + JSON). Scriptable per-test: return a valid plan, an invalid plan, a timeout, or stream-json execution events. It must *fail loudly* if API-key env vars are present, mirroring real precedence.
- `mock-github/` — small HTTP server implementing the provider surface used (create draft PR, get PR, list PRs, simulate merge/close/changes-requested).
- `git-fixtures/` — script that creates throwaway target-project repos with local bare "remotes", including a dirty-checkout variant.
- `seed.ts` — loads the handoff §9 fixture set.
- `run-evals.sh` — one command: spins everything up, runs migrations + seed, executes all eval suites (API-level integration tests + Playwright UI suite), emits a JSON scorecard with per-category scores and hard-fail flags, exits non-zero on any hard fail.

The harness must be runnable repeatedly and hermetically; no network beyond localhost.

---

## Probes — catching a gamed loss function

Run these as part of every scoring pass:

- **Harness integrity**: hash all harness/eval files at LFD-design time; scoring recomputes and hard-fails on drift.
- **Determinism probe**: generate prompts for 5 randomized tickets, twice each, in separate processes → identical hashes.
- **Gate bypass probe**: hit execution/planning APIs directly with curl (no UI), including with a stale plan hash → must be rejected.
- **Grep probes** on production code: `api.anthropic.com`, `ANTHROPIC_API_KEY` (outside the guard/refusal code), `merge` calls in the GitHub provider, hardcoded hex colours outside the token block, imports of `support.js` / `.dc.html`.
- **Mock leakage probe**: mock-claude and mock-github must not be reachable from production build output.
- **Test-authenticity probe**: mutate one known invariant (e.g. flip the auth guard) and confirm the suite goes red — a suite that stays green is decorative.

---

## Stop conditions

- **Done**: weighted score ≥ 0.95, no category < 0.85, zero hard fails, `run-evals.sh` green twice consecutively from a clean checkout.
- **Diminishing returns**: 3 consecutive execution iterations improving the weighted score by < 2% → stop, write up the gap analysis in `LOG.md`, surface to the operator.
- **Budget**: if LFD design + harness construction exceeds ~150k tokens or execution exceeds ~1.5M tokens total, pause and report status rather than pushing on silently.
- Sequence execution by PRD §32 phases (1→8 are the critical path; 9–10 may be thinner but every §31 bullet must still pass; 11 minimal). Score incrementally per phase so early phases lock green before later ones start.

---

## Execution prompt (write after the loss function exists)

Create `.lfd/dcc-build/EXECUTION_PROMPT.md` in the worktree. It must instruct the execution agent to:

- load and follow the **ponytail** skill for every implementation step;
- write only the code actually needed to turn evals green — no unrequested abstractions, no broad refactors, no speculative scaffolding;
- use **Codex** for code execution, falling back to Anthropic models only if Codex is unavailable or produces inadequate results on a given task after two attempts;
- use the cheapest capable model for Codex and all sub-agents (mechanical CRUD/UI recreation → cheapest tier; queue transactions, auth guard, prompt-builder determinism → step up only when evals fail);
- optimize for token/cost efficiency throughout: batch related edits, don't re-read unchanged files, run only the affected eval subset while iterating and the full suite only at phase boundaries;
- never modify harness or eval files; report — never paper over — evals it believes are wrong;
- work phase-by-phase per PRD §32, committing per phase inside the worktree with the scorecard JSON referenced in the commit message.

## Orchestrator recommendation

**`sonnet` at effort `high`** for the execution phase with Codex. The PRD and design handoff are unusually exhaustive — most of the work is faithful transcription of an explicit spec, not open-ended judgment, so opus would be overspend. Escalate a single sub-task to **`opus` / `high`** only if the transactional job queue, the subscription-auth guard, or prompt-builder determinism evals fail twice at sonnet. Use `haiku` / `low` for mechanical sweeps (fixtures, token CSS, boilerplate routes).
