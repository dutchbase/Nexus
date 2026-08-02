# Task 8 repair 1 — completion marker ordering

`deploy.sh` writes the successful completion marker after the web/worker
restart and before restarting `dcc-webhook`. The EXIT trap now writes markers
only for failures, preserving failure reporting before that point.

Red:

```text
pnpm exec vitest run scripts/task-8.test.ts --reporter=verbose

expected marker "79" to be "0": the fake webhook restart rejected a missing
pre-restart marker.
```

Green:

```text
bash -n deploy.sh
pnpm exec vitest run scripts/task-8.test.ts --reporter=verbose
pnpm exec tsc --noEmit
git diff --check

1 file passed, 3 tests passed.
```
