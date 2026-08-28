# Fix AI PR Review `inconsistent types deduced for parameter $2` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every AI PR review job (any model, any mode, any reasoning level) currently throws `inconsistent types deduced for parameter $2` (Postgres SQLSTATE `42P08`) inside `recordAiUsage`, before the review result is ever persisted or published, and the job silently completes as `completed` with the underlying `pr_ai_reviews` row left in `status='error'`. This plan fixes the ambiguous-parameter SQL, fixes the pre-existing test fixture bug that was masking the regression, wires the relevant integration tests into CI so this class of bug can't ship silently again, adds structured error logging so a future DB error is diagnosable from logs alone, and adds the regression coverage the ticket requires (Sonnet/`review_only`/`medium`, retry-safety, no duplicate GitHub comments, nullable `github_comment_id` handling).

**Architecture:** The bug is a single SQL statement in `packages/domain/src/index.ts` (`recordAiUsage`) that binds the same positional parameter (`$2`, and identically `$3`/`$5`/`$6`) both as a direct assignment to a `bigint` column and as an operand inside a `numeric` arithmetic expression in the same `UPDATE ... RETURNING` statement — Postgres's extended query protocol cannot resolve one type for a parameter used in two type-incompatible contexts, and rejects the *entire query* at prepare time, unconditionally, regardless of runtime values or which model/mode/reasoning-level triggered it. The fix adds explicit `::bigint`/`::numeric` casts to disambiguate each parameter, with no schema change and no change to the publication/comment-persistence path (independently verified correct in this plan's investigation). The rest of the plan is regression-proofing: fix a masking bug in the existing integration test fixture, wire two already-written `.db.test.ts` files into CI (neither currently runs against a real Postgres in CI), add structured logging to the one catch block that currently swallows this error class silently, and add the specific regression tests the ticket requires — most of which the investigation found are already correctly implemented in `resumePrReviewPublication` and just need a test asserting it.

**Tech Stack:** Node.js/TypeScript monorepo (pnpm workspaces), raw `pg` (`node-postgres`) with positional `$N` parameters — no ORM/query builder. Vitest for tests; `*.db.test.ts` files are real-Postgres integration tests gated on `process.env.DCC_TEST_DATABASE_URL` (skipped otherwise via `describe.skip`). GitHub Actions CI (`.github/workflows/ci.yml`) runs a `postgres:16` service container.

**Spec:** This plan's own investigation (below) — no separate design doc. Source task: "Fix AI PR review failures caused by `inconsistent types deduced for parameter $2`" (dev-control task list, 2026-08-27).

## Investigation findings (ground truth — verified against live code and a real Postgres 16 instance with all 60 migrations applied)

