# Local Release Verification Design

## Goal

Deploy protected-branch pushes without GitHub Actions or GitHub REST API
availability. A release remains fail-closed: it is promoted only after local
verification, migration, process reload, and health checks succeed.

## Scope

- GitHub's signed `push` webhook for `refs/heads/master` is the deployment
  trigger. `check_run` events and the `ci` requirement are removed from the
  webhook path.
- The webhook queues the signed target SHA without asking GitHub's REST API for
  CI status or branch-head data. It continues to reject non-protected refs.
- `deploy.sh` remains the sole exact-head gate. Its existing `git fetch origin
  <protected-branch>` check must match the queued SHA before a release worktree
  is staged or any migration can run.
- After dependencies are installed in the detached release worktree,
  `pnpm verify` runs locally before database migration. Test-only database
  environment variables are unset for that command so a production deployment
  cannot opt into database integration tests.
- A passed local verification is recorded as a deployment stage event. A failed
  verification uses the existing rollback/failure path and leaves the current
  release live.

## Explicit Non-Goals

- No GitHub Actions workflow, API polling, retry service, new dependency, or
  deployment dashboard.
- No bypass for a stale SHA, local verification failure, migration failure, or
  health-check failure.
- No change to the user-disabled GitHub Actions workflow configuration.

## Data Flow

1. GitHub signs and sends a `master` push webhook.
2. The webhook durably queues its SHA and launches the existing deployment
   process under its lease.
3. `deploy.sh` fetches `master` and rejects the attempt unless it still equals
   the queued SHA.
4. The release worktree installs locked dependencies, runs local verification,
   then migrates and follows the existing cutover, health, rollback, and marker
   protocol.

## Tests

- Webhook tests prove a signed `master` push queues without GitHub API access,
  while other refs remain ignored.
- Deployment-script tests prove local verification occurs after locked install,
  before migration, with database-test variables removed, and that the stage is
  recorded only after it succeeds.
- Existing webhook/deployment failure tests continue to prove no stale or
  failed release is promoted.
