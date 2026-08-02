# Execution Sandbox Containment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Claude execution autonomous for normal implementation while keeping host files, worker Git history, credentials, and publication authority outside the agent's reach.

**Architecture:** Claude executes in a private clone under its native Bubblewrap/Socat sandbox. The worker owns the real worktree, imports the private clone's complete base diff, validates it, and creates the only publishable commit.

**Tech Stack:** Existing TypeScript, Node filesystem/process APIs, Git CLI, Claude Code native sandbox; no new dependencies.

## Global Constraints

- Retain execution `auto`; planning remains `dontAsk`.
- Use Claude sandbox settings with `enabled`, `failIfUnavailable`, and `allowUnsandboxedCommands: false`.
- Strict network egress is limited to Claude service domains; do not permit GitHub.
- The agent clone, never the worker worktree, may receive SDD commits.
- Preserve worker validation, protected-path and secret scans, final squash, push, and PR creation.
- Do not add dependencies, migrations, or a Docker runtime.

---

### Task 1: Isolate agent Git history and import only its final tree

**Files:**
- Modify: `packages/git-runner/src/index.ts`
- Test: `packages/git-runner/src/index.test.ts`

**Interfaces:**
- Produce minimal exported helpers that create a private clone from a worker worktree and apply its full diff from `baseCommit` back to that worker worktree.
- The clone must contain committed and uncommitted source changes, including untracked files, and must never mutate the worker worktree until import.

- [ ] **Step 1: Write the failing integration test**

Create a temporary repository and worker worktree with a known base. Create the private clone, commit one clone-only change and leave another uncommitted/untracked. Import from the clone, then assert the worker tree contains both contents, has no clone commit in its history, and can be committed once from the original base.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `rtk pnpm exec vitest run packages/git-runner/src/index.test.ts`

Expected: the new private-clone/import helper is missing or the worker tree lacks clone output.

- [ ] **Step 3: Implement the minimum helper pair**

Use the existing Git process wrapper plus Node temporary-directory APIs. Clone the source worktree to a worker-owned temporary path, copy its uncommitted and untracked state into that clone, compute `git diff --binary <base>` after intent-to-add for untracked clone files, reset the worker-owned worktree to `<base>`, and apply the binary patch. Reject paths outside the clone/worktree roots and clean up only the private clone path.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `rtk pnpm exec vitest run packages/git-runner/src/index.test.ts`

Expected: PASS and the test proves agent commits never alter worker history directly.

- [ ] **Step 5: Commit**

Commit only the Git runner implementation and its test with `git commit -m "Isolate execution Git history"`.

### Task 2: Enforce Claude's native strict sandbox

**Files:**
- Modify: `packages/claude-runner/src/index.ts`
- Test: `packages/claude-runner/src/index.test.ts`

**Interfaces:**
- Extend `ExecutionInvocation` only with the private execution directory and explicit read-only support paths needed to write a per-run settings file.
- Produce execution arguments containing the generated `--settings` file; planning arguments stay unchanged.

- [ ] **Step 1: Write the failing runner test**

Assert the execution settings passed to Claude enable sandboxing, fail closed, disable unsandboxed fallback, deny home reads except the explicit private execution/prompt/skill paths, deny GitHub/database environment variables to sandboxed Bash, and set a strict Claude-only domain allowlist.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `rtk pnpm exec vitest run packages/claude-runner/src/index.test.ts`

Expected: no per-run strict sandbox settings exist.

- [ ] **Step 3: Implement the minimum per-run settings file**

Use `mkdtemp`, `writeFile(..., { flag: "wx" })`, and the existing cleanup path. Pass the resulting file with `--settings`; preserve the execution auto/tools/disallowedTools contract. Remove `GITHUB_TOKEN`, `GH_TOKEN`, and `DATABASE_URL` from the Claude child environment except where the native sandbox credential settings deny them to Bash. Do not alter planning invocation.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `rtk pnpm exec vitest run packages/claude-runner/src/index.test.ts`

Expected: PASS and settings are exact enough to fail if fail-closed or the GitHub block is removed.

- [ ] **Step 5: Commit**

Commit only runner implementation/tests with `git commit -m "Sandbox Claude execution"`.

### Task 3: Wire private execution into the worker and prove end-to-end handoff

**Files:**
- Modify: `apps/worker/src/worker.ts`
- Test: existing focused worker test file, or a new focused worker integration test if no behavioral seam exists

**Interfaces:**
- Consume the Task 1 clone/import helpers before and after `invokeExecutionClaude`.
- Pass the private clone as `workingDirectory`; leave the worker worktree untouched until import.

- [ ] **Step 1: Write the failing behavioral test**

At the narrowest existing seam, execute the worker preparation/import handoff with a fake successful Claude boundary and assert that invocation receives the private directory while the worker publication path sees imported output based on the saved attempt base. Do not use source-text assertions.

- [ ] **Step 2: Run the focused test to verify it fails**

Run the selected worker test with `rtk pnpm exec vitest run <test-file>`.

Expected: the worker still passes its real worktree to Claude or does not import the sandbox result.

- [ ] **Step 3: Implement the smallest worker wiring**

Create the private clone immediately before execution, invoke Claude inside it, import its final diff only after successful exit, and always clean up the private clone in `finally`. Keep repair behavior by seeding the private clone from the current worker worktree. Preserve the existing base-aware validation and final publish call.

- [ ] **Step 4: Run covering tests**

Run: `rtk pnpm exec vitest run packages/git-runner/src/index.test.ts packages/claude-runner/src/index.test.ts <worker-test-file>` and `rtk pnpm exec tsc --noEmit`.

Expected: PASS.

- [ ] **Step 5: Commit**

Commit only worker code/tests with `git commit -m "Run Claude in private execution clones"`.

### Task 4: Make the host prerequisite and policy enforceable

**Files:**
- Modify: `README.md`
- Modify: `prd.md`
- Modify: `.lfd/dcc-build/harness/eval-cases.json`
- Test: `.lfd/dcc-build/harness/tests/probes/grep-probes.spec.ts`

- [ ] **Step 1: Update the deployment runbook**

Document installing `bubblewrap` and `socat`, the exact Claude-recommended Ubuntu 24.04+ AppArmor profile/reload, and that execution fails closed until sandbox support works. Do not claim Docker is required.

- [ ] **Step 2: Update product policy and evaluation**

Replace guardrail-only language with: private clone, native strict sandbox, no GitHub egress, worker-only import/validation/squash/publication. Point SEC-15 to the exact runner and Git integration tests.

- [ ] **Step 3: Run focused verification**

Run: `rtk pnpm exec vitest run .lfd/dcc-build/harness/tests/probes/grep-probes.spec.ts --root .` and parse `eval-cases.json` with Node.

Expected: PASS; warnings unrelated to this policy may remain inconclusive but no hard failure is allowed.

- [ ] **Step 4: Commit**

Commit only documentation/harness assets with `git commit -m "Document strict execution sandbox"`.

## Final Verification

Run the focused runner, Git runner, worker, and harness suites plus root `rtk pnpm exec tsc --noEmit`. Run a whole-branch review. Confirm the host AppArmor prerequisite is documented, the worker refuses unavailable sandboxing, and only the worker worktree is publishable. Push the branch and open a draft PR after review is clean.
