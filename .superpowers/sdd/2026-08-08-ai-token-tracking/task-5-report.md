# Task 5 report — admin AI usage

## RED

Command:

```sh
npx vitest run apps/web/src/pages/ai-usage.test.ts apps/web/src/pages/runs.test.ts apps/web/src/nav-a11y.test.ts
```

Result: failed as intended before implementation: `./ai-usage.ts` did not exist; the new navigation expectation failed; and the run-detail accounting/prompt expectation failed.

## GREEN

Focused checks:

```sh
npx vitest run apps/web/src/pages/ai-usage.test.ts
npx vitest run apps/web/src/pages/runs.test.ts apps/web/src/nav-a11y.test.ts
npx vitest run apps/web/src/ai-usage-route.test.ts
```

Result: 10 tests passed. They exercise dashboard default/filter and keyset queries, coverage/not-captured rendering, escaped prompt visibility, run-detail accounting, Operate navigation, and authenticated routing.

Full test run:

```sh
npx vitest run --config vitest.config.ts --reporter=verbose
```

Result: passed (exit code 0).

Type check:

```sh
npx tsc --noEmit
```

Result: blocked by pre-existing workspace errors in `apps/web/src/ai-model-prices.test.ts`, `apps/web/src/server.ts`, and `packages/claude-runner/src/index.ts`; Task 5's own test typing errors were corrected before the final test run.
