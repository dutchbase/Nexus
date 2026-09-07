# Nexus audit fixes

**Report date:** 6 September 2026

> **Status: all 39 confirmed findings and 23 qualified follow-ups are remediated, independently reviewed and verified.** The original audit remains unchanged in [`audit-2026-09-06.md`](./audit-2026-09-06.md). This report records the completed work without claiming production perfection or live-provider validation.

## What changed

**Ticket images now display correctly and can be used by the agents.** People can preview or download uploaded evidence from a ticket, and the same approved image reaches planning and execution.

Other changes make cancellation and retries reliable, prevent merges from using changed branches, keep prompt history when a prompt is archived, verify that backups can be restored, improve public forms, add a working sign-out control, and make automated tests safe to run in isolation.

| Scope | Count | Current disposition |
|---|---:|---|
| Confirmed audit findings | 39 | Fixed and verified |
| Qualified follow-ups | 23 | Remediated or explicitly retained; verified |
| Original audit changes | 0 | Preserved as the evidence source |

## Final verification

All local integrated gates passed on the settled source tree.

- Final combined TypeScript/unit gate: **145 files passed, 18 skipped; 1,033 tests passed, 81 skipped**. TypeScript passed.
- Final database gate: **21 files / 117 tests passed**, each in a fresh PostgreSQL 16 database. The separate real restore drill passed **1 file / 1 test**, for **22 files / 118 database tests** overall.
- Final isolated browser gate: **38/38 journeys passed** in 2.1 minutes.
- Standalone visual sweep: **1/1 passed** in 25.3 seconds and retained exactly **170 PNG screenshots** in the external per-run artifact directory, with no new checkout writes.
- Additional Chromium/API checks all passed with zero page errors: image upload plus decoded preview/download, read-only ticket GET, distinct matching CSP nonces with an untrusted inline script blocked, queue filters, SHA-pinned default-branch merge against a temporary bare Git repository with explicit confirmation and temporary-ref cleanup, logout and session invalidation.
- Frozen install passed and `pnpm audit --json` reported **zero advisories** at every severity.

### Earlier focused evidence

- Web/domain focused run: **84 files passed, 9 skipped; 449 tests passed, 20 skipped**. Two real PostgreSQL web regressions passed, including concurrent upload claims and prompt archival.
- Integration/provider focused run: **9 files, 131 tests passed**. No live GitHub or GHCR writes were made.
- Operations focused run: **9 files, 103 tests passed**. A real PostgreSQL 16 recovery test exercised both a recorded corrupt failure and a successful restore.
- Parent database gate before the last workflow/security additions: **17 files, 107 tests passed**, each in its own fresh database. Four later workflow lock-race tests also passed.
- Parent login-quota database regression: **3/3 passed** in a fresh isolated PostgreSQL database.
- Final security-owner web run: **62 files passed, 7 skipped; 290 tests passed, 10 skipped**. Focused CSP/merge checks passed **6 files / 31 tests**, and the real login route passed **2/2**.
- Stable worker/runner aggregate: **294 tests passed, 4 opt-in database tests skipped**; those four separately passed on migrated PostgreSQL 16.
- Runner-focused evidence: Claude **40**, Git runner **44**, and OpenCode **24** tests passed, including TERM-ignoring descendant cleanup.
- Safe isolated Playwright harness before the final security/provider tail: **38/38 passed** in 2.2 minutes. Cleanup isolation also passed and retained logs/results outside its disposable data root.
- Frozen offline install passed. `pnpm audit --json` reported **0** info, low, moderate, high or critical advisories.
- TypeScript passed after the last resolved test typing correction; the final combined run above supersedes these focused counts.

## Confirmed findings ledger

Every confirmed item below is implemented and included in the completed integrated verification above.

### Integrations, promotion and notification

