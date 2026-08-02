# Superpowers Prompt and Agent Workflow Implementation Plan

## Goal

Replace the application’s global prompts and agent workflow with a minimal, pinned, Superpowers-inspired system that uses curated skills, cost-aware subagents, stronger PR review, and PR-gated upstream updates.

## Architecture

Prompt source lives in `prompts/global/*.md`; `config/agent-content.json` pins a tagged `obra/superpowers` release and curated skill allowlists. A deployment sync imports vendored skills and publishes immutable prompt versions. Planning snapshots the planning/execution/repair skill union, and workers materialize only the phase-specific subset. Claude receives local skills through `--add-dir` and generated upstream plugin skills through `--plugin-dir`.

## Global constraints

- Work only on `agent/superpowers-agent-workflow`; do not modify master.
- No new runtime dependencies or runtime upstream cloning.
- Use Haiku for mechanical subtasks and the selected execution model (Sonnet by default) for judgment/integration.
- Tagged upstream releases create reviewable update PRs; updates never auto-activate from a network fetch.
- Preserve project overrides, immutable prompt versions, snapshots, and untrusted-data boundaries.
- Use TDD for changed behavior and do not push/merge/create PRs from spawned Claude agents.

### Task 1: Define curated agent content

**Files:** `config/agent-content.json`, `prompts/global/*.md`, tests for prompt source loading.

- [ ] Add a tagged-release manifest for `obra/superpowers`, source metadata, and the exact planning/execution/repair allowlists.
- [ ] Add source prompt templates for all ten global prompt types: `base`, `planning`, `plan-revision`, `execution`, `execution-repair`, `validation`, `pull-request`, `pr-review`, `pr-conflict-resolution`, and `follow-up-ticket`.
- [ ] Make planning request `writing-plans` and emit the task-oriented plan format; make execution request SDD/Ponytail/TDD; make repair request systematic debugging.
- [ ] Keep interactive `using-superpowers` and `brainstorming` inspiration-only. Inject the upstream code-review rubric into PR review with `{{superpowers.code-reviewer}}`, escaped untrusted JSON, read-only tools, markdown review, and one fenced JSON verdict.

### Task 2: Implement deterministic updater and catalog sync

**Files:** `scripts/update-superpowers.ts`, `scripts/sync-agent-content.ts`, `config/agent-content.json`, tests.

- [ ] Import only allowed upstream skill directories from a supplied tagged checkout, validate manifest/version/license, remove stale vendored files, and write deterministic metadata without network access.
- [ ] Sync manifest-backed skills and prompt source files into the existing immutable prompt/skill registry in one transaction.
- [ ] Record catalog and per-prompt hashes in `agent_content.sync`; preserve active manual prompt changes when the corresponding tracked source did not change.

### Task 3: Correct snapshot and materialization semantics

**Files:** `packages/skill-registry/src/index.ts`, related tests and types.

- [ ] Extend snapshots with `phases`, `plugin_name`, `invocation_name`, and `configuration_json`; legacy rows remain all-phase compatible.
- [ ] Add `snapshotSkillSet(phases)`, `skillsForPhase`, and `materializeSkillBundle` returning `{ additionalDirectory, pluginDirectories }`.
- [ ] Materialize local skills beneath `<bundle>/.claude/skills` and return the bundle root for `--add-dir`; materialize vendored upstream skills as generated `superpowers` plugin directories.

### Task 4: Wire prompts, template variables, and runner capability

**Files:** `packages/domain/src/prompts.ts`, `apps/web/src/pages/shared.ts`, `packages/claude-runner/src/index.ts`, tests.

- [ ] Load/sync the source-backed global templates while retaining existing snapshots and project overrides.
- [ ] Add the single PR-review rubric placeholder to allowed template variables.
- [ ] Pass skill directories as the correct Claude flags; planning gets Skill but no Agent, execution gets Skill and Agent, PR review gets neither.
- [ ] Define session-local `--agents` roles: Haiku `dcc-mechanical`; configured `dcc-implementer`, `dcc-repair`, and read-only `dcc-reviewer`.

### Task 5: Freeze and use approved skills in worker runs

**Files:** `apps/worker/src/worker.ts`, worker tests.

- [ ] Snapshot the planning/execution/repair union at planning time and store the approved snapshot id on the ticket.
- [ ] Use that approved snapshot—not the current or earliest snapshot—for execution, repair, and validation; materialize the selected phase only.
- [ ] Reject a normal execution that produces no Agent tool event; keep all publishing under worker control.
- [ ] Convert a legacy 17-section plan to synthetic Task 1 before handing it to task-brief tooling.

### Task 6: Harden Git validation and execution changes

**Files:** `packages/git-runner/src/index.ts`, `apps/worker/src/worker.ts`, tests.

- [ ] Validate both committed and working changes from the recorded base; use that effective diff for repair and before publishing.
- [ ] Accept legitimate task commits, reject nonlinear history and empty effective diff, and make the final scan immediately precede the worker-owned commit/publish step.
- [ ] Add disposable detached PR worktrees from `refs/pull/<number>/head` with guaranteed cleanup.

### Task 7: Implement repo-aware PR AI review

**Files:** `apps/worker/src/worker.ts`, PR review parser/tests, GitHub integration tests.

- [ ] Review in the disposable PR worktree with only Read/Glob/Grep, never Bash/Skill/Agent.
- [ ] Post the detailed markdown review to GitHub and store the compact parsed `{ verdict, summary }` separately.
- [ ] Test malformed verdict JSON, prompt injection, fork refs, cleanup, and merge-blocking verdicts.

### Task 8: Add deployment and upstream PR automation

**Files:** `deploy.sh`, `.github/workflows/superpowers-update.yml`, `.github/workflows/ci.yml`, `README.md`, tests.

- [ ] On deploy: migrate, run content sync, then restart only after both succeed.
- [ ] Run daily at 04:17 UTC and manually; resolve a tagged release, check it out, run the deterministic importer and tests, and open `automation/superpowers-<tag>` PRs.
- [ ] Remove CI’s swallowed Vitest failure and document the update, rollback, and manual-override procedure.

### Task 9: Integration verification and release readiness

**Files:** affected tests and documentation only as required.

- [ ] Run typecheck and the relevant Vitest suites, then the full available suite.
- [ ] Check the implementation against every task and the global constraints.
- [ ] Perform a whole-branch review; address one consolidated fix wave if necessary.
