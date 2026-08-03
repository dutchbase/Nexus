# G03 Approval Reproducibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bind plan approval to one immutable, reproducible execution contract for G03-F01 through G03-F05.

**Architecture:** Add an append-only approved-input snapshot and decision record. Approval creates both under a locked compare-and-swap transition; queueing and the worker load the approved snapshot rather than resolving live configuration. Legacy approvals without a snapshot fail closed and require reapproval.

**Tech Stack:** TypeScript, PostgreSQL migrations, Vitest.

## Global Constraints

- Work only on `agent/g03-approval-reproducibility`, never main/master.
- Remediate only G03-F01, G03-F02, G03-F03, G03-F04, and G03-F05.
- Reuse existing prompt, skill, snapshot, hash, and transaction utilities; add no dependencies.
- Every behavior change follows a focused TDD red-green cycle.

---

### Task 1: Persist and canonically hash approval inputs

**Files:** Create migration `packages/database/migrations/033_approval_input_snapshots.sql`; add a focused domain helper and test.

- [ ] Add immutable `approved_input_snapshots` with ticket, plan version, canonical material-input JSON, SHA-256 input hash, and creation metadata; add append-only `plan_approval_decisions`.
- [ ] Add `tickets.approved_input_snapshot_id`; invalidate legacy active approvals while retaining old columns for compatibility.
- [ ] Canonicalize approved plan hash/version, ticket material fields, project material config/revision, per-phase model, rendered prompt content and scoped provenance, and resolved skills/policy sources.
- [ ] Exclude operational fields such as `last_validated_at`.
- [ ] Write and run focused tests proving deterministic hashes, material-change hashes, validation-only stability, and scoped provenance.

### Task 2: Make policy resolution and approval transitions atomic

**Files:** Modify `apps/web/src/server.ts`, shared approval helper/tests, and migration triggers.

- [ ] Refactor shared resolution to use the transaction client and the same builder for preview and approval.
- [ ] Enforce `project_skills.allow_ticket_override`, resolve missing/disabled/incompatible required skills fail-closed, and require mandatory prompt inputs.
- [ ] Atomically create the approval snapshot/decision and update the current expected ticket/plan state; conflicts return a stable approval-conflict response with the current snapshot ID when present.
- [ ] Rejection creates a decision and clears every active approval reference.
- [ ] Ensure material project/import changes invalidate approvals while validation-only updates do not.
- [ ] Write and run focused tests for decision/revision races, clearing, policy failures, and preview/approval hash equality.

### Task 3: Consume approved inputs in queueing and execution

**Files:** Modify `packages/domain/src/plan-approval.ts`, `apps/worker/src/worker.ts`, and focused tests.

- [ ] Extend the gate to require/load the current immutable snapshot and verify its plan/hash binding.
- [ ] Queue and recheck the exact snapshot ID; worker uses stored prompts, project material config, model, and skills rather than live resolution.
- [ ] Keep worktree/diff/validation/feedback runtime-only and record the approved snapshot ID/input hash in execution metadata and prompt snapshots.
- [ ] Write and run focused drift, stale queued work, and preview/worker hash-equality tests.

### Task 4: Make plan Markdown validation tolerant

**Files:** Modify `packages/claude-runner/src/index.ts` and `packages/claude-runner/src/index.test.ts`.

- [ ] Normalize semantic headings so number, punctuation, heading-level, and order variations are accepted while each current semantic section remains required once.
- [ ] Preserve legacy Markdown and make missing/duplicate sections return actionable `invalid_plan_structure` errors.
- [ ] Write and run focused variant, missing-section, duplicate-section, and legacy compatibility tests.

## Final Verification

- [ ] Run each focused regression test.
- [ ] Run `pnpm exec tsc --noEmit`.
- [ ] Run `pnpm exec vitest run apps packages`.
- [ ] Review the whole branch, commit intentionally on the feature branch, push, and open a draft GitHub PR.