| ID | Root cause and repair | Implementation and focused verification | Disposition |
|---|---|---|---|
| INT-01 | PostgreSQL supplied `Date` values to a string-only workflow filter. Workflow discovery now accepts `Date \| string` and compares epoch milliseconds. | `packages/github-provider/src/actions.ts`; `actions.test.ts`, `provider-jobs.deployment.test.ts` | Fixed and verified |
| INT-02 | Polling refreshed `updated_at` and indefinitely postponed the stuck-release deadline. Both mechanisms measure the timeout from immutable `created_at`. | `apps/worker/src/provider-jobs.ts`; `provider-jobs.deployment.test.ts` | Fixed and verified |
| INT-03 | Promotion could validate a later master SHA and deploy the earlier one. Eligibility, image and E2E evidence now consume the already pinned commit. | `apps/worker/src/provider-jobs.ts`; `provider-jobs.production-promotion.test.ts` | Fixed and verified |
| INT-04 | Open-PR lookup filtered only by head and could reuse a PR targeting another base. Lookup and both callers now bind the requested base. | `packages/github-provider/src/index.ts`, `apps/worker/src/provider-jobs.ts`, `execution-publication.ts`; provider/publication tests | Fixed and verified |
| INT-05 | Bulk close updated the cached PR but skipped the canonical ticket transition. It now calls `setPullRequestTicketStatus`, including crash-retry repair while preserving merged/admin-terminal states. | `apps/worker/src/provider-jobs.ts`, `packages/domain/src/pull-request-sync.ts`; `close-pull-request-job.test.ts`, `pull-request-sync.test.ts` | Fixed and verified |
| INT-06 | A redacted string crossed an `Error`-only notification helper and was replaced by a generic message. The helper accepts and persists the actual redacted diagnostic. | `packages/domain/src/notifications.ts`; `notifications.test.ts`, `notifications.db.test.ts` | Implemented; real PG passed |
| INT-07 | The newest unrelated workflow hid the configured build/deploy workflow. Discovery selects a stable workflow identity containing all configured jobs, with bounded run/job pagination and an aggregate deadline. | `packages/github-provider/src/actions.ts`, `apps/worker/src/provider-jobs.ts`; actions/deployment tests | Fixed and verified |
| INT-08 | GHCR token/manifest reads had no deadline and advisory checks could stall promotion. One bounded abort signal covers the operation and timeout maps to advisory `unknown`. | `packages/github-provider/src/registry.ts`; `registry.test.ts`, promotion tests | Fixed and verified |
| INT-09 | An hour-bucket key replayed failed/refused promotion jobs. A retained per-click UUID dedupes one request while a later deliberate retry gets a fresh key immediately. | `apps/web/src/server.ts`, `ui.ts`; `production-promotion-routes.test.ts` | Fixed and verified |

### Operations, persistence and configuration

| ID | Root cause and repair | Implementation and focused verification | Disposition |
|---|---|---|---|
| OPS-1 | Migration 062 assumed production UUIDs and failed on ordinary duplicate repositories. Corrected migration 062 and forward migration 063 deterministically retain a configured-path survivor, retire duplicates without deleting append-only history, and enforce case-insensitive identity; migration 059 is now a portable no-op. | `packages/database/migrations/059_*`, `062_*`, `063_*`; `va-jobs-platform-reconciliation.db.test.ts`, `operations-migrations.test.ts` | Implemented; real PG passed |
| OPS-2 | Prompt Delete attempted to delete immutable versions. UI/API now archive by clearing `active_version_id`; the legacy action aliases archive and history remains intact. | `apps/web/src/server.ts`, `pages/projects.ts`; `project-prompt-archive.test.ts`, `.db.test.ts` | Implemented; real PG passed |
| OPS-3 | Primary and legacy aliases of one physical artifact root were swept independently. Reconciliation canonicalizes roots, unions registrations and sweeps each physical root once. | `packages/database/src/artifacts.ts`, `scripts/reconcile-artifacts.ts`, `apps/worker/src/worker.ts`; `artifacts.test.ts` | Fixed and verified |
| OPS-4 | Restore outcome SQL used unsupported psql interpolation in `-c`. It now uses stdin, records failed and successful outcomes, verifies registry hashes/bytes and restored data/config identities, and removes checkout-specific `.git` pointers from archived worktrees. | `scripts/backup.sh`, `restore-drill.sh`, `verify-artifact-registry.mjs`; `backup.test.ts`, `backup.integration.test.ts` | Implemented; real restore passed |
| OPS-5 | Same-SHA deployment retries collided with existing release paths. Retries accept only the exact expected symlinks and refuse conflicting files/links without deleting them. | `deploy.sh`; `scripts/task-8.test.ts` | Implemented; focused test passed |
| OPS-6 | YAML import dropped disabled state, agent path and defaults. Normalization maps columns, merges documented defaults, validates effective config and relies on the existing material-change version trigger. | `scripts/import-projects.ts`, `packages/project-config/src/index.ts`; `import-projects.test.ts`, project-config tests | Fixed and verified |
| OPS-7 | Content sync treated explicitly inactive prompts as new and reactivated them. Prior version history now distinguishes inactive existing prompts from a new prompt. | `scripts/sync-agent-content.ts`; `superpowers-content.test.ts` | Implemented; focused test passed |

