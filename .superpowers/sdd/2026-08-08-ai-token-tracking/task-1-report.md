# Task 1 report — immutable pricing and invocation accounting

## Scope delivered

- Added migration `050_ai_invocation_accounting.sql` (the repository already contains `049`, so `050` is the next valid migration) with immutable effective-dated `ai_model_prices`, the required `agent_runs` accounting metadata, nullable legacy-safe constraints, and approved Anthropic/DeepSeek seed rates.
- Added domain provider/lifecycle mapping, pending invocation creation, idempotent captured/unavailable recording, SQL effective-price selection, persisted total/cost calculation, and all invocation prompt phases.
- Added focused unit and database integration coverage. No worker instrumentation or UI work was performed.

## TDD evidence

RED: `pnpm exec vitest run packages/domain/src/ai-accounting.test.ts --exclude '.worktrees/**'` failed 4/4 before implementation because `providerForModel`, `createAiInvocation`, and `recordAiUsage` did not exist.

GREEN: the same focused test now passes 4/4. The final focused command passed 24 tests across 3 files, with 23 existing/environment-dependent skips and no failures. `pnpm exec tsc --noEmit` also passed.

## Files

- `packages/database/migrations/050_ai_invocation_accounting.sql`
- `packages/domain/src/index.ts`
- `packages/domain/src/prompts.ts`
- `packages/domain/src/ai-accounting.test.ts`
- `packages/domain/src/ai-accounting.db.test.ts`

## Verification

- `git diff --check` passed.
- `pnpm exec vitest run packages/domain/src/ai-accounting.test.ts packages/domain/src/ai-accounting.db.test.ts packages/domain/src/prompts.test.ts packages/database/src/migrate.test.ts --exclude '.worktrees/**'` passed: 24 passed, 23 skipped, 0 failed.
- `pnpm exec tsc --noEmit` passed.

## Commit

`feat(domain): persist AI invocation accounting`

## Concerns

- The database integration test was skipped because neither `DCC_TEST_DATABASE_URL` nor a reachable local PostgreSQL instance is available in this worktree. It covers effective-date selection, historic price retention, unpriced captured usage, and legacy null rows when run in the database-enabled CI environment.
- Seed sources are the official [Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing) and [DeepSeek models/pricing](https://api-docs.deepseek.com/quick_start/models) URLs. DeepSeek has no separately reported cache-write token rate, so its approved cache-write rate is zero.
