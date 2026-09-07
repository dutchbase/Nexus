# Audit remediation implementation plan

**Goal:** Resolve the September 6 audit findings and validate the resulting product flows.
**Architecture:** Keep existing Node/TypeScript/PostgreSQL boundaries. Fix shared root causes, preserve immutable history, and use native controls and existing dependencies before adding machinery.
**Spec:** `docs/audit-2026-09-06.md`, including its qualified follow-ups and regression expectations.
**Execution:** Delegated implementation with separate file ownership, followed by independent review and integrated verification. Ponytail full applies throughout.

## Work packages

- [x] Ticket intake and operator UI: WEB-01–09, WEB-I1–I5, OPS-2. Owner: fix_web; `apps/web`, submission/form domain helpers. Uploads must remain accessible and atomically claimed, image previews must work, GET stays read-only, cancellation uses the canonical transition, and forms and edits share validation.
- [x] Worker and runners: WF-01–11, workflow follow-ups, INT-06. Owner: fix_worker; worker lifecycle, Claude/OpenCode and git runners. Cancellation, deadlines, retries and shutdown must preserve truthful state and terminate owned processes. Image evidence must reach supported agents.
- [x] Provider integration: INT-01–09 except INT-06, integration follow-ups. Owner: fix_integrations; provider jobs, GitHub provider and PR synchronization. All validation and mutations must agree on commit, destination and workflow identity; retries must be safe.
- [x] Persistence and operations: OPS-1/3–7 and operations follow-ups. Next delegated package; database migrations/artifacts, import/sync, backup/restore and deploy scripts. Test upgrades with arbitrary IDs, canonical artifact roots, real restore logging and same-SHA deployment retry.
- [x] Verification infrastructure: WEB-10–13, audit-discovered database/backup/E2E fixture gaps. Next delegated package; E2E harness/fixtures, CI and dependency manifests. Isolate owned processes/data before executing browser journeys; exercise all DB suites on disposable databases.
- [x] Independent review: inspect combined diffs for correctness, security, migration compatibility and unnecessary complexity; return defects to owners.
- [x] Integrated verification: type checking, unit tests, fresh/upgrade migrations, isolated DB suites, backup/restore, mocked lifecycle/browser journeys, dependency audit and final diff review.
- [x] Publish a completion ledger with one disposition per confirmed finding and qualified follow-up, exact verification and honest remaining external limits.

## Rules and coordination

Each owner traces callers, adds the smallest meaningful failing regression, applies the minimal fix, then runs the relevant tests. No source-text assertions in place of behavior tests. Shared interfaces are agreed before edits. Agents do not edit another owner's files or commit concurrently. External production writes and deployments are outside local remediation. Tests use owned temporary directories and disposable databases only.

Qualified follow-ups are investigated individually: implement proven hardening gaps, retain supported existing semantics where the report only questions policy, and document the rationale and check. Do not invent features solely to close a label.

## Baseline

Source commit: `8d3b1f5`. Isolated branch: `fix/audit-2026-09-06` in `/tmp/nexus-fixes-20260906`. Frozen pnpm 11.17.0 install succeeded. Original audit reports are preserved. Initial verification output: `/tmp/nexus-fix-baseline.log`.