### Workflow, orchestration and runners

| ID | Root cause and repair | Implementation and focused verification | Disposition |
|---|---|---|---|
| WF-01 | Global Claude preflight blocked DeepSeek work. The worker claims first and preflights only the selected provider/job. | `apps/worker/src/worker.ts`, `worker-loop.ts`; `worker-loop.test.ts`, `task-7.test.ts` | Fixed and verified |
| WF-03 | Initialization/finalization could overwrite a concurrent cancellation. Both lock and recheck ticket/run state before atomic transitions and publication. | `apps/worker/src/workflow-state.ts`, `worker.ts`; `workflow-state.test.ts`, `.db.test.ts` | Implemented; 4 real PG races passed |
| WF-04 | Validators lacked deadline/cancellation. Detached process groups now have abort, timeout, bounded output and TERM-to-KILL escalation. | `packages/git-runner/src/index.ts`; `index.test.ts` | Implemented; 44 runner tests passed |
| WF-05 | OpenCode/Claude persistence rejections escaped as unhandled promises. Handlers attach immediately, retain the first write error and drain outstanding writes before rejection. | `apps/worker/src/opencode.ts`, `packages/claude-runner/src/index.ts`; runner tests | Implemented; focused tests passed |
| WF-06 | Review publication retry skipped requested merge intent. An idempotent `afterPublish` hook runs for fresh, resumed and already-published paths and enqueues the pinned merge. | `packages/domain/src/pr-review-publication.ts`, `apps/worker/src/worker.ts`; publication tests | Fixed and verified |
| WF-07 | A busy claim loop starved heartbeat and maintenance. Independent timers keep heartbeats active and prevent maintenance overlap; one injectable tick provides a test seam. | `apps/worker/src/worker-loop.ts`, `worker.ts`; `worker-loop.test.ts` | Implemented; focused test passed |
| WF-08 | Shutdown was recorded as user cancellation. Worker interruption has its own outcome, while canonical cancellation stays reserved for user/admin action. | `apps/worker/src/workflow-state.ts`, `worker.ts`; workflow-state tests | Fixed and verified |
| WF-09 | Uploaded screenshots stopped at intake. Finalized image identity is approval-bound; the worker verifies hash/size and supplies private read-only controlled copies to Claude/OpenCode and handoffs. | `packages/domain/src/planning-inputs.ts`, `apps/worker/src/image-evidence.ts`, `execution-handoff.ts`; planning/image/handoff tests | Implemented; focused tests passed |
| WF-10 | Pre-initialization failures could leave attempts queued and race lock order. Exact-job failure and expiry recovery lock ticket before job and reconcile atomically, preserving terminal cancellation. | `apps/worker/src/workflow-state.ts`, `worker.ts`; `workflow-state.test.ts`, `.db.test.ts` | Implemented; 4 real PG races passed |
| WF-11 | Review/conflict jobs accepted cancellation but handlers did not observe it. Signals reach subprocess/validation and a final transaction fence blocks publication; conflict logs are finalized artifacts. | `apps/worker/src/worker.ts`, `worker-boundary.ts`; workflow/cancellation tests | Fixed and verified |

### Intake, tickets, UI and verification