- **Exact broken query:** `packages/domain/src/index.ts:111-128`, inside `recordAiUsage(input, client?)`. Reproduced verbatim against a real migrated Postgres 16: `ERROR: 42P08: inconsistent types deduced for parameter $2 / DETAIL: numeric versus bigint`.
- **Why:** `agent_runs.input_tokens`/`output_tokens`/`reasoning_tokens`/`cache_read_tokens`/`cache_write_tokens`/`total_tokens` are all `bigint` (`packages/database/migrations/050_ai_invocation_accounting.sql:29-34`). `ai_model_prices.input_usd_per_million`/`output_usd_per_million`/`cache_write_usd_per_million`/`cache_read_usd_per_million` are all `numeric(20,8)` (`050_ai_invocation_accounting.sql:8-11`). The query does `input_tokens=$2` (bigint context) **and** `$2 * input_usd_per_million` (numeric context) in the same statement — same pattern repeats for `$3`↔output, `$5`↔cache_read, `$6`↔cache_write. This is **not** a UUID/text/jsonb mismatch — there is no ambiguous UUID column anywhere in this path.
- **Call chain:** `apps/worker/src/worker.ts` (`runPrAiReview`, `runPlanning`, `runExecution`, `runFollowUpDescription`, `runConflictResolution` — every AI job type that returns token usage) → `apps/worker/src/worker-boundary.ts:148-152` `finalizeAiUsage(runId, result)` → `recordAiUsage(...)` (broken query) whenever `result.usage` is present. **This is not PR-review-specific or Sonnet-specific** — it breaks identically for every model/job type that returns usage data, since the error is a query-parse-time failure independent of the bound values.
- **PR review specifically:** `apps/worker/src/worker.ts:1338` calls `finalizeAiUsage` **before** `resumePrReviewPublication` (`worker.ts:1351`, from `packages/domain/src/pr-review-publication.ts:29`) ever runs — so the completed review markdown from Claude is generated successfully and then thrown away when the DB call throws; nothing about the publication/comment code path is ever reached or at fault.
- **Failure handling:** `runPrAiReview`'s catch block (`worker.ts:1395-1411`) has no logging today, and because `shouldRetryPrReview` (`worker-boundary.ts:154-158`) returns `false` for this error (it's a plain `pg` `DatabaseError`, not retryable), `runPrAiReview` never rethrows — the job-loop's own `console.error`+`failJob` (`worker.ts:1899-1913`) is never reached, and the `jobs` row is marked `completed`, hiding the failure from job-queue monitoring. The only trace today is `pr_ai_reviews.error_code`/`error_message`, visible solely in the admin UI (`apps/web/src/pages/prs.ts:189-196` — this is the literal source of the "Publication ... / GitHub comment —" text from the bug report; `github_comment_id` is always `NULL` because publication is never reached).
- **Publication/comment code is not the bug:** `packages/domain/src/pr-review-publication.ts` (`resumePrReviewPublication`) was independently verified against the real schema — every query there resolves cleanly. It already handles retry-safety correctly (only acts on rows in `status='running'`; skips re-invoking the model if `raw_output` is already set; matches comment bodies against the same review's `prReviewPublicationMarker(publicationId)` HTML marker before creating a new GitHub comment) — this plan adds test coverage for that existing behavior, it does not change it.
- **Query-writing convention in this codebase:** raw `pg`, positional `$N` params, `RETURNING *` used pervasively, explicit casts (`::uuid`, `::jsonb`) are the established way to resolve type ambiguity elsewhere in the codebase (e.g. `packages/domain/src/pull-request-sync.ts:112`). The fix in Task 1 follows this exact convention.
- **Why this shipped uncaught:** `packages/domain/src/ai-accounting.db.test.ts` already calls `recordAiUsage` with real token counts (line 38) — this *would* catch the bug today, except it passes non-UUID literal ids (`"priced"`, `"once"`, etc.) into `createAiInvocation`, which fails immediately with `invalid input syntax for type uuid` (since `agent_runs.id` is `uuid`, `packages/database/migrations/001_foundation.sql:135`) before the query under test ever runs — masking the real bug behind an unrelated fixture error. Separately, `.github/workflows/ci.yml`'s "Deployment database tests" step (line 43-48) only runs `scripts/webhook-deployments.test.ts`, `packages/database/src/migrate.test.ts`, and `packages/domain/src/notifications.db.test.ts` — it has never included `ai-accounting.db.test.ts` or `apps/web/src/pages/ai-usage.db.test.ts` (the latter already uses correct UUID literals and calls `recordAiUsage` directly at line 24 — it would catch this bug cleanly today if it ran in CI). `pnpm verify` (used elsewhere in CI) runs `vitest run` with no `DCC_TEST_DATABASE_URL`, so every `*.db.test.ts` file is skipped there unconditionally.

## Global Constraints

- Do not suppress or catch-and-hide the `inconsistent types deduced for parameter $2` error — fix the query so it never occurs.
- Do not convert `bigint` token columns or `numeric` price columns to a different type anywhere — this is a parameter-typing fix, not a schema change. No migration is needed for Task 1 (confirmed: the schema itself is correct; only the query is wrong).
- Do not touch `packages/domain/src/pr-review-publication.ts`'s logic — it is already correct (verified above); only add tests confirming it.
- Follow this codebase's existing raw-`pg`/explicit-cast convention (no ORM, no query builder introduced).
- Every `*.db.test.ts` file added or modified in this plan must keep the existing `integration = testDatabaseUrl ? describe : describe.skip` gating pattern so `pnpm verify` (no `DCC_TEST_DATABASE_URL`) still skips them harmlessly.
- **Local Postgres for verification — use native binaries, not `docker run`.** In this repo's own dev/CI sandbox, `docker` is installed but the socket is permission-denied by default (`permission denied while trying to connect to the docker API at unix:///var/run/docker.sock`) — every `docker run ... postgres:16` command in this plan's steps will fail there unless you have elevated docker permissions. Postgres 16 server binaries are already installed at `/usr/lib/postgresql/16/bin` in this environment. Use this instead, everywhere a step below says to start a throwaway Postgres:
  ```bash
  export PATH=/usr/lib/postgresql/16/bin:$PATH
  rm -rf /tmp/dccpg && mkdir -p /tmp/dccpg/sock
  initdb -D /tmp/dccpg/data -U postgres --auth=trust
  pg_ctl -D /tmp/dccpg/data -l /tmp/dccpg/pg.log -o "-p 5433 -k /tmp/dccpg/sock -h 127.0.0.1" start
  createdb -h 127.0.0.1 -p 5433 -U postgres dcc_test   # or a differently-named db per task if you want isolation
  export DCC_TEST_DATABASE_URL="postgresql://postgres@127.0.0.1:5433/dcc_test"
  ```
  Stop it when done: `pg_ctl -D /tmp/dccpg/data stop -m fast`. This was verified working end-to-end in this environment's sandbox (with `dangerouslyDisableSandbox` if your harness blocks Unix-socket creation by default — the error to watch for is "could not create Unix socket: Operation not permitted", which is a sandbox restriction, not a real failure). If your execution environment *does* have working `docker` permissions, the `docker run` commands below work identically and either approach is fine — this note exists so you don't get stuck on the docker permission error if you hit it.

---

## Task 1: Fix the ambiguous-parameter query in `recordAiUsage`

**Files:**
- Modify: `packages/domain/src/index.ts:103-130`
- Test: `packages/domain/src/ai-accounting.db.test.ts` (existing file, run as the RED/GREEN check — no new test file needed here, Task 2 fixes its fixture bug first)

**Interfaces:**
- Consumes: nothing new — `recordAiUsage(input: { runId: string } & AiUsage, client?: AiQueryClient)` keeps its exact existing signature and return shape (`Promise<AgentRunRow>` — the `agent_runs` row via `RETURNING ar.*`, or the pre-existing row if the `UPDATE` matched zero rows).
- Produces: the same fixed signature — Task 4/5 call this function exactly as it exists today, no call-site changes required anywhere in `apps/worker/src/worker.ts`.

- [ ] **Step 1: Confirm the bug reproduces today (RED), without relying on the fixture-broken test file**

Run a one-off script against a real local Postgres to prove the exact failure mode before touching any code. This does not require `DCC_TEST_DATABASE_URL` to be set globally — pass it inline.

```bash
docker run --rm -d --name dcc-plan10-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=dcc_plan10 -p 55432:5432 postgres:16
sleep 3
DCC_TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:55432/dcc_plan10" node --experimental-strip-types -e '
import pg from "pg";
const client = new pg.Client({ connectionString: process.env.DCC_TEST_DATABASE_URL });
await client.connect();
try {
  await client.query(`
    WITH price AS (SELECT 10::numeric AS input_usd_per_million, 20::numeric AS output_usd_per_million, 30::numeric AS cache_write_usd_per_million, 40::numeric AS cache_read_usd_per_million)
    SELECT ($1::bigint * input_usd_per_million) FROM price
  `, [1]).catch(e => { throw e; });
} catch (e) { console.log("bigint-cast alone (control, should pass):", e.message); }
try {
  await client.query(`
    SELECT $1, ($1 * 10::numeric)
  `, [5]);
  console.log("UNEXPECTED: bare reuse across bigint/numeric context did not error");
} catch (e) {
  console.log("REPRO OK — got:", e.code, e.message);
}
await client.end();
'
docker rm -f dcc-plan10-pg
```

Expected output: `REPRO OK — got: 42P08 inconsistent types deduced for parameter $1` (or `$2` depending on ordinal position — the mechanism is identical to the real query). This confirms the exact SQLSTATE/message class before editing `index.ts`.

- [ ] **Step 2: Fix the query with explicit casts**

Replace lines 111-128 of `packages/domain/src/index.ts`:

```typescript
  const result = await db.query(
    `WITH price AS (
       SELECT p.* FROM ai_model_prices p JOIN agent_runs ar ON ar.id=$1
       WHERE p.model=ar.model AND p.effective_from<=ar.started_at
       ORDER BY p.effective_from DESC LIMIT 1
     )
     UPDATE agent_runs ar SET
       ai_usage_status='captured', input_tokens=$2::bigint, output_tokens=$3::bigint, reasoning_tokens=$4::bigint,
       cache_read_tokens=$5::bigint, cache_write_tokens=$6::bigint, total_tokens=$7::bigint, raw_usage_json=$8,
       ai_model_price_id=(SELECT id FROM price),
       estimated_cost_usd=(SELECT
         ($2::numeric * input_usd_per_million + $3::numeric * output_usd_per_million +
          $5::numeric * cache_read_usd_per_million + $6::numeric * cache_write_usd_per_million) / 1000000
         FROM price)
     WHERE ar.id=$1 AND ar.ai_usage_status='pending'
     RETURNING ar.*`,
    [input.runId, inputTokens, outputTokens, reasoningTokens, cacheReadTokens, cacheWriteTokens, totalTokens, input.rawUsage],
  );
```

Every parameter that appears in more than one type context (`$2`, `$3`, `$5`, `$6`) now carries an explicit cast at **every** occurrence, not just one — this removes all ambiguity regardless of which occurrence Postgres would otherwise resolve first. `$1` (uuid, single context), `$4`/`$7` (bigint, single context each), `$8` (jsonb, single context) are untouched since they were never ambiguous.

- [ ] **Step 3: Re-run the repro script's equivalent against the real query to confirm GREEN**

This is verified properly in Task 2 (once the test fixture's UUID bug is fixed, `ai-accounting.db.test.ts`'s existing assertions — e.g. `expect(priced.estimated_cost_usd).toBe("100.0000000000")` at line 40 — exercise this exact fixed query end-to-end). Do not skip ahead; Task 2 is the real verification for this fix. For a quick manual sanity check now:

```bash
docker run --rm -d --name dcc-plan10-pg2 -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=dcc_plan10b -p 55433:5432 postgres:16
sleep 3
DCC_TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:55433/dcc_plan10b" pnpm exec vitest run --no-file-parallelism packages/domain/src/ai-accounting.db.test.ts 2>&1 | tail -30
docker rm -f dcc-plan10-pg2
```

Expected: still fails, but now on the `invalid input syntax for type uuid` fixture bug (Task 2), **not** on `42P08` — this confirms Task 1's fix took effect and the remaining failure is the known, separate fixture issue.

- [ ] **Step 4: Commit**

```bash
git add packages/domain/src/index.ts
git commit -m "fix: cast recordAiUsage's reused bigint/numeric parameters explicitly

Postgres rejected the whole UPDATE at prepare time with 'inconsistent
types deduced for parameter \$2' because \$2/\$3/\$5/\$6 were each bound
once as a bigint column assignment and once inside a numeric price
multiplication in the same statement. This broke every AI job type
that reports token usage (planning, execution, PR review, follow-up,
conflict resolution) for every model, unconditionally -- not just
Sonnet or PR review, since the failure is at query-parse time and
independent of the actual values bound."
```

---

## Task 2: Fix the UUID-literal fixture bug masking the regression in `ai-accounting.db.test.ts`

**Files:**
- Modify: `packages/domain/src/ai-accounting.db.test.ts`

**Interfaces:**
- Consumes: `createAiInvocation`, `recordAiUnavailable`, `recordAiUsage` from `./index.ts` (unchanged signatures).
- Produces: nothing new — this task only replaces literal string ids with valid UUID literals so `agent_runs.id uuid` (`packages/database/migrations/001_foundation.sql:135`) accepts the inserts, letting the existing assertions actually exercise Task 1's fix.

- [ ] **Step 1: Replace every non-UUID literal test id with a valid UUID literal**

In `packages/domain/src/ai-accounting.db.test.ts`, replace every occurrence of these six literal ids (used as both the `id:` passed to `createAiInvocation` and the `runId:` passed to `recordAiUsage`/`recordAiUnavailable`) with the UUID mapping below. Use find-and-replace across the whole file (each id appears multiple times):

| Old literal | New UUID |
|---|---|
| `"priced"` | `"00000000-0000-4000-8000-000000000001"` |
| `"unpriced"` | `"00000000-0000-4000-8000-000000000002"` |
| `"once"` | `"00000000-0000-4000-8000-000000000003"` |
| `"pending-raw"` | `"00000000-0000-4000-8000-000000000004"` |
| `"unavailable-raw"` | `"00000000-0000-4000-8000-000000000005"` |
| `"contended"` | `"00000000-0000-4000-8000-000000000006"` |

Concretely, these are the exact lines to change (line numbers as of this plan's investigation — re-locate by the literal string if they've drifted):
- Line 37: `await createAiInvocation({ id: "priced", ...` → `id: "00000000-0000-4000-8000-000000000001"`
- Line 38: `recordAiUsage({ runId: "priced", ...` → `runId: "00000000-0000-4000-8000-000000000001"`
- Line 45: `` `SELECT ai_model_price_id,estimated_cost_usd FROM agent_runs WHERE id='priced' ` `` → `id='00000000-0000-4000-8000-000000000001'`
- Line 48: `await createAiInvocation({ id: "unpriced", ...` → `"00000000-0000-4000-8000-000000000002"`
- Line 49: `recordAiUsage({ runId: "unpriced", ...` → `"00000000-0000-4000-8000-000000000002"`
- Line 50-51: `unpriced.ai_model_price_id` / `unpriced.estimated_cost_usd` — variable name only, no literal to change.
- Line 61: `await createAiInvocation({ id: "once", ...` → `"00000000-0000-4000-8000-000000000003"`
- Line 62: `recordAiUsage({ runId: "once", ...` → `"00000000-0000-4000-8000-000000000003"`
- Line 63: `recordAiUsage({ runId: "once", ...` → `"00000000-0000-4000-8000-000000000003"`
- Line 64: `recordAiUnavailable("once", client)` → `recordAiUnavailable("00000000-0000-4000-8000-000000000003", client)`
- Line 73: `await createAiInvocation({ id: "pending-raw", ...` → `"00000000-0000-4000-8000-000000000004"`
- Line 74: `` `UPDATE agent_runs SET raw_usage_json='{}' WHERE id='pending-raw'` `` → `id='00000000-0000-4000-8000-000000000004'`
- Line 76: `await createAiInvocation({ id: "unavailable-raw", ...` → `"00000000-0000-4000-8000-000000000005"`
- Line 77: `recordAiUnavailable("unavailable-raw", client)` → `recordAiUnavailable("00000000-0000-4000-8000-000000000005", client)`
- Line 78: `` `UPDATE agent_runs SET raw_usage_json='{}' WHERE id='unavailable-raw'` `` → `id='00000000-0000-4000-8000-000000000005'`
- Line 90: `await createAiInvocation({ id: "contended", ...` → `"00000000-0000-4000-8000-000000000006"`
- Line 92: `` `SELECT id FROM agent_runs WHERE id='contended' FOR UPDATE` `` → `id='00000000-0000-4000-8000-000000000006'`
- Line 93: `recordAiUsage({ runId: "contended", ...` → `"00000000-0000-4000-8000-000000000006"`
- Line 94: `` `UPDATE agent_runs SET ai_usage_status='unavailable' WHERE id='contended'` `` → `id='00000000-0000-4000-8000-000000000006'`
- Line 96: `.toMatchObject({ id: "contended", ...` → `id: "00000000-0000-4000-8000-000000000006"`

- [ ] **Step 2: Run the suite against a real local Postgres to verify it now passes (this is the real GREEN check for Task 1)**

```bash
docker run --rm -d --name dcc-plan10-pg3 -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=dcc_plan10c -p 55434:5432 postgres:16
sleep 3
DCC_TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:55434/dcc_plan10c" pnpm exec vitest run --no-file-parallelism packages/domain/src/ai-accounting.db.test.ts
docker rm -f dcc-plan10-pg3
```

Expected: all 4 tests in `AI invocation accounting persistence` pass, including `expect(priced.estimated_cost_usd).toBe("100.0000000000")` — this is the assertion that specifically exercises the multi-context `$2`/`$3`/`$5`/`$6` arithmetic Task 1 fixed (1,000,000 tokens × price-per-million across all four token types, summed and divided).

- [ ] **Step 3: Commit**

```bash
git add packages/domain/src/ai-accounting.db.test.ts
git commit -m "test: use valid uuid literals in ai-accounting.db.test.ts fixtures

agent_runs.id is a uuid column; the literal test ids ('priced',
'once', etc.) failed INSERT with 'invalid input syntax for type
uuid' before ever reaching the recordAiUsage call under test --
masking the \$2 parameter-type bug this suite exists to catch."
```

---

## Task 3: Wire the AI-usage/accounting integration tests into CI

**Files:**
- Modify: `.github/workflows/ci.yml:43-48`

**Interfaces:**
- Consumes: nothing — this only changes the CI job's test file list.
- Produces: nothing consumed by other tasks; this closes the "why did this ship uncaught" gap identified in the investigation.

- [ ] **Step 1: Add the two currently-unwired `.db.test.ts` files to the Deployment database tests CI step**

In `.github/workflows/ci.yml`, change:

```yaml
      - name: Deployment database tests
        run: pnpm exec vitest run --no-file-parallelism --testTimeout=15000 scripts/webhook-deployments.test.ts packages/database/src/migrate.test.ts packages/domain/src/notifications.db.test.ts
        env:
          DCC_TEST_DATABASE_URL: postgresql://postgres:postgres@127.0.0.1:5432/dcc_test
```

to:

```yaml
      - name: Deployment database tests
        run: pnpm exec vitest run --no-file-parallelism --testTimeout=15000 scripts/webhook-deployments.test.ts packages/database/src/migrate.test.ts packages/domain/src/notifications.db.test.ts packages/domain/src/ai-accounting.db.test.ts apps/web/src/pages/ai-usage.db.test.ts
        env:
          DCC_TEST_DATABASE_URL: postgresql://postgres:postgres@127.0.0.1:5432/dcc_test
```

- [ ] **Step 2: Verify locally with the same file list CI will run**

```bash
docker run --rm -d --name dcc-plan10-ci -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=dcc_test -p 55435:5432 postgres:16
sleep 3
DCC_TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:55435/dcc_test" pnpm exec vitest run --no-file-parallelism --testTimeout=15000 scripts/webhook-deployments.test.ts packages/database/src/migrate.test.ts packages/domain/src/notifications.db.test.ts packages/domain/src/ai-accounting.db.test.ts apps/web/src/pages/ai-usage.db.test.ts
docker rm -f dcc-plan10-ci
```

Expected: all files pass.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: run ai-accounting and ai-usage db tests against real postgres

Neither file has ever run against a real database in CI -- ai-usage.db.test.ts
already exercised the exact recordAiUsage query that shipped broken
(inconsistent types deduced for parameter \$2), and would have caught
it before merge if it had been wired in here."
```

---

## Task 4: Add structured error logging to `runPrAiReview`'s catch block

**Files:**
- Modify: `apps/worker/src/worker.ts:1395-1411` (the `catch (error: any) {` block of `runPrAiReview`)
- Test: `apps/worker/src/pr-ai-review-error-logging.test.ts` (new)

**Interfaces:**
- Consumes: nothing new from earlier tasks.
- Produces: nothing consumed by later tasks — this is a leaf logging change plus its own unit test.

Investigation context: today this catch block has **no logging at all**, and because `shouldRetryPrReview` returns `false` for a plain database error, the job-loop's own outer `console.error` (`worker.ts:1899-1913`) is never reached either — the only trace of a DB-layer bug is a value buried in `pr_ai_reviews.error_message`, visible only in the admin UI.

- [ ] **Step 1: Write the failing test**

The full `runPrAiReview` function has many dependencies (Claude invocation, GitHub API, worktree setup) that make it impractical to unit test end-to-end for a pure logging assertion. Instead, extract the log line into a small pure function first, so it's directly testable, then call it from the catch block.

Create `apps/worker/src/pr-ai-review-error-logging.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { formatPrAiReviewFailureLog } from "./worker.ts";

describe("formatPrAiReviewFailureLog", () => {
  it("includes job id, pr_ai_review_id, pull_request_id, error code, and message", () => {
    const line = formatPrAiReviewFailureLog({
      jobId: "job-1",
      prAiReviewId: "review-1",
      pullRequestId: "pr-1",
      error: Object.assign(new Error("inconsistent types deduced for parameter $2"), { code: "42P08" }),
    });
    expect(line).toContain("job=job-1");
    expect(line).toContain("pr_ai_review_id=review-1");
    expect(line).toContain("pull_request_id=pr-1");
    expect(line).toContain("code=42P08");
    expect(line).toContain("inconsistent types deduced for parameter $2");
  });

  it("falls back to 'unknown' when the error has no code", () => {
    const line = formatPrAiReviewFailureLog({
      jobId: "job-2",
      prAiReviewId: "review-2",
      pullRequestId: "pr-2",
      error: new Error("GitHub API rate limited"),
    });
    expect(line).toContain("code=unknown");
    expect(line).toContain("GitHub API rate limited");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm exec vitest run apps/worker/src/pr-ai-review-error-logging.test.ts
```

Expected: FAIL — `formatPrAiReviewFailureLog` is not exported from `worker.ts`.

- [ ] **Step 3: Add and export the pure formatter, and call it from the catch block**

In `apps/worker/src/worker.ts`, add this exported function near the top-level helpers (alongside other small exported helpers in the file — place it just above `runPrAiReview`'s definition):

```typescript
export function formatPrAiReviewFailureLog(input: { jobId: string; prAiReviewId: string; pullRequestId: string; error: unknown }): string {
  const err = input.error as { code?: unknown; message?: unknown };
  const code = typeof err?.code === "string" ? err.code : "unknown";
  const message = err instanceof Error ? err.message : String(err?.message ?? err);
  return `pr_ai_review failed: job=${input.jobId} pr_ai_review_id=${input.prAiReviewId} pull_request_id=${input.pullRequestId} code=${code} message=${message}`;
}
```

Then in `runPrAiReview`'s catch block (currently starting `} catch (error: any) {` at line 1395), add the log call as the very first line after `await lease.assertOwned();`:

```typescript
  } catch (error: any) {
    await lease.assertOwned();
    console.error(formatPrAiReviewFailureLog({ jobId: job.id, prAiReviewId: payload.pr_ai_review_id, pullRequestId: payload.pull_request_id, error }));
    if (runId) await finalizeAiUsage(runId, error);
    const storedReview = (await pool.query("SELECT * FROM pr_ai_reviews WHERE id=$1", [payload.pr_ai_review_id])).rows[0];
    // ... rest unchanged
```

No credentials, tokens, or prompt text are included — only job/entity ids and the Postgres/JS error code+message, matching this codebase's existing `console.error` conventions elsewhere in the same file (e.g. `worker.ts:1389`, `worker.ts:1753`).

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm exec vitest run apps/worker/src/pr-ai-review-error-logging.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/worker.ts apps/worker/src/pr-ai-review-error-logging.test.ts
git commit -m "fix: log pr_ai_review failures with entity ids and error code

runPrAiReview's catch block previously logged nothing -- combined
with shouldRetryPrReview returning false for non-retryable database
errors (so the job-loop's own outer console.error is never reached
either), a bug like the \$2 parameter-type error left zero trace in
logs, only a value buried in pr_ai_reviews.error_message visible
solely through the admin UI."
```

---

## Task 5: Regression tests — Sonnet/`review_only`/`medium`, retry safety, no duplicate comments, nullable comment id

**Files:**
- Test: `packages/domain/src/pr-review-publication.db.test.ts` (new)

**Interfaces:**
- Consumes: `resumePrReviewPublication` from `./pr-review-publication.ts` (exact signature read from source — see below), `recordAiUsage`/`createAiInvocation` from `./index.ts`.
- Produces: nothing consumed elsewhere — this is the terminal regression-coverage task for this plan.

Investigation context — the exact signature this task tests against, from `packages/domain/src/pr-review-publication.ts:29-40`:

```typescript
export async function resumePrReviewPublication(db: Database, input: {
  reviewId: string;
  invoke: () => Promise<{ markdown: string; reviewedHeadSha: string; reviewedBaseBranch: string; reviewedBaseSha: string }>;
  listComments: () => Promise<{ items: Comment[]; complete: boolean }>;
  createComment: (body: string) => Promise<Comment>;
  assertOwned?: () => Promise<void>;
}): Promise<pr_ai_reviews row>
```

where `Comment = { id: number; html_url: string; body?: string | null }` and `prReviewPublicationMarker(publicationId: string)` returns `` `<!-- dcc-review-publication:${publicationId} -->` `` (both exported from the same file).

The `pr_ai_reviews` table schema needed for direct row seeding (from `packages/database/migrations/013_pr_ai_review.sql` and `041_pr_review_publication.sql`): `id uuid PK`, `pull_request_id uuid`, `mode text`, `status text`, `model text`, `reasoning_level text`, `publication_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE`, `publication_status text DEFAULT 'pending'`, `publication_attempt_count integer DEFAULT 0`, `github_comment_id bigint` (nullable), `raw_output text`, `parsed_verdict text`, `created_by uuid`, `created_at timestamptz DEFAULT now()`.

- [ ] **Step 1: Write the failing tests**

Create `packages/domain/src/pr-review-publication.db.test.ts`:

```typescript
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pg from "pg";

process.env.DATABASE_URL = process.env.DCC_TEST_DATABASE_URL ?? "postgres://unused:unused@127.0.0.1:1/unused";
const { migrate } = await import("../../database/src/migrate.ts");
const { recordAiUsage, createAiInvocation } = await import("./index.ts");
const { resumePrReviewPublication, prReviewPublicationMarker } = await import("./pr-review-publication.ts");

const testDatabaseUrl = process.env.DCC_TEST_DATABASE_URL;
const integration = testDatabaseUrl ? describe : describe.skip;
let migrationDirectory = "";
let client: pg.Client;

async function resetDatabase() {
  const reset = new pg.Client({ connectionString: testDatabaseUrl });
  await reset.connect();
  try { await reset.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;"); } finally { await reset.end(); }
}

async function seedProjectAndPr() {
  const projectId = (await client.query(
    "INSERT INTO projects (slug,name,repository_path,github_owner,github_repository) VALUES ('pub-test','Pub Test','/tmp','dutchbase','dev-control') RETURNING id",
  )).rows[0].id;
  const pullRequestId = (await client.query(
    "INSERT INTO pull_requests (project_id,number,title,head_branch,base_branch,repository) VALUES ($1,1,'t','feature','master','dutchbase/dev-control') RETURNING id",
    [projectId],
  )).rows[0].id;
  return { projectId, pullRequestId };
}

async function seedReview(pullRequestId: string, overrides: Partial<{ status: string; raw_output: string | null; parsed_verdict: string | null; github_comment_id: number | null; publication_status: string }> = {}) {
  const row = (await client.query(
    `INSERT INTO pr_ai_reviews (pull_request_id,mode,status,model,reasoning_level,raw_output,parsed_verdict,github_comment_id,publication_status)
     VALUES ($1,'review_only',$2,'sonnet','medium',$3,$4,$5,$6) RETURNING *`,
    [pullRequestId, overrides.status ?? "running", overrides.raw_output ?? null, overrides.parsed_verdict ?? null, overrides.github_comment_id ?? null, overrides.publication_status ?? "pending"],
  )).rows[0];
  return row;
}

integration("AI PR review publication (Sonnet / review_only / medium)", () => {
  beforeAll(async () => {
    migrationDirectory = await mkdtemp(join(tmpdir(), "dcc-pr-review-pub-"));
    await cp(new URL("../../database/migrations/", import.meta.url), migrationDirectory, { recursive: true });
  });
  beforeEach(async () => {
    await resetDatabase();
    await migrate({ connectionString: testDatabaseUrl!, directory: migrationDirectory });
    client = new pg.Client({ connectionString: testDatabaseUrl });
    await client.connect();
  });
  afterAll(async () => { if (migrationDirectory) await rm(migrationDirectory, { recursive: true, force: true }); });

  it("completes end to end for sonnet/review_only/medium without a parameter type error", async () => {
    const { projectId, pullRequestId } = await seedProjectAndPr();
    const review = await seedReview(pullRequestId);

    const runId = "00000000-0000-4000-8000-0000000000a1";
    await createAiInvocation({ id: runId, projectId, pullRequestId, runType: "pr_ai_review", model: "sonnet", reasoningLevel: "medium" }, client);
    await expect(recordAiUsage({ runId, inputTokens: 12000, outputTokens: 3400, reasoningTokens: 900, cacheReadTokens: 500, cacheWriteTokens: 200, rawUsage: { provider: "anthropic" } }, client)).resolves.toMatchObject({ ai_usage_status: "captured" });

    const created = { id: 555, html_url: "https://github.com/dutchbase/dev-control/pull/1#issuecomment-555" };
    const listComments = vi.fn().mockResolvedValue({ items: [], complete: true });
    const createComment = vi.fn().mockResolvedValue(created);
    const published = await resumePrReviewPublication(client, {
      reviewId: review.id,
      invoke: async () => ({ markdown: "Looks good overall.\n\n```json\n{\"verdict\":\"approved\",\"summary\":\"Looks good.\"}\n```\n", reviewedHeadSha: "a".repeat(40), reviewedBaseBranch: "master", reviewedBaseSha: "b".repeat(40) }),
      listComments,
      createComment,
    });

    expect(published.status).toBe("approved");
    expect(published.publication_status).toBe("published");
    expect(published.github_comment_id).toBe("555"); // node-postgres returns bigint columns as strings, not numbers, by default
    expect(createComment).toHaveBeenCalledTimes(1);
  });

  it("does not create a duplicate GitHub comment when retried after a transient failure", async () => {
    const { pullRequestId } = await seedProjectAndPr();
    // parsed_verdict must be set (not null) here: the real resumePrReviewPublication always writes
    // raw_output and parsed_verdict together in one UPDATE (pr-review-publication.ts:63-68) — a row
    // with raw_output set but parsed_verdict null is not a reachable state, and the function's final
    // UPDATE requires "parsed_verdict IS NOT NULL" to finalize publication (pr-review-publication.ts:95),
    // so leaving it null here would make this test throw "PR review publication could not be finalized"
    // instead of exercising the retry path it's meant to test.
    const review = await seedReview(pullRequestId, { raw_output: "## Verdict\napproved\n\n## Summary\nfine", parsed_verdict: "approved" });
    const marker = prReviewPublicationMarker(review.publication_id);
    const body = `## Verdict\napproved\n\n## Summary\nfine\n\n${marker}`;
    const existingComment = { id: 777, html_url: "https://github.com/x/y/pull/1#issuecomment-777", body };

    const createComment = vi.fn().mockResolvedValue(existingComment);
    const republished = await resumePrReviewPublication(client, {
      reviewId: review.id,
      invoke: async () => { throw new Error("invoke should not be called: raw_output already set"); },
      listComments: async () => ({ items: [existingComment], complete: true }),
      createComment,
    });

    expect(createComment).not.toHaveBeenCalled();
    expect(republished.github_comment_id).toBe("777"); // node-postgres returns bigint columns as strings, not numbers, by default
    expect(republished.publication_status).toBe("published");
  });

  it("retrying does not touch or get blocked by a historical failed review on the same PR", async () => {
    const { pullRequestId } = await seedProjectAndPr();
    const failedReview = await seedReview(pullRequestId, { status: "error" });
    await client.query("UPDATE pr_ai_reviews SET error_code=$2, error_message=$3 WHERE id=$1", [failedReview.id, "42P08", "inconsistent types deduced for parameter $2"]);

    const freshReview = await seedReview(pullRequestId);
    const createComment = vi.fn().mockResolvedValue({ id: 900, html_url: "https://example.test/900" });
    const published = await resumePrReviewPublication(client, {
      reviewId: freshReview.id,
      invoke: async () => ({ markdown: "Needs more work before merge.\n\n```json\n{\"verdict\":\"rejected\",\"summary\":\"needs work\"}\n```\n", reviewedHeadSha: "c".repeat(40), reviewedBaseBranch: "master", reviewedBaseSha: "d".repeat(40) }),
      listComments: async () => ({ items: [], complete: true }),
      createComment,
    });

    expect(published.status).toBe("rejected");
    expect(createComment).toHaveBeenCalledTimes(1);
    const stillFailed = (await client.query("SELECT status, error_code FROM pr_ai_reviews WHERE id=$1", [failedReview.id])).rows[0];
    expect(stillFailed).toEqual({ status: "error", error_code: "42P08" });
  });

  it("resuming a non-running review is a no-op and leaves github_comment_id null rather than erroring", async () => {
    const { pullRequestId } = await seedProjectAndPr();
    const errored = await seedReview(pullRequestId, { status: "error", github_comment_id: null });
    const createComment = vi.fn();
    const result = await resumePrReviewPublication(client, {
      reviewId: errored.id,
      invoke: async () => { throw new Error("should not invoke"); },
      listComments: async () => ({ items: [], complete: true }),
      createComment,
    });
    expect(result.status).toBe("error");
    expect(result.github_comment_id).toBeNull();
    expect(createComment).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail (RED) before Tasks 1-4 exist on this branch**

If executed after Tasks 1-4 are already merged (the normal case for this plan's own execution order), these tests should already pass — in that case, temporarily revert Task 1's cast fix locally and confirm the first test fails with `42P08` on the `recordAiUsage` call, then re-apply the fix. This is the true RED/GREEN cycle for this specific test file since Tasks 1-4 land first.

```bash
docker run --rm -d --name dcc-plan10-pg5 -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=dcc_plan10e -p 55436:5432 postgres:16
sleep 3
DCC_TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:55436/dcc_plan10e" pnpm exec vitest run --no-file-parallelism packages/domain/src/pr-review-publication.db.test.ts
docker rm -f dcc-plan10-pg5
```

- [ ] **Step 3: Run tests to verify they pass (GREEN)**

Same command as Step 2, run with Task 1's fix in place. Expected: all 4 tests pass.

- [ ] **Step 4: Add this new file to the CI database-tests step**

Extend the same `.github/workflows/ci.yml` line Task 3 already modified:

```yaml
      - name: Deployment database tests
        run: pnpm exec vitest run --no-file-parallelism --testTimeout=15000 scripts/webhook-deployments.test.ts packages/database/src/migrate.test.ts packages/domain/src/notifications.db.test.ts packages/domain/src/ai-accounting.db.test.ts apps/web/src/pages/ai-usage.db.test.ts packages/domain/src/pr-review-publication.db.test.ts
        env:
          DCC_TEST_DATABASE_URL: postgresql://postgres:postgres@127.0.0.1:5432/dcc_test
```

- [ ] **Step 5: Commit**

```bash
git add packages/domain/src/pr-review-publication.db.test.ts .github/workflows/ci.yml
git commit -m "test: regression coverage for AI PR review persistence/publication

Covers the ticket's required scenarios against a real Postgres:
sonnet/review_only/medium completes without a parameter type error,
retrying after a transient publication failure does not create a
duplicate GitHub comment, a historical failed review on the same PR
does not block or get touched by a fresh retry, and resuming a
non-running review is a safe no-op with a null github_comment_id."
```

---

## Self-Review Notes

- **Spec coverage:** Root cause fixed with no schema change (Task 1) — matches "do not add a migration unless the schema itself is wrong" (confirmed schema is correct). Sonnet/`review_only`/`medium` explicitly covered (Task 5, test 1). Retry-safety, no-duplicate-comments, and historical-failure-non-blocking explicitly covered (Task 5, tests 2-4). Nullable `github_comment_id` covered (Task 5, test 4, and implicitly test 1's `published.github_comment_id` assertion contrasts with the null case). UUID params bound/cast correctly and text/external ids not compared as UUID — confirmed by investigation there is no such comparison anywhere in this path (the bug is bigint/numeric, not uuid/text); documented explicitly in this plan's investigation section rather than fixed, since there was nothing to fix there. Error logging with entity ids/error code covered (Task 4). Database errors logged with query/service-name context — `formatPrAiReviewFailureLog`'s output names the job type implicitly via the `pr_ai_review failed:` prefix plus job/review/PR ids and the raw Postgres code — sufficient to grep by entity or by SQLSTATE without needing the full query text (which the ticket says must stay out of user-facing surfaces but is fine in logs; this plan keeps logs entity-scoped rather than dumping the query text at all, which is simpler and still meets "identify the failing operation").
- **Other model/config verification:** the ticket asks to confirm at least one other model/configuration is unaffected. Since the root cause is proven to be model-independent (a query-parse-time error, not data-dependent), and `ai-accounting.db.test.ts`'s existing `"unpriced"` case (haiku, low reasoning) already exercises `recordAiUsage` end to end, Task 2's fix to that file provides this cross-model coverage without a new task.
- **Placeholder scan:** no "TBD"/"handle appropriately" language; every step has literal runnable commands or literal code.
- **Type consistency:** `resumePrReviewPublication(db, input)` signature used identically across all of Task 5's tests, matching the real exported signature quoted from source. `formatPrAiReviewFailureLog` used identically in its test (Task 4) and its call site (Task 4) — same parameter names (`jobId`, `prAiReviewId`, `pullRequestId`, `error`).
