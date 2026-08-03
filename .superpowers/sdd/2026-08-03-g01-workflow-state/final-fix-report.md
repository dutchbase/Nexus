# G01 final fix report

- Published `execution.run`, `execution.repair`, and `pull-request.retry` crash gaps now complete the recovered job without rewriting the successful publication, attempt, run, or ticket.
- Migration 037 expires pre-existing `running` jobs and `sending` deliveries immediately; its integration proof migrates real pre-037 rows forward.
- A missing publication intent now preserves the original execution error for generic execution failure handling; durable publication failures remain `PublicationError`.
- `GET /api/admin/jobs` retains `id`, capacity, and the existing response shape while adding `attempt_id = jobs.id`.
- The publication idempotency test uses a second valid execution attempt and asserts PostgreSQL unique violation `23505` on `execution_publications_idempotency_key_key`.

## Verification

- TDD red: 7 expected failures across recovery, pre-intent classification, and `attempt_id`.
- Focused G01 suite: 7 files passed; 57 tests passed, 21 database-backed tests skipped because `DCC_TEST_DATABASE_URL` is unset.
- `pnpm exec tsc --noEmit`: passed.
- `git diff --check`: passed.
- `pnpm exec vitest run apps packages`: 53 files passed, 2 failed, 2 skipped; 246 tests passed, 1 failed, 27 skipped. The remaining failures are the baseline-known `apps/web/src/approval-inputs.test.ts` role-environment suite error and `apps/web/src/provider-boundary.test.ts` source-boundary assertion.

## Second fix cycle

- Recovery completes a published execution job only when `last_job_id` matches that exact job; an older published repair leaves the later expired repair unchanged.
- A worker that reaches an already-published intent records the current job before treating the publication as complete.
- Verification: `pnpm exec vitest run apps/worker/src/workflow-state.test.ts apps/worker/src/publish-artifact-atomicity.test.ts` (21 passed), `pnpm exec tsc --noEmit`, and `git diff --check`.