| ID | Root cause and repair | Implementation and focused verification | Disposition |
|---|---|---|---|
| WEB-01 | Upload records omitted the finalized artifact path and reads guessed roots. Reads now trust registered root/path/status/SHA and use legacy fallback only when no registry row exists. | `apps/web/src/server.ts`; `public-intake-upload.test.ts`, `attachment-download-auth.test.ts` | Implemented; browser image passed |
| WEB-02 | Ticket attachments exposed only a download. Ticket detail now renders a lazy authenticated inline image with alt text plus an explicit original download. | `apps/web/src/pages/tickets.ts`, `server.ts`; `ticket-attachments.test.ts` | Implemented; browser image passed |
| WEB-03 | Submission trusted and claimed uploads incompletely. It accepts IDs only from declared image fields, validates/locks exact finalized rows and claims them in the ticket transaction. | `apps/web/src/server.ts`; `public-intake-upload.test.ts`, `.db.test.ts` | Implemented; concurrent real PG passed |
| WEB-04 | Server validation diverged from controls and admin edits bypassed it. Shared boundary checks cover required booleans, optional/finite numbers, ranges, options and candidate form edits under lock. | `apps/web/src/server.ts`; validation/edit/form-boundary tests | Implemented; focused tests passed |
| WEB-05 | Normal ticket view hid saved structured input. It renders standard fields and all saved custom values, including values for later-removed fields. | `apps/web/src/pages/tickets.ts`; `tickets-get-no-mutation.test.ts` | Implemented; focused test passed |
| WEB-06 | No UI sign-out control existed. Admin navigation now posts the existing CSRF-protected logout route, clears the session and returns to login. | `apps/web/src/ui.ts`; `web-audit-ui.test.ts`, `auth.spec.ts` | Implemented; browser logout passed |
| WEB-07 | Every page displayed a fabricated healthy worker. The static indicator was removed; measured health pages remain authoritative. | `apps/web/src/ui.ts`; `web-audit-ui.test.ts` | Implemented; focused test passed |
| WEB-08 | Generic ticket PATCH bypassed the cancellation cascade. `Cancelled` delegates to the canonical locked transition and cannot be mixed with unrelated edits. | `apps/web/src/server.ts`; `ticket-cancel-cascade.test.ts` | Implemented; focused test passed |
| WEB-09 | Form builder could publish unroutable/unrenderable forms. Create/edit/publish validate slug, routing, core fields and required attachments on one locked candidate snapshot; public controls expose native constraints/help. | `apps/web/src/server.ts`, `ui.ts`; `form-boundaries.test.ts`, submission tests | Implemented; focused tests passed |
| WEB-10 | E2E cleanup used fixed names, broad process kills and checkout data deletion. Harness resources are per-run, marker/PID-owned, credential-scrubbed and cleaned precisely; artifacts live outside the disposable root. | `tests/e2e/run-e2e.sh`, `verify-cleanup.sh`, CI workflow | Implemented; cleanup + 38/38 passed |
| WEB-11 | Seed collided on a fresh migrated database and was not repeatable. Inserts tolerate migration-owned rows, project skills are conflict-safe, notifications are disabled and the seed runs twice in a real DB test. | `tests/e2e/fixtures/seed.sql`, `seed.db.test.ts` | Implemented; real PG passed |
| WEB-12 | CI skipped browser journeys and DB suites. CI runs frozen unit verification, discovers DB-gated files into isolated PG16 databases, performs real restore setup, runs cleanup/full browser journeys and uploads retained artifacts. Visual screenshots use Playwright's per-test output path, so successful evidence is isolated and included in that upload. | `.github/workflows/ci.yml`, `vitest.config.ts`, `tests/e2e/visual-sweep.spec.ts`, E2E helpers/mocks | Implemented; 38/38 + visual 1/1 passed |
| WEB-13 | Vitest's dependency graph carried six advisory matches. Vitest 3.2.7, Vite 6.4.3 and nanoid 3.3.11 are pinned within the existing Node floor. | `package.json`, `pnpm-lock.yaml`; frozen install and audit | Implemented; audit 0 |

## Qualified follow-up ledger

These items were not counted as confirmed findings in the original audit. They remain separate here even when one implementation closes several related risks.

### Integration follow-ups (5)

