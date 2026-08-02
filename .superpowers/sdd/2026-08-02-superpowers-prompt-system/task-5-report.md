# Task 5 report — approved worker skill snapshots

## Scope

- Planning now resolves the planning, execution, and repair sets, deduplicates
  them, and snapshots that union. The planning runner materializes only the
  planning subset.
- The existing approval transaction stores the planning run's
  `skill_snapshot_id` in `tickets.approved_skill_snapshot_id`. Execution and
  repair now load exactly that ticket-owned snapshot, use it for the run and
  prompt provenance, and materialize only their selected phase. Validation and
  PR metadata use the same selected set.
- A normal execution must emit an `Agent` tool-use event. Without one, the
  worker fails before status completion, validation, commit, push, or PR
  publishing. Repair runs remain permitted without an Agent event.
- Legacy plans with the old `## 1. Summary` through
  `## 17. Open Questions` structure are wrapped as synthetic `## Task 1`
  before they are put into the execution prompt.

## TDD evidence

- Added `apps/worker/src/task-5.test.ts` first. Its four policy tests failed
  against the prior worker (missing union snapshot, approved-id lookup/phase
  filtering, Agent-event enforcement, and legacy-plan wrapper).
- After implementation: `pnpm exec vitest run apps/worker/src/task-5.test.ts apps/worker/src/follow-up-description.test.ts packages/skill-registry/src/index.test.ts packages/claude-runner/src/index.test.ts`
  passed: 4 files, 22 tests.
- `pnpm exec tsc --noEmit` passed.

## Concerns

- No database migration was required: the approval-linked
  `approved_skill_snapshot_id` already exists and is populated by the existing
  plan approval transaction.
