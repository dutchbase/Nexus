# Final sandbox containment fix report

## Status

Complete. All five final-review findings are covered by code and behavioral tests.

## Finding map

### C1 — sandbox read boundary

- `packages/claude-runner/src/index.ts` denies Bash reads from `/` and re-allows only the disposable clone.
- Built-in `Read`, `Glob`, `Grep`, `Edit`, and `Write` tools are removed and hard-denied so they cannot bypass the Bash sandbox.
- `packages/git-runner/src/index.ts` removes the private clone's `origin` before agent execution.
- `packages/claude-runner/src/index.test.ts` and `apps/worker/src/execution-handoff.test.ts` assert the root-deny/clone-allow policy, Bash-only execution tool surface, clone-relative inputs, and absent origin.

### C2 — host prompt and skill bundle

- `apps/worker/src/execution-handoff.ts` copies the execution prompt, approved plan, and complete materialized skill tree under `.git/dcc-support` inside the disposable clone.
- Claude receives only clone-relative prompt and skill paths. Edits to the disposable skill copy cannot mutate the persistent host bundle.
- `apps/worker/src/worker.ts` references the clone-local approved plan.
- `apps/worker/src/execution-handoff.test.ts` reads all copied inputs through the invocation and proves a clone edit leaves the host skill unchanged.

### C3 — hostile Git configuration

- `packages/git-runner/src/index.ts` copies only the agent working tree into worker-owned staging; no import Git command runs against the agent-owned `.git` directory.
- Staging Git disables system/global configuration, hooks, fsmonitor, external diff, text conversion, and external attributes before deriving and checking the binary patch.
- `packages/git-runner/src/index.test.ts` installs a hostile `diff.external` command in the agent clone and proves it is never executed while the intended tree is imported.

### C4 — validation containment and final scan

- Validation commands run through Bubblewrap with a cleared environment, hidden persistent home paths, an isolated temporary directory, and an unshared network namespace.
- The Node toolchain and candidate workspace are the only writable/useful execution mounts.
- The changed tree is re-enumerated and protected-path/secret-scanned after every configured validation command finishes; commit-time staged scanning remains in place.
- `packages/git-runner/src/index.test.ts` executes an agent-authored malicious script and proves the worker secret is absent, loopback egress is blocked, and a credential created after the initial scan is rejected by the final scan.

### I1 — failed import preservation

- Import derives and checks the candidate patch in worker-owned staging before touching the publishable worktree.
- The prior worker tree is snapshotted and restored if the verified patch fails during the final handoff.
- `packages/git-runner/src/index.test.ts` injects an apply failure and proves the prior repair output survives unchanged.

## TDD proof

RED, before production edits:

- Focused suites: 8 failed, 13 passed.
- Failures directly observed host support paths, unrestricted tools/read policy, worker-secret exposure, reachable loopback, retained origin, hostile Git configuration, and lost repair output.

GREEN, final verification:

- `rtk pnpm exec vitest run packages/claude-runner/src/index.test.ts packages/git-runner/src/index.test.ts apps/worker/src/execution-handoff.test.ts .lfd/dcc-build/harness/tests/probes/grep-probes.spec.ts --root .` — 23 passed.
- `rtk pnpm exec tsc --noEmit` — passed.
- `eval-cases.json` parse — passed.
- `git diff --check` — passed.

## Commit

One cohesive local commit: `Harden execution sandbox containment`. The exact SHA is recorded in the final handoff because a commit cannot contain its own hash.

## Final review

Independent post-fix review found two remaining Important issues: a post-agent Git root check and a full-root validation bind. Both received focused fixes and RED/GREEN verification. Re-review found no remaining Critical or Important findings and returned a merge-ready verdict.

## Remaining concerns

- This Codex environment does not permit a nested network namespace (`bwrap: loopback: Failed RTM_NEWADDR`). The behavioral test therefore uses a strict Bubblewrap boundary double that rejects missing `--unshare-net`/`--clearenv`, executes the malicious script with an empty environment, and blocks its HTTP call. Production remains fail-closed on the documented Bubblewrap/AppArmor host prerequisite.
- The existing secret scanner recognizes the repository's two configured credential shapes; expanding that independent policy is outside this fix.
