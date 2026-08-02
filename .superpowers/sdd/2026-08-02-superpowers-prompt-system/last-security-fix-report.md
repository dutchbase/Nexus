# Last security fix report

## Scope

Implemented only the three blockers from `final-fix-rereview.md`.

## Fixes

1. Execution file access now fails closed at both Claude permission layers:
   - `Read` and `Edit` deny rules cover the complete real host home.
   - An immutable `PreToolUse` guard confines `Read`, `Glob`, and `Grep` to the resolved worktree and trusted runtime read roots, confines `Edit` and `Write` to the worktree, and rejects symlink escapes.
   - Execution worktrees and skill bundles default to `$TMPDIR/dcc-execution` through `DCC_EXECUTION_ROOT`, which must resolve outside the host home. The runner independently rejects an in-home execution worktree.
   - Existing fail-closed Bash sandbox, Git metadata, credential, environment, and network protections remain in force.

2. Headless execution can edit noninteractively without granting the parent write tools:
   - Effective `permissions.allow` contains only `Edit(<worktree>)` and `Edit(<worktree>/**)` for modifications; Claude's `Edit` permission governs both `Edit` and `Write` tools.
   - The parent tool list remains `Read,Glob,Grep,Skill,Agent`; only the named implementation/repair subagents expose `Edit` and `Write`.
   - Tests execute the actual file guard command extracted from emitted effective settings, rather than relying only on fake CLI argv inspection.

3. Automated PR review no longer calls GitHub's merge API:
   - `review_and_merge` returns no merge binding even for an approved verdict, because GitHub's merge REST operation cannot atomically bind the reviewed base SHA.
   - Review and comment publication still complete; a human must perform the merge.
   - Manual administrator merge behavior and the prior head/base audit checks were not weakened.

## TDD evidence

The initial focused run failed on the intended behaviors:

- approved `review_and_merge` still produced a head/base merge binding;
- emitted execution settings lacked full-home built-in file denies, worktree edit approval, and a file-tool hook;
- the immutable guard had no file-tool boundary;
- in-home execution roots were still accepted.

After the minimal implementation, the focused suite passed: 4 files, 24 tests.

## Final verification

- `pnpm test:unit` — 27 files, 103 tests passed.
- `pnpm exec tsc --noEmit` — passed.
- `git diff --check` — passed.
- No dependency changes, publish, push, merge, or PR creation.

## Platform note

A live model/tool smoke remains unavailable on this host because the installed Claude sandbox prerequisites (`socat`, Bubblewrap/AppArmor setup) are not provisioned. Execution continues to fail closed when that sandbox is unavailable. The regression suite instead executes the real immutable hook command from the emitted effective configuration, covering allowed worktree reads and denied host-home reads without a network/model turn.
