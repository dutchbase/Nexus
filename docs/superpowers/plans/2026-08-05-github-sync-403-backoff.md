# GitHub Sync 403 Backoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `syncOpenPullRequests` from hammering the GitHub API and spamming logs every 2.5 seconds when `GITHUB_TOKEN` lacks permission for an endpoint, and surface which endpoint is failing so the actual credential-scope problem can be diagnosed and fixed.

**Architecture:** `packages/github-provider/src/index.ts`'s `errorFor()` already computes a `retryAt` cooldown for rate-limited (429 / rate-limited-403) responses, and `packages/domain/src/pull-request-sync.ts` already persists that cooldown to `pull_requests.policy_retry_after` on failure — but two things are missing: (1) a non-rate-limited 401/403 gets no cooldown at all (`retryAt` stays `undefined`), and (2) `syncOpenPullRequests`'s SELECT query never filters on `policy_retry_after`, so *even PRs that do have a cooldown* get retried on the very next 2.5-second poll tick regardless. This plan fixes both, using the exact same columns/mechanism that already exist — no schema change, no new columns.

**Tech Stack:** TypeScript, vitest, Node's built-in `fetch`, Postgres (`pg`).

## Global Constraints

- This plan does **not** fix the underlying credential/permission problem — no code change can grant `GITHUB_TOKEN` more scope. `getPullRequestPolicyInputs` (`packages/github-provider/src/index.ts:286-351`) calls up to 6 GitHub REST endpoints per PR sync (get PR, branch protection, reviews, check-runs, commit status, per-reviewer collaborator permission); a 403 on *any* of them produces the reported symptom. Branch-protection and collaborator-permission reads specifically require push/admin-level repo access on the token, not just read access — that's the most likely single cause, but this plan makes the failure diagnosable rather than guessing.
- `GITHUB_TOKEN` is a single global credential (`packages/github-provider/src/index.ts:78`, `authToken()`), shared by the worker's PR sync and `webhook-server.js`'s own GitHub calls (`webhook-server.js:27,48`). Do not add per-project credential plumbing — out of scope (YAGNI); the schema has no such column anywhere (confirmed against every `packages/database/migrations/*.sql` file).
- `GitHubProviderError`'s existing `code` values (`"rate_limited"`, `"transient"`, `"http_error"`, `"invalid_response"`, `"graphql_error"`) are read elsewhere in the codebase (e.g. `pull-request-sync.ts:95` persists `error.code` to `policy_error_code` as free text) — do not rename or repurpose `"http_error"`; a 401/403-without-rate-limit-signals must keep classifying as `"http_error"`, only gaining a populated `retryAt` and a new `endpoint` field.
- Existing tests assert exact SQL substrings (e.g. `pull-request-sync.test.ts:127` — `expect(sql).toContain("pr.state='open'")`) and exact call counts (e.g. `pull-request-sync.test.ts:174` — `expect(log).toHaveBeenCalledOnce()`). Additive SQL/message changes must not break these substring/count assertions.
- Run `pnpm exec tsc --noEmit` and the two touched test files after each task; run the full `pnpm exec vitest run apps packages` once at the end.

---

### Task 1: Give non-rate-limited 401/403 a cooldown and endpoint context

**Files:**
- Modify: `packages/github-provider/src/index.ts:57-102` (`GitHubProviderError` class, `errorFor`)
- Test: `packages/github-provider/src/index.test.ts`

