# Execution Sandbox Design

## Decision

Use Claude Code's native Linux Bash sandbox, not a custom container runtime. It is already part of the installed CLI and uses Bubblewrap plus Socat for OS-enforced filesystem and network isolation. The worker will fail closed if sandboxing is unavailable or an agent requests an unsandboxed retry.

Each execution runs in a temporary private Git clone rather than the worker's real worktree. The clone lets SDD create local commits without access to the real repository's shared `.git` metadata. After Claude exits, the worker imports the clone's full diff from the saved execution base into its own worktree, then runs the existing validation, protected-path scan, secret scan, squash, push, and PR workflow.

## Security boundary

- Bash may write only the private clone and session temporary directory.
- Bash may read the private clone, execution prompt, and materialized skill bundle; home is denied except for those explicit paths.
- The sandbox has strict egress only to Claude service domains; GitHub is unavailable.
- Unsandboxed fallback is disabled and unavailability is fatal.
- GitHub/database secrets are removed from sandboxed Bash. The outer Claude process retains only the Claude OAuth token it needs.
- The worker's real worktree and its Git refs are never mounted into the agent's mutable filesystem.

## Deployment prerequisite

Linux deployments need `bubblewrap` and `socat`. Ubuntu 24.04+ also needs the narrowly-scoped AppArmor profile recommended by Claude Code so Bubblewrap can create a user namespace. The worker remains unavailable for execution until that prerequisite is met; it must not silently fall back to unsandboxed Bash.

## Verification

An integration-style Git test will create a private clone, make committed and uncommitted changes there, import the resulting base diff into the worker worktree, and verify the worker can create one final scanned commit. Runner tests will assert strict sandbox settings and the execution-only CLI arguments. Documentation and harness policy will require the native sandbox/AppArmor prerequisite.
