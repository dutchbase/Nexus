# SDD ledger — plan: docs/superpowers/plans/2026-08-03-g01-workflow-state.md

Baseline: d77a9e0; `pnpm exec tsc --noEmit` passed.
Baseline: `pnpm exec vitest run apps packages` failed in pre-existing `apps/web/src/approval-inputs.test.ts`, `apps/web/src/approval-route-regressions.test.ts`, and `apps/web/src/provider-boundary.test.ts`.
Task 1: minor (deferred): migration idempotency-key uniqueness assertion can fail first on its nonexistent execution-attempt FK fixture.
Task 1: complete (commits d77a9e0..c5b18da, 1 deferred minor)
Task 2: fix round 1/5 (1 addressed, 0 open — reverted out-of-scope cancellation lease hunk; commit 51dde27)
Task 2: complete (commits c5b18da..51dde27, review clean)
Task 3: fix round 1/5 (4 addressed, 1 open — compound lease fencing remained; commit 4244a5a)
Task 3: fix round 2/5 (worker containment addressed; sync/batch/event fencing remained; commit 809a94e)
Task 3: fix round 3/5 (3 addressed, 0 open — sync, terminal batches, and event rejection; commit 9cd0415)
Task 3: complete (commits 51dde27..9cd0415, review clean)
Task 4: fix round 1/5 (3 addressed, 0 open — stranded recovery, ambiguous commit, executable coverage; commit f3e50ad)
Task 4: complete (commits 9cd0415..f3e50ad, review clean)
Task 5: complete (commits f3e50ad..15e18a3, review clean)
Final review: fix wave required — published repair recovery, migration null leases, pre-intent publication failure, attempt_id API, uniqueness test isolation.
Final review fix wave: complete — all five findings addressed; focused 57 passed/21 DB-backed skipped, typecheck and diff check passed; full suite retained 2 baseline-known failing files.
Second fix cycle: publication recovery now requires `execution_publications.last_job_id` to match the recovered job; commit pending.
Corrected publication cycle: complete — older-job publications reopen transactionally for repair, exact-job published recovery remains idempotent, and published-by-other-job failures use generic live/expired execution reconciliation; focused 65 passed/21 DB-backed skipped, typecheck and diff check passed.