| ID | Follow-up disposition | Implementation and evidence | Status |
|---|---|---|---|
| INT-F1 branch preview/ref race | Web and worker require valid expected head and base SHAs. Atomic `updateRefs` creates a temporary ref at reviewed base, GitHub merges the pinned head into it, then a second CAS updates base and removes the temporary ref. Ref movement fails closed; cleanup is ownership-checked and recoverable. | `apps/web/src/server.ts`, `apps/worker/src/provider-jobs.ts`, `packages/github-provider/src/index.ts`; route/provider tests; mock GitHub real-bare-repo tests | Fixed and verified |
| INT-F2 rollback ref race | Rollback uses GraphQL ref CAS with `beforeOid=expectedProductionSha`, target commit and force semantics, so an external ref move is not overwritten. | provider implementation/tests | Fixed and verified |
| INT-F3 check conclusion policy | The product policy now consistently treats completed `success`, `skipped` and `neutral` checks as successful required checks. | `packages/github-provider/src/index.ts`; provider policy tests | Retained product choice, tested |
| INT-F4 ruleset-only policy | Exact-branch rules and classic protection are combined using the strictest approvals and unioned required checks; unsupported review constraints produce an incomplete result. | `packages/github-provider/src/index.ts`; ruleset tests and E2E mock route | Fixed and verified |
| INT-F5 PR publication race | After create failure, publication repeats exact head/base lookup: a concurrently created matching PR is linked; otherwise the original provider failure remains. | `apps/worker/src/execution-publication.ts`; `publish-artifact-atomicity.test.ts` | Fixed and verified |

### Operations/security follow-ups (6)

| ID | Follow-up disposition | Implementation and evidence | Status |
|---|---|---|---|
| OPS-F1 account/IP login quota | Sorted account/IP advisory locks make quota reservation atomic. A successful login marks only its own reservation, preserving shared-IP failures. | `apps/web/src/login-quota.ts`, `server.ts`; `login-quota.db.test.ts`, `login-route.db.test.ts` | Implemented; parent PG 3/3 passed |
| OPS-F2 nonce CSP | Trusted renderer scripts receive one per-response nonce and `script-src` drops `unsafe-inline`; native event listeners replace inline handlers. Inline style attributes retain the documented style allowance. | `apps/web/src/security.ts`, `server.ts`, UI/pages; security/CSP tests and browser CSP probe | Fixed and verified |
| OPS-F3 recovery content assurance | Backup coordinates an artifact metadata fence, hashes registered bytes/worktree commits, writes a manifest-covered ledger, and restore validates registry/path/hash plus service root identities. | backup/restore scripts and health route; real `backup.integration.test.ts` | Implemented; real restore passed |
| OPS-F4 migration checksums | Newly applied SQL stores SHA-256/source and future runs reject mutation. Existing/renamed rows receive a clearly labeled first-seen `legacy_baseline`. | `packages/database/src/migrate.ts`; `migrate.test.ts` | Implemented; focused test passed |
| OPS-F5 CI recovery coverage | CI provisions two explicitly disposable PG16 databases with matching clients and runs the repaired real backup integration. | `.github/workflows/ci.yml`, `scripts/backup.integration.test.ts` | Fixed and verified |
| OPS-F6 portable project seed/repository identity | Migration 059 no longer enables an external project on new installs; repository uniqueness is case-insensitive and duplicates are reconciled without erasing history. | migrations 059/062/063; real migration tests | Implemented; real PG passed |

### Workflow/runner follow-ups (7)

| ID | Follow-up disposition | Implementation and evidence | Status |
|---|---|---|---|
| WF-02 same-attempt worktree recovery | A retry reuses only a contained worktree on the expected branch/common Git dir whose approved base remains an ancestor. New worktrees are removed with their branch if initialization fails; reused progress is preserved. | `packages/git-runner/src/index.ts`, `apps/worker/src/worker.ts`; real temporary-repository tests | Implemented; 44 runner tests passed |
| WF-F1 pre-aborted Claude setup | Claude checks abort before spawn and again after async setup, so a cancellation during setup cannot start the agent. | `packages/claude-runner/src/index.ts`; runner tests | Implemented; 40 tests passed |
| WF-F2 process-tree cancellation | Claude, Git validation and OpenCode use owned process groups, TERM/KILL escalation and Linux start-time checks; escalation survives direct-child exit while a descendant remains. | three runner implementations/tests | Implemented; 40/44/24 tests passed |
| WF-F3 publication snapshot | Review retry uses the approved owner/repository/default branch snapshot and exact-base PR lookup rather than live project config. | `apps/worker/src/execution-publication.ts`; publication tests | Fixed and verified |
| WF-F4 expired cancellation recovery | `cancellation_requested` work is recovered as cancellation and cannot be requeued into active ticket state. | `apps/worker/src/workflow-state.ts`; unit + real PG race tests | Implemented; real PG passed |
| WF-F5 conflict diagnostics | Bounded conflict logs are staged/finalized as persistent artifacts instead of disappearing with temporary directories. | `apps/worker/src/worker.ts`; conflict workflow tests | Fixed and verified |
| WF-F6 worker test seam | A small `runWorkerTick` boundary exposes claim/dispatch/idle behavior without introducing an orchestration framework. | `apps/worker/src/worker-loop.ts`; `worker-loop.test.ts` | Implemented; focused test passed |

