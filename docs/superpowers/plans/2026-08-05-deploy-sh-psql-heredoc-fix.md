# deploy.sh psql Variable-Interpolation Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix `deploy.sh`'s three audit-log helpers (`record_event`, `record_rollback`, `record_cutover_target`), which currently die on every invocation because `psql ... --command "... :'var' ..."` does not perform psql's `:'var'` variable interpolation — confirmed by direct reproduction against production Postgres 16.14. Under `set -euo pipefail`, this kills `deploy.sh` on its very first audit-log write, meaning it has never completed a deploy successfully in this environment.

**Architecture:** Same `--set=name=value` flags, same SQL text, same three functions — only the delivery mechanism changes: SQL moves from a `--command "..."` argument to a heredoc on stdin (confirmed directly: `psql "$DATABASE_URL" --set=foo=bar <<'SQL'`⏎`SELECT :'foo'`⏎`SQL` correctly interpolates, where `--command "SELECT :'foo'"` does not). No SQL logic changes. The one existing test (`scripts/task-8.test.ts`) mocks `psql` with a fake shell script that just logs its invocation — it needs a one-line addition so it keeps capturing the SQL text (now on stdin instead of argv) for the assertions that check specific SQL-body substrings.

**Tech Stack:** Bash, psql (PostgreSQL 16 client), vitest (`spawnSync`-based script testing).

## Global Constraints

