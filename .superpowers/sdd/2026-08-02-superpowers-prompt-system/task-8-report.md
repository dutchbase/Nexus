# Task 8 report — deployment and upstream automation

## Scope

- `deploy.sh` now uses a fail-fast sequence: locked install, database
  migration, agent-content sync, then PM2 application and webhook restarts.
  Its completion marker records the actual result on either path.
- The new daily/manual workflow resolves a release tag, shallow-checks it out,
  imports the configured allowlist, runs Vitest, and opens a reviewable
  `automation/superpowers-<tag>` PR. It uses only the checkout, pnpm, and Node
  actions already used by CI.
- CI no longer swallows Vitest failures. README covers deployment, rollback,
  and a manually supplied update tag.

## TDD evidence

Red:

```text
pnpm exec vitest run scripts/task-8.test.ts --reporter=verbose

3 failures: deploy.sh had no isolated root/order guard and the update workflow
did not exist.
```

Green:

```text
pnpm exec vitest run scripts/task-8.test.ts --reporter=verbose

1 file passed, 3 tests passed.

pnpm exec tsc --noEmit
git diff --check
```

The full Vitest command was also run. It reports the existing evaluation-suite
environment failures because `DCC_EVAL_ADMIN_USER` and
`DCC_EVAL_ADMIN_PASSWORD` are unset; unrelated Playwright suites are also
discovered by Vitest. Task 8's focused suite passes.