### Intake/public workflow follow-ups (5)

| ID | Follow-up disposition | Implementation and evidence | Status |
|---|---|---|---|
| WEB-I1 read-only ticket GET | Admin ticket GET no longer mutates Submitted to Triage; acknowledgment stays explicit. | `apps/web/src/server.ts`; `ticket-api-readonly.test.ts` | Implemented; focused test passed |
| WEB-I2 safe submission retries | UI blocks concurrent clicks, retains unchanged upload IDs and one idempotency key through network/429/5xx retries, rotates after definite validation rejection, and preserves inputs/errors. Server checks cached success before quota/current-form validation and serializes concurrent keys. | `apps/web/src/ui.ts`, `server.ts`; submission/upload unit + real PG tests | Implemented; real PG passed |
| WEB-I3 board truncation | Board fetches one row beyond its 200-card cap and clearly directs users to filters/table view when older cards are hidden. | `apps/web/src/pages/tickets.ts`; `tickets-board-limit.test.ts` | Implemented; focused test passed |
| WEB-I4 safe Markdown/diff | Renderer escapes HTML, restricts link schemes and supports declared headings/fences/tables/lists. Diff aligns lines by bounded LCS after common edges, with a truthful delete/add fallback above one million cells. | `apps/web/src/pages/shared.ts`; `shared.test.ts` | Implemented; focused tests passed |
| WEB-I5 form instructions/help | Public forms render escaped static instructions, descriptions, placeholders, required state and numeric limits with accessible native controls. | `apps/web/src/ui.ts`; submission/UI tests | Implemented; focused tests passed |

## Operational boundaries and retained choices

- No live GitHub, model-provider or deployment writes were used. GitHub behavior is checked with a controlled mock that operates on temporary bare Git repositories and models atomic ref CAS, including zero-OID create/delete.
- Screenshot delivery is verified through selection, approval hashing, byte/hash validation and runner file/argument boundaries. It does not prove that a live model understood an image.
- Legacy migration checksums are first-seen baselines, not recovered historical signatures. New installations start with an empty project registry.
- Worktree backups are content/evidence archives without checkout-specific `.git` links. External source repositories must be re-established before work resumes. Backups created before the registry ledger change need a fresh backup for the current restore drill.
- CSP intentionally continues to allow inline **style attributes** for the existing UI. Executable scripts use trusted response nonces.
- The Markdown renderer documents and tests a small supported subset; it does not attempt full CommonMark. Oversized diffs use an explicit safe fallback instead of allocating an unbounded LCS matrix.

## Reproducible release gates

The integrated verification used the following release commands against the settled tree:

```sh
rtk proxy npm exec --package=pnpm@11.17.0 -- pnpm install --frozen-lockfile
rtk proxy npm exec --package=pnpm@11.17.0 -- pnpm verify
rtk proxy npm exec --package=pnpm@11.17.0 -- pnpm audit --json
```

Database-gated test files must each receive a fresh disposable PostgreSQL 16 database; the backup integration additionally needs a second marked disposable restore database and matching PG16 clients. Browser verification uses:

```sh
E2E_ARTIFACT_DIR=/tmp/nexus-e2e-final tests/e2e/verify-cleanup.sh
E2E_ARTIFACT_DIR=/tmp/nexus-e2e-final tests/e2e/run-e2e.sh
```

All local gates completed successfully. Live GitHub/model/deployment writes remain outside the declared verification boundary described above.