- Do not change any SQL text, `--set` flag names, or values — only how the SQL reaches psql (heredoc instead of `--command`).
- Use a **quoted** heredoc delimiter (`<<'SQL'`, not `<<SQL`) so bash does not attempt its own `$`-expansion inside the SQL body — psql's `:'var'` tokens must reach psql untouched by bash.
- `scripts/task-8.test.ts`'s existing 14 tests must all still pass; specifically `"persists rollback target evidence before atomically switching current"` (currently asserting `result.commands` contains the literal strings `"prior_release_path"` and `"target_release_path"`, which live in the SQL body) and `"writes the atomic JSON completion marker before restarting the webhook"` (asserting `result.commands` contains `"psql"`).
- Run `pnpm exec tsc --noEmit` (this repo's `scripts/*.test.ts` files are type-checked) and the test file after the change.

---

### Task 1: Deliver SQL to psql via heredoc instead of `--command`

**Files:**
- Modify: `deploy.sh:38-52` (`record_event`, `record_rollback`, `record_cutover_target`)
- Test: `scripts/task-8.test.ts:46-48` (fake `psql` script), `scripts/task-8.test.ts:180-189` (existing test — verify only, no assertion changes needed once the fake script captures stdin)

**Interfaces:**
- Produces: identical external behavior for every OTHER caller/test in the file (the `--set` flags, exit codes, and control flow around these functions are unchanged) — only the internal SQL-delivery mechanism changes.

**No TDD red/green cycle applies to this task.** The existing test suite mocks `psql` with a fake script that never validates SQL syntax (that's precisely how this bug shipped unnoticed — see Global Constraints), so no existing test currently fails against the bug, and no new isolated test can fail-then-pass without spinning up a real Postgres inside the test harness, which this file's design deliberately avoids. The two things that actually prove this fix: (1) all 14 existing tests still pass after the change (regression proof), and (2) direct manual reproduction against a real psql client (already done during this plan's investigation — see Step 3). Both are verification steps, not a synthetic failing test.

- [ ] **Step 1: Confirm the current baseline**

Run: `cd /home/deploy/projects/dev-control && pnpm exec vitest run scripts/task-8.test.ts`
Expected: all 14 tests PASS (this is the pre-fix baseline — the fake `psql` mock accepts anything, so these tests exercise `deploy.sh`'s control flow correctly but do not catch the SQL-interpolation bug).

- [ ] **Step 2: Extend the fake `psql` script to capture stdin**

In `scripts/task-8.test.ts`, replace the `psql` entry in the `scripts` object (lines 46-48):

```ts
    psql: `#!/bin/sh
echo "psql $*" >> "$DCC_LOG"
`,
```

with:

```ts
    psql: `#!/bin/sh
echo "psql $*" >> "$DCC_LOG"
cat >> "$DCC_LOG"
`,
```

This is the change that will make the fix's effect visible in the test log: once `deploy.sh` moves its SQL from a `--command` argument to a heredoc on stdin, the SQL text needs `cat` to still capture it into `$DCC_LOG` for the existing substring assertions (`"prior_release_path"`, `"target_release_path"`) to keep passing. Run the suite again now, before touching `deploy.sh`: `pnpm exec vitest run scripts/task-8.test.ts` — still all 14 PASS (harmless addition; reading from an inherited `/dev/null`-equivalent stdin returns EOF immediately, so `cat` is a no-op for every current call site since none of them redirect stdin yet).

- [ ] **Step 3: Implement the fix**

In `deploy.sh`, replace lines 38-52 (`record_event`, `record_rollback`, `record_cutover_target`) with:

```bash
record_event() {
  local stage="$1"
  psql "$DATABASE_URL" --set=ON_ERROR_STOP=1 --set=attempt_id="$ATTEMPT_ID" --set=event_key="deploy:$stage" --set=event_type=stage --set=stage="$stage" <<'SQL'
INSERT INTO deployment_events (attempt_id,event_key,event_type,metadata) VALUES (:'attempt_id'::uuid, :'event_key', :'event_type', jsonb_build_object('stage', :'stage')) ON CONFLICT (attempt_id,event_key) DO NOTHING
SQL
}

record_rollback() {
  local outcome="$1"
  local recovery_health="$2"
  local reason="$3"
  psql "$DATABASE_URL" --set=ON_ERROR_STOP=1 --set=attempt_id="$ATTEMPT_ID" --set=event_key=deploy:rollback --set=prior_release="$PRIOR_RELEASE" --set=rollback_outcome="$outcome" --set=recovery_health="$recovery_health" --set=reason="$reason" <<'SQL'
INSERT INTO deployment_events (attempt_id,event_key,event_type,metadata) VALUES (:'attempt_id'::uuid, :'event_key', 'rollback', jsonb_strip_nulls(jsonb_build_object('stage','rollback','prior_release_path',NULLIF(:'prior_release',''),'rollback_outcome',:'rollback_outcome','recovery_health',:'recovery_health','reason',:'reason'))) ON CONFLICT (attempt_id,event_key) DO NOTHING
SQL
}

record_cutover_target() {
  psql "$DATABASE_URL" --set=ON_ERROR_STOP=1 --set=attempt_id="$ATTEMPT_ID" --set=event_key=deploy:cutover_prepared --set=event_type=cutover_prepared --set=prior_release="$PRIOR_RELEASE" --set=target_release="$RELEASE" <<'SQL'
WITH updated AS (UPDATE deployment_attempts SET prior_release_path=NULLIF(:'prior_release',''),updated_at=now() WHERE id=:'attempt_id'::uuid AND state='running' RETURNING id), recorded AS (INSERT INTO deployment_events (attempt_id,event_key,event_type,metadata) SELECT id,:'event_key',:'event_type',jsonb_strip_nulls(jsonb_build_object('prior_release_path',NULLIF(:'prior_release',''),'target_release_path',:'target_release')) FROM updated RETURNING 1) SELECT 1 / count(*)::integer FROM recorded
SQL
}
```

- [ ] **Step 4: Run the suite to verify it passes**

Run: `cd /home/deploy/projects/dev-control && pnpm exec vitest run scripts/task-8.test.ts`
Expected: all 14 pre-existing tests PASS unmodified — in particular `"persists rollback target evidence before atomically switching current"` (SQL body text now arrives via the fake psql's captured stdin instead of argv, but the substring assertions on `result.commands` still hold since stdin content is appended to the same log) and `"writes the atomic JSON completion marker before restarting the webhook"` (`toContain("psql")` still trivially true).

Then verify the actual production bug is fixed by reproducing the original repro command with the new invocation shape, against a real Postgres:

```bash
psql "$DCC_TEST_DATABASE_URL" --set=foo=bar <<'SQL'
SELECT :'foo'
SQL
```

Expected: returns `bar`, no syntax error (this was already manually confirmed against production during this plan's investigation; re-confirming here is your own verification, not a formality — if `DCC_TEST_DATABASE_URL`/`DATABASE_URL` isn't set in your environment, skip this manual check and rely on the vitest suite).

- [ ] **Step 5: Run `pnpm exec tsc --noEmit`**

Run: `cd /home/deploy/projects/dev-control && pnpm exec tsc --noEmit`
Expected: no errors (this is a `.sh`/`.ts` test change, no new TypeScript surface).

- [ ] **Step 6: Commit**

```bash
cd /home/deploy/projects/dev-control
git add deploy.sh scripts/task-8.test.ts
git commit -m "fix: deliver deploy.sh's psql audit-log SQL via stdin so :'var' interpolation actually works"
```

---

## Verification (end-to-end)

```bash
pnpm exec tsc --noEmit
pnpm exec vitest run scripts/task-8.test.ts
```
Both must pass with no failures. The real-world proof is operational: once merged, the next webhook-triggered deploy attempt should progress past the `git fetch`/`record_event("protected_head_verified")` stage for the first time — watch `.deploy-state/logs/<attempt-id>.log` for `pnpm install --frozen-lockfile` output (the next stage) instead of a `psql`/`syntax error` + `rollback recovery failed` pair.

## Out of scope (deliberate)

- No change to `deploy.sh`'s control flow, rollback semantics, or any non-psql command — this is purely a SQL-delivery-mechanism fix.
- No change to the `deployment_attempts`/`deployment_events` schema (migration 042) — the SQL text itself was always correct; only the client-side delivery was broken.
- Not fixing or investigating why this bug went unnoticed until now (the fake-`psql`-mock test suite never executes real SQL) — that's a testing-strategy question for a separate discussion, not a code defect to fix here.