**Interfaces:**
- Produces: `GitHubProviderError` gains a 5th constructor param `public endpoint?: string` (positional, after `retryAt`). `errorFor(response)`'s returned error now has `retryAt` populated (not just `undefined`) for any 401 or 403 that isn't already classified rate-limited, using a new `FORBIDDEN_RETRY_DELAY_MS` (15 minutes) cooldown — distinct from the rate-limit-oriented `retryAt(response)` helper, which reads headers tuned for the "clears within a minute" rate-limit case and would be wrong for a persistent permission problem. `endpoint` is always populated from `response.url` (the Fetch API's `Response.url`, already reflecting the exact requested URL — no call-site changes needed since both callers of `errorFor` share the one function).

- [ ] **Step 1: Write the failing test**

Add to `packages/github-provider/src/index.test.ts` (place near the other 403-handling tests around line 245-300; `withServer` and `getPullRequest` are already imported at the top of the file):

```ts
test("classifies a non-rate-limited 403 as http_error with a cooldown and endpoint context", async () => {
  await withServer((_incoming, outgoing) => {
    outgoing.statusCode = 403;
    outgoing.end("Resource not accessible by integration");
  }, async (baseUrl) => {
    await expect(getPullRequest("acme", "widgets", 42)).rejects.toMatchObject({
      code: "http_error",
      status: 403,
      retryAt: expect.any(String),
      endpoint: `${baseUrl}/repos/acme/widgets/pulls/42`,
    });
  });
});

test("does not add a cooldown to an ordinary 404", async () => {
  await withServer((_incoming, outgoing) => {
    outgoing.statusCode = 404;
    outgoing.end("Not Found");
  }, async () => {
    await expect(getPullRequest("acme", "widgets", 42)).rejects.toMatchObject({
      code: "http_error",
      status: 404,
      retryAt: undefined,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/deploy/projects/dev-control && pnpm exec vitest run packages/github-provider/src/index.test.ts -t "classifies a non-rate-limited 403"`
Expected: FAIL — `retryAt` is `undefined` and there is no `endpoint` property on the rejected error (current `errorFor` only sets `retryAt` when `limited` is true, and `GitHubProviderError` has no `endpoint` field at all).

- [ ] **Step 3: Write the minimal implementation**

In `packages/github-provider/src/index.ts`, replace the `GitHubProviderError` class (lines 57-67):

```ts
export class GitHubProviderError extends Error {
  constructor(
    public code: string,
    message: string,
    public status?: number,
    public retryAt?: string,
    public endpoint?: string,
  ) {
    super(message);
    this.name = "GitHubProviderError";
  }
}
```

Replace `errorFor` (lines 96-102) with:

```ts
const FORBIDDEN_RETRY_DELAY_MS = 15 * 60 * 1000;

async function errorFor(response: Response) {
  const detail = response.status === 403 ? await response.clone().text().catch(() => "") : "";
  const limited = response.status === 429
    || (response.status === 403 && (response.headers.get("x-ratelimit-remaining") === "0" || !!response.headers.get("retry-after") || /rate limit/i.test(detail)));
  const forbidden = !limited && (response.status === 401 || response.status === 403);
  const code = limited ? "rate_limited" : response.status >= 500 || response.status === 408 ? "transient" : "http_error";
  const retry = limited ? retryAt(response) : forbidden ? new Date(Date.now() + FORBIDDEN_RETRY_DELAY_MS).toISOString() : undefined;
  return new GitHubProviderError(code, `GitHub provider request failed with status ${response.status}`, response.status, retry, response.url);
}
```

No other call site needs to change — `responseFor` (line 131, `const error = await errorFor(response);`) and `mergeBranch` (line 366, `throw await errorFor(response);`) both pass a `Response` object, and `Response.url` is populated by the Fetch API automatically.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/deploy/projects/dev-control && pnpm exec vitest run packages/github-provider/src/index.test.ts`
Expected: all tests in the file PASS, including the two new ones. The existing rate-limit tests (lines 245-300) must still pass unmodified — `limited` classification and its `retryAt(response)` computation are untouched.

- [ ] **Step 5: Commit**

```bash
cd /home/deploy/projects/dev-control
git add packages/github-provider/src/index.ts packages/github-provider/src/index.test.ts
git commit -m "fix: give non-rate-limited 401/403 GitHub responses a retry cooldown and endpoint context"
```

---

### Task 2: Honor the retry cooldown in the sync query and log the failing endpoint

**Files:**
- Modify: `packages/domain/src/pull-request-sync.ts:187-200` (`syncOpenPullRequests`)
- Test: `packages/domain/src/pull-request-sync.test.ts`

**Interfaces:**
- Consumes: `GitHubProviderError.retryAt` and `.endpoint` from Task 1 (both now populated for 401/403 as well as rate-limited errors); `pull_requests.policy_retry_after` (existing `timestamptz` column, migration `039_github_policy_snapshots.sql:52`).
- Produces: `syncOpenPullRequests`'s SELECT query excludes any PR whose `policy_retry_after` is still in the future; its per-PR `console.error` includes the failing endpoint when the error is a `GitHubProviderError` with one set.

- [ ] **Step 1: Write the failing tests**

Add to `packages/domain/src/pull-request-sync.test.ts`. First, update the hoisted mock `GitHubProviderError` class (lines 7-13) to accept the 5th param — this only adds a field, it doesn't change any existing test's behavior:

```ts
const github = vi.hoisted(() => ({
  getPullRequestPolicyInputs: vi.fn(),
  listPullRequests: vi.fn(),
  GitHubProviderError: class extends Error {
    constructor(public code: string, message: string, public status?: number, public retryAt?: string, public endpoint?: string) { super(message); }
  },
}));
```

Then add two new tests, placed after the existing `"retains the last snapshot and marks policy stale on a rate limit"` test (after line 76):

```ts
test("retains the last snapshot and marks policy stale on a non-rate-limited 403", async () => {
  database.pool.query
    .mockResolvedValueOnce({ rows: [{ id: "pr-id", current_policy_snapshot_id: "old-snapshot", github_owner: "acme", github_repository: "widgets", number: 42, ticket_id: null }] })
    .mockResolvedValueOnce({ rows: [], rowCount: 1 })
    .mockResolvedValueOnce({ rows: [], rowCount: 1 });
  github.getPullRequestPolicyInputs.mockRejectedValue(new github.GitHubProviderError(
    "http_error", "forbidden", 403, "2026-08-04T12:15:00Z", "https://api.github.com/repos/acme/widgets/branches/main/protection",
  ));

  await expect(syncPullRequest("pr-id")).rejects.toMatchObject({ code: "http_error", status: 403 });

  expect(database.pool.query.mock.calls[2][0]).toContain("policy_stale=true");
  expect(database.pool.query.mock.calls[2][1]).toEqual(["pr-id", "http_error", "2026-08-04T12:15:00Z", expect.any(String)]);
});

test("excludes pull requests still in their retry cooldown from the sync batch", async () => {
  database.pool.query.mockResolvedValue({ rows: [] });

  await syncOpenPullRequests();

  const select = database.pool.query.mock.calls.find(([sql]) => String(sql).includes("SELECT pr.id FROM pull_requests"));
  expect(String(select?.[0])).toContain("policy_retry_after");
});

test("logs the failing endpoint when a per-PR sync fails with a GitHub provider error", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  database.pool.query.mockImplementation(async (sql: string, values?: unknown[]) => {
    if (sql.includes("SELECT pr.id FROM pull_requests")) return { rows: [{ id: "pr-1" }] };
    if (sql.includes("WHERE pr.id=$1")) return { rows: [{ id: values?.[0], github_owner: "acme", github_repository: "widgets", number: 42, ticket_id: null }] };
    return { rows: [], rowCount: 1 };
  });
  github.getPullRequestPolicyInputs.mockRejectedValue(new github.GitHubProviderError(
    "http_error", "forbidden", 403, "2026-08-04T12:15:00Z", "https://api.github.com/repos/acme/widgets/branches/main/protection",
  ));

  await syncOpenPullRequests();

  expect(log).toHaveBeenCalledWith(expect.stringContaining("https://api.github.com/repos/acme/widgets/branches/main/protection"), expect.anything());
  log.mockRestore();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/deploy/projects/dev-control && pnpm exec vitest run packages/domain/src/pull-request-sync.test.ts -t "retry cooldown|non-rate-limited 403|failing endpoint"`
Expected: FAIL — the SELECT query has no `policy_retry_after` filter (so the second new test's `toContain` assertion fails), and the per-PR catch block's `console.error` call doesn't include the endpoint (so the third new test's assertion fails). The first new test should already pass after Task 1 alone (it only exercises the existing catch-block persistence path with the now-populated `retryAt`) — that's expected; it's here as regression coverage for the 403 case specifically, mirroring the existing rate-limit test.

- [ ] **Step 3: Write the minimal implementation**

In `packages/domain/src/pull-request-sync.ts`, replace `syncOpenPullRequests` (lines 187-200):

```ts
export async function syncOpenPullRequests(assertOwned: () => Promise<void> = async () => {}) {
  const rows = (await pool.query(
    `SELECT pr.id FROM pull_requests pr
     WHERE pr.provider='github' AND pr.state='open'
       AND (pr.policy_retry_after IS NULL OR pr.policy_retry_after <= now())
     ORDER BY pr.last_synced_at NULLS FIRST`,
  )).rows;
  for (const row of rows) {
    try {
      await syncPullRequest(row.id, "worker", undefined, assertOwned);
    } catch (error) {
      await assertOwned();
      const endpoint = error instanceof GitHubProviderError && error.endpoint ? ` (${error.endpoint})` : "";
      console.error(`Pull-request sync failed for ${row.id}${endpoint}:`, error);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/deploy/projects/dev-control && pnpm exec vitest run packages/domain/src/pull-request-sync.test.ts`
Expected: all tests PASS, including all pre-existing ones — in particular `"syncs policy inputs for an open imported pull request without a ticket"` (line 124-146), which asserts `expect(sql).toContain("pr.state='open'")` on the same query text: still true, since the new filter is additive.

- [ ] **Step 5: Commit**

```bash
cd /home/deploy/projects/dev-control
git add packages/domain/src/pull-request-sync.ts packages/domain/src/pull-request-sync.test.ts
git commit -m "fix: honor policy_retry_after cooldown in syncOpenPullRequests and log the failing GitHub endpoint"
```

---

## Verification (end-to-end)

From the repo root:
```bash
pnpm exec tsc --noEmit
pnpm exec vitest run packages/github-provider packages/domain/src/pull-request-sync.test.ts
pnpm exec vitest run apps packages
```
All must pass with no failures.

**Manual confirmation once deployed:** watch the worker log (`pm2 logs dcc-worker`) — instead of the same `syncOpenPullRequests`/`403` stack trace repeating roughly every 2.5 seconds for every affected PR, it should log once per affected PR, then go quiet for 15 minutes (the new `FORBIDDEN_RETRY_DELAY_MS` cooldown) before retrying, and the log line will now name the exact GitHub REST endpoint that returned 403 (e.g. `.../branches/main/protection` or `.../collaborators/<login>/permission`) — that endpoint tells you exactly which permission to add to `GITHUB_TOKEN`.

## Out of scope (deliberate)

- Actually fixing `GITHUB_TOKEN`'s scope/permissions — that's a credential change on GitHub's side (rotate/reissue the PAT with the needed permission, most likely "Administration: Read" on a fine-grained PAT, or ensure a classic PAT's `repo` scope is intact and SSO-authorized for the org), not a code change. Task 2's endpoint logging is what makes that follow-up action possible to do correctly instead of guessing across 6 candidate endpoints.
- `webhook-server.js`'s own `GITHUB_TOKEN` usage (`webhook-server.js:27,48`) — same underlying credential, but a separate code path already covered by this session's earlier work; not touched here.
- GraphQL error handling (`graphqlRequest`, `index.ts:175-186`) — doesn't call `errorFor`, constructs its own rate-limit-only classification; the reported 403 is on REST calls only (`getPullRequestPolicyInputs`), so this is untouched (YAGNI).
- Backing off 404/422 or other non-auth 4xx responses — those usually mean something else entirely (PR deleted, branch renamed) and merit different handling than a blanket cooldown; explicitly not addressed here (confirmed by the added "does not add a cooldown to an ordinary 404" test in Task 1).
