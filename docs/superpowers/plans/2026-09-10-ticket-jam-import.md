# Ticket Jam import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A ticket's Jam link automatically imports technical evidence for admins and their planning workflow, without delaying ticket submission or exposing operational data to reporters.

**Architecture:** Save one normalized source link and queue a generation-bound import in the existing PostgreSQL job system. A worker-only MCP adapter retrieves bounded read-only evidence; ticket views, planning prompts and immutable approval snapshots consume the saved result.

**Tech Stack:** TypeScript, PostgreSQL jobs, official MCP TypeScript client, existing worker lease handling, Vitest and Playwright.

**Spec:** `docs/superpowers/specs/2026-09-10-project-ticket-portal-design.md`. Dependencies: `2026-09-10-project-ticket-access.md` and `2026-09-10-ticket-image-paste.md`.

## Global Constraints

- Node.js >=22; pnpm 11.17.0; PostgreSQL 16; TypeScript; existing Node HTTP server and HTML renderer.
- Prefix shell commands with `rtk`; use `rtk proxy` for commands without a suitable filter.
- Preserve existing opaque sessions, Argon2 password hashing, CSRF checks, upload signature checks, artifact integrity and worker lease checks.
- Only admins may access `/admin` and `/api/admin/*`, except the existing public login and explicitly shared session/logout aliases.
- Reporter mutations never enqueue planning/execution jobs or mutate operational workflow state.
- New database tests run against disposable databases, one database per test file; never point reset-based tests at an existing environment.
- No production migration, deployment, account creation or Jam credential configuration is part of this planning task.

---

## Verified provider surface and remaining live check

Jam documents a remote MCP endpoint and technical-context read tools. Its PATs support `mcp:read`, are workspace-scoped and expire. An ordinary pasted link does not confer access to private data that the connected account cannot see. [MCP](https://jam.dev/docs/jam-mcp), [PATs](https://jam.dev/docs/personal-access-tokens)

Use the current stable official `@modelcontextprotocol/client` package. The SDK documents `Client`, `StreamableHTTPClientTransport`, bearer `AuthProvider`, tool discovery and calling; do not build JSON-RPC framing or SSE parsing by hand. Resolve and lock the exact compatible version when implementing. [Official client guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/client.md)

No authenticated Jam request was performed when writing this plan. Full provider tool schemas and real capture payloads must be checked by the contract probe in Task 2 before claiming production integration works. No private endpoint or guessed `getDetails` argument name is assumed here.

## File map

| Files | Responsibility |
| --- | --- |
| `packages/database/migrations/066_ticket_jam_context.sql` | Source URL and current context generation/state/data |
| `packages/domain/src/ticket-jam.ts`, `.test.ts` | URL normalization, transactional enqueue/invalidation, evidence selection |
| `apps/worker/src/jam-client.ts`, `.test.ts` | MCP connection, schema binding, bounded calls and safe normalization |
| `apps/worker/src/jam-enrichment.ts`, `.db.test.ts` | Current-generation import, lease publication, retries |
| `apps/worker/src/worker.ts` | Explicit capability, dispatch and ingestion failure path |
| `apps/web/src/server.ts`, `ticket-submissions.ts`, `ticket-api.ts` | Save/retry/read boundaries and snapshot inclusion |
| `apps/web/src/ui.ts`, `reporter-ui.ts`, `pages/forms.ts`, `pages/shared.ts`, `pages/tickets.ts` | Jam form field, safe link/outcome, admin evidence panel |
| `packages/domain/src/planning-inputs.ts`, `prompts.ts`, `plan-approval.ts` tests; `apps/worker/src/worker-boundary.ts` approved input builder | Evidence in captured planning/execution inputs and freshness |
| `apps/worker/package.json`, `pnpm-lock.yaml`, `.env.example`, `apps/web/src/security.ts`, deployment/runbook files | Pinned dependency and worker-only token |
| `apps/worker/src/jam-contract.ts`, `apps/worker/src/fixtures/jam-contract.json`, `tests/e2e/jam-import.spec.ts` | Read-only contract probe, sanitized fixture and integration journey |

## Task 1: Add the Jam field and atomically queue source generations

**Files:** Create migration 066, `packages/domain/src/ticket-jam.ts`, `ticket-jam.test.ts`, `apps/web/src/ticket-jam.db.test.ts`; modify form builder/renderer/validators, `ticket-submissions.ts`, `server.ts` public/admin save paths.

**Interfaces:**

```ts
export type JamState = "queued" | "fetching" | "ready" | "partial" | "failed" | "not_configured";
export type JamErrorCode = "not_configured" | "access_denied" | "not_found" |
  "rate_limited" | "timeout" | "unavailable" | "unsupported_schema" | "invalid_response";
export type JamSource = { id:string; url:string };
// ticket-jam.ts exports:
// normalizeJamUrl(value:unknown):JamSource|null -- null for blank/null; throws status 422 for invalid input
// setTicketJamSource(client:QueryClient,ticketId:string,value:unknown):Promise<void>
// queueJamRetry(client:QueryClient,ticketId:string):Promise<void> -- caller must enforce admin
// ticketJamEvidence(client:QueryClient,ticketId:string):Promise<JamEvidence|null>
// JamEvidence defined in Task 2; no background I/O in these functions.
```

Extend `SubmissionFields` with `jam_url?:string|null`; `ReporterTicket` gains `jam_url:string|null` and `jam_import:{state:JamState;message:string}|null` only. Admin detail gets `jam_context` separately. No arbitrary `data_json` in reporter/public input or output.

- [ ] **Step 1: Add failing URL and transactional queue tests.**

```ts
expect(normalizeJamUrl(" https://jam.dev/c/abc123?utm_source=copy#details ")).toEqual({
  id: "abc123", url: "https://jam.dev/c/abc123",
});
expect(normalizeJamUrl("")).toBeNull();
for (const input of ["http://jam.dev/c/abc", "https://jam.dev.evil.test/c/abc",
  "https://user:pass@jam.dev/c/abc", "https://127.0.0.1/c/abc", "https://jam.dev:444/c/abc",
  "https://jam.dev/c/a/b", "https://jam.dev/c/%2e%2e", "javascript:alert(1)"]) {
  expect(() => normalizeJamUrl(input)).toThrow();
}
```

In the real-DB test, save a reporter ticket with a Jam URL and assert exactly one `ticket.jam_enrich` job plus `Submitted` status and no agent runs. Save the same URL again and assert the same generation/job. Force ticket validation failure and assert no context/job rows survive. Clear/replace the link and verify the original evidence is unavailable immediately.
- [ ] **Step 2: Run `rtk proxy pnpm exec vitest run packages/domain/src/ticket-jam.test.ts apps/web/src/ticket-jam.db.test.ts`.** Expected missing API/module/schema.
- [ ] **Step 3: Add schema and canonical URL parsing.**

```sql
ALTER TABLE tickets ADD COLUMN jam_url text;
CREATE TABLE ticket_jam_contexts (
  ticket_id uuid PRIMARY KEY REFERENCES tickets(id) ON DELETE CASCADE,
  source_url text NOT NULL,
  generation uuid NOT NULL DEFAULT gen_random_uuid(),
  state text NOT NULL CHECK(state IN ('queued','fetching','ready','partial','failed','not_configured')),
  data_json jsonb,
  content_hash text,
  error_code text,
  fetched_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

Validate actual string type and <=2048 characters before `new URL`. Require `protocol==='https:'`, exact `hostname==='jam.dev'`, blank username/password, blank port (URL normalizes default HTTPS port) and pathname matching `/^\/c\/([A-Za-z0-9_-]{1,128})\/?$/`. Strip query/hash from the stored source. This accepts both UUID-style and short IDs, while Jam validates actual existence. Do not resolve/fetch the pasted URL.
- [ ] **Step 4: Implement generation-bound enqueue inside each save transaction.** Lock ticket, compare canonical URL, and return without writes if unchanged. On change, update `tickets.jam_url`, clear old data, generate a fresh UUID and upsert current context to `queued`. On clear, delete the current context row and set ticket URL null. Call existing `enqueueJob` using this shape:

```ts
await enqueueJob({
  type: "ticket.jam_enrich",
  payload: { ticket_id: ticketId, generation },
  idempotencyKey: `ticket-jam:${ticketId}:${generation}`,
  maxAttempts: 3,
}, client);
```

The enclosing ticket service increments submission revision once for the whole save. No token, source body or imported data enters job payloads. Mark approved plans stale with `SELECT mark_ticket_plan_potentially_stale($1)` when source changes; this is derived freshness metadata, not a workflow transition. For an initial null/absent link, create no context or job.

Integrate into existing admin POST/PATCH, reporter POST/PATCH and public `submitPublicForm` before commit. Public intake's existing idempotency branch must not enqueue again. Filter `jam_url` out of arbitrary custom JSON and reject forged nested Jam state/data fields. Public form reads/submission responses expose no imported data.
- [ ] **Step 5: Add `jam_link` to builder, preview, validation and create/edit forms.** Reserve field key `jam_url`; reject another key for this type, a `jam_url` field of another type, or two Jam fields in one form. Default label is "Jam link" with placeholder `https://jam.dev/c/...`; description: "Paste a Jam link to include technical details." Optional unless admin marks it required. Render as a URL input; allow empty optional values. Existing persisted forms remain unchanged until configured; standard authenticated forms include the optional field. On source-form edit populate the saved canonical URL. Generic `url` fields must not trigger Jam imports.
- [ ] **Step 6: Run form and queue tests and commit.** Include malformed host/credentials/port/path, required/optional, form preview, idempotent save, replacement, clear and failed-save rollback. Commit `feat: save Jam links and queue ticket evidence imports`.

## Task 2: Implement the bounded, read-only Jam provider adapter

**Files:** Create `apps/worker/src/jam-client.ts`, `jam-client.test.ts`, `jam-contract.ts`, `fixtures/jam-contract.json`; extend `ticket-jam.ts` evidence types; modify worker `package.json` and lockfile.

**Interfaces:**

```ts
export type JamEvidence = {
  sourceUrl:string;
  device: { browser?:string; os?:string; viewport?:string; pageUrl?:string };
  console: { level:string; message:string; time?:string }[];
  network: { method:string; url:string; status?:number; durationMs?:number }[];
  events: { type:string; description:string; time?:string }[];
  metadata: Record<string,string|number|boolean|null>;
  transcript?:string;
  unavailableSections:string[];
  truncatedSections:string[];
};
export type JamImportResult = { state:"ready"|"partial"; evidence:JamEvidence; contentHash:string };
export class JamImportError extends Error {
  constructor(public code:JamErrorCode, public retryable:boolean, public retryAfterSeconds?:number) {
    super(code); // no provider text, headers or credentials in logs
  }
}
// jam-client.ts exports:
// fetchJamContext(source:JamSource, options:{token:string;signal:AbortSignal}):Promise<JamImportResult>
// normalizeJamEvidence(source:JamSource, sections:Record<string,unknown>):JamEvidence
// redactJamValue(value:unknown):unknown
// bindJamToolArguments(schema:unknown,id:string,options?:{limit?:number;after?:string}):Record<string,unknown>
// boundedJamFetch(input:RequestInfo|URL,init?:RequestInit):Promise<Response>
```

- [ ] **Step 1: Add failing normalization and boundary tests with a mocked transport.** Test redaction and network metadata projection before introducing the real SDK:

```ts
const redacted = redactJamValue({
  authorization: "Bearer secret-one", cookie: "session=secret-two",
  nested: { password: "secret-three", access_token: "secret-four" },
  requestBody: "private form input", safe: "render failed",
});
expect(JSON.stringify(redacted)).not.toMatch(/secret-one|secret-two|secret-three|secret-four|private form input/);
expect(JSON.stringify(redacted)).toContain("render failed");
await expect(boundedJamFetch("https://localhost/private")).rejects.toThrow();
```

Add tests for HTML-looking messages rendered as text, token-bearing URLs reduced to origin/path, missing sections, malformed MCP text/JSON, provider `isError`, pagination beyond limit, a response stream exceeding the byte cap, repeated cursors, deadline abort and a malicious redirect to another origin. Use a test-injected fetch adapter; production URL is fixed.
- [ ] **Step 2: Run `rtk proxy pnpm exec vitest run apps/worker/src/jam-client.test.ts`.** Expected module missing.
- [ ] **Step 3: Install the stable official client with an exact lock and establish a read connection.** `rtk proxy pnpm --filter worker add --save-exact @modelcontextprotocol/client@latest`. Record the resolved version in the PR and check Node >=22 compatibility. The adapter connection uses:

```ts
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const client = new Client({ name: "nexus-jam-ingestion", version: "1.0.0" });
const transport = new StreamableHTTPClientTransport(new URL("https://mcp.jam.dev/mcp"), {
  authProvider: { token: async () => options.token },
  fetch: boundedJamFetch,
});
await client.connect(transport);
try {
  const { tools } = await client.listTools();
  const details = tools.find(tool => tool.name === "getDetails");
  if (!details) throw new JamImportError("unsupported_schema", false);
  const args = bindJamToolArguments(details.inputSchema, source.id);
  const result = await client.callTool({ name: details.name, arguments: args });
  if (result.isError) throw new JamImportError("invalid_response", false);
} finally {
  await client.close();
}
```

Use SDK-supported cancellation/request timeout options from the installed declarations; propagate the overall abort to all requests and close in `finally`, including partial connect failures. Advertise no sampling, elicitation, filesystem roots or callbacks that could execute instructions. Pin the supported negotiation mode after testing against Jam; the SDK handles its protocol handshake.
- [ ] **Step 4: Bind actual tool schemas and record the contract.** Use required `getDetails`, and optional `getConsoleLogs`, `getNetworkRequests`, `getUserEvents`, `getMetadata`, `getVideoTranscript`. For each discovered schema, accept exactly one documented string ID selector among `jamId`, `id`, `jam_id`; only use the property actually advertised by that tool. Pass only advertised optional `limit`/`after`. Reject unknown required arguments with `unsupported_schema`; never guess an input field or ask an agent to construct it. Call `client.callTool({name,arguments:bound})` and parse structured output first, then JSON text; preserve bounded plain text when a tool legitimately returns prose.

`jam-contract.ts` is a read-only probe: requires worker runtime, `DCC_JAM_TOKEN`, and `DCC_JAM_SAMPLE_URL`; normalizes the URL, lists schemas, imports the sample through the adapter, strips all identifiers/content/secrets and writes only schema/type shapes to `fixtures/jam-contract.json` when explicitly passed `--write-fixture`. Default prints names, validation result and counts only. Run `rtk proxy pnpm --filter worker exec tsx src/jam-contract.ts` with credentials already configured in the execution environment. If absent, offline implementation/tests continue, but record live verification as incomplete and do not mark Jam release acceptance complete.

The fixture must contain the observed schemas for screenshot/video/Instant Replay where available and optional/missing data cases. Only commit synthetic/redacted data. Verify the schema binder using these real shapes before enabling the production adapter.
- [ ] **Step 5: Bound, sanitize and normalize ingestion.** `boundedJamFetch` permits only exact `https://mcp.jam.dev/mcp`, rejects redirects with `redirect:'error'`, combines abort signals and caps received bytes at 2 MiB per tool response before handing the stream to the SDK. Apply 10 seconds/call and 30 seconds/import. Page through at most five pages and 500 entries per section; stop repeated cursors and set truncation markers. Optional tool failures become `unavailableSections`; no usable details is failure. Preserve available device/browser/OS/page data; never invent missing values.

Project network rows to method, origin/path, status and timing only, and drop body/header fields before persistence. Drop typed input values from user events; redact sensitive metadata keys recursively (case-insensitive password, secret, token, authorization, cookie, api-key variants), remove bearer/token patterns from log strings, and strip URL queries/fragments throughout free text. Store only the evidence type above with at most 256 KiB serialized UTF-8; trim longest sections deterministically and mark them. Hash canonical normalized evidence without fetch timestamp so identical retries have the same material hash.
- [ ] **Step 6: Verify error classes and commit.** Map missing token to `not_configured`; 401/403 to nonretryable `access_denied`; 404 to nonretryable `not_found`; invalid schema/data to nonretryable codes; 429/5xx/network timeout to retryable safe codes. Clamp provider Retry-After to 300 seconds. Assert raw responses/tokens never appear in errors or console output. Run adapter tests and commit `feat: import sanitized technical context through Jam MCP`.

## Task 3: Integrate imports with worker leases and failure recovery

**Files:** Create `apps/worker/src/jam-enrichment.ts`, `jam-enrichment.db.test.ts`; modify `apps/worker/src/worker.ts`, `role.test.ts`, `apps/web/src/security.ts`, `security.test.ts`, `.env.example`, deployment runbook and environment separation tests.

**Interfaces:** `runJamEnrichment(job:Job, lease:{signal:AbortSignal;assertOwned():Promise<void>}, fetcher=fetchJamContext):Promise<void>`; `failJamEnrichment(job:Job,workerId:string,error:JamImportError,lease):Promise<void>`. Reuse `Job`, `failJob`, `completeJob` and `inTransaction` from `@dcc/domain`/`@dcc/database`; do not create another queue.

- [ ] **Step 1: Write failing replacement/lease tests against a real database.** In the fixture create generation A, start a controlled fetch promise, replace the link with generation B, then resolve A:

```ts
let resolveOldFetch!: (value: JamImportResult) => void;
const oldFetch = {
  promise: new Promise<JamImportResult>(resolve => { resolveOldFetch = resolve; }),
  resolve: (value: JamImportResult) => resolveOldFetch(value),
};
const running = runJamEnrichment(jobA, ownedLease, () => oldFetch.promise);
await waitUntilFetching(ticketId, generationA);
await inTransaction(client => setTicketJamSource(client, ticketId, "https://jam.dev/c/new-capture"));
oldFetch.resolve({ state: "ready", evidence: evidenceA, contentHash: hashA });
await running;
const current = (await pool.query("SELECT * FROM ticket_jam_contexts WHERE ticket_id=$1", [ticketId])).rows[0];
expect(current.generation).not.toBe(generationA);
expect(current.data_json).toBeNull();
```

Define `waitUntilFetching` in this test file as a 5-second bounded poll of `state/generation`; use the repository's existing worker lease test fixture for `ownedLease`, with real owned job rows. Define synthetic `evidenceA` using the complete `JamEvidence` shape from Task 2. Add clearing/deleting/replacing URL and lost-lease cases. Assert ticket workflow status and agent run count never change.
- [ ] **Step 2: Run `rtk proxy pnpm exec vitest run apps/worker/src/jam-enrichment.db.test.ts`.** Expected missing handler or stale publication.
- [ ] **Step 3: Add explicit dispatch and lease-aware publication.** Add `ticket.jam_enrich` to `workerCapabilities` and dispatch before the existing final `runExecution` branch. Set `fetching` only for a current visible generation, then fetch outside a DB transaction. Missing token records `not_configured` and returns. Publication reacquires ticket lock and checks source/generation/deletion and lease before writing:

```sql
UPDATE ticket_jam_contexts c SET state=$3,data_json=$4,content_hash=$5,
  error_code=NULL,fetched_at=now(),updated_at=now()
FROM tickets t WHERE c.ticket_id=t.id AND c.ticket_id=$1 AND c.generation=$2
  AND c.source_url=t.jam_url AND t.submitter_deleted_at IS NULL
RETURNING c.ticket_id;
```

`lease.assertOwned()` and DB job-owner/lease checks execute within the publication transaction using the same convention as existing worker publication handlers. Discard stale results without errors. If material evidence differs from the previous result, call `mark_ticket_plan_potentially_stale(ticketId)` and advance `tickets.updated_at` so concurrent approvals fail; do not change reporter `submission_updated_at/revision`. A no-op repeated result leaves material input unchanged.
- [ ] **Step 4: Separate ingestion failure from workflow failure.** The current worker catch calls `failClaimedWorkflowJob` for general failures. Add a Jam-specific catch that uses `failJob` and updates context state without calling workflow reconciliation. Permanent failures save safe code/state and complete the job; transient failures requeue through existing backoff for up to three total attempts. After `failJob`, bound `available_at` to the greater of its backoff and sanitized Retry-After. On exhaustion set `failed`; on retry set `queued`. A lost lease writes nothing. Queue recovery after process death can reclaim a `fetching` generation; the handler must allow reentry. Current-generation state only is updated.
- [ ] **Step 5: Add admin retry and worker-only secret configuration.** `/api/admin/tickets/:ref/jam/retry` uses `requireAdmin` and CSRF, locks ticket/current context, accepts only `failed` or `not_configured` with a current URL (otherwise 409), creates a new generation and enqueues once. It does not expose provider text. Document `DCC_JAM_TOKEN` in `.env.example` as worker-only; `validateWebRuntime` rejects it in production. Check `ecosystem.config.cjs`, `deploy.sh`, `scripts/dev.ts`, and the current deployment runbook so web startup never inherits this variable when configured for the worker. Do not add it to agent child environment allowlists or archived config. Test a sentinel token is absent from web/agent env, HTML, API, job payload and audit output.
- [ ] **Step 6: Run worker/lease/security tests and commit.** Include duplicate delivery, already-fetched retry, 429→success, exhausted timeout, missing/expired token, partial tools, replacement/clear/deletion while in flight and worker restart. Commit `feat: process Jam imports with bounded retries and stale-result checks`.

## Task 4: Display imported evidence and preserve planning/approval inputs

**Files:** Modify `apps/web/src/pages/tickets.ts`, `reporter-ui.ts`, `ticket-api.ts`, `server.ts` (`approvalInputsFor`), `packages/domain/src/planning-inputs.ts`, `prompts.ts`, `apps/worker/src/worker-boundary.ts` (`approvedExecutionInput`) and `apps/worker/src/task-7.test.ts`; create `packages/domain/src/ticket-jam-evidence.test.ts`, `apps/web/src/ticket-jam-approval.db.test.ts`, `tests/e2e/jam-import.spec.ts`; extend `README.md` and deployment runbook.

**Interfaces:** `ticketJamEvidence(client,ticketId)` returns current ready/partial `JamEvidence` only when source matches and ticket is not reporter-deleted. Extend `PlanningPromptInputs.ticket` with `jamEvidence?:JamEvidence|null`. Approved snapshot's `ticket` object includes `jamUrl` and `jamEvidence` with its content hash; `approvedExecutionInput` consumes the captured value without re-fetching. `renderJamEvidence(evidence:JamEvidence,maxBytes=32768):string` belongs in `packages/domain/src/ticket-jam.ts`.

- [ ] **Step 1: Add failing prompt and permission tests.** Build synthetic evidence with a console error and assert planning input contains that error and source link, but no secrets. A reporter detail response has only link/outcome, even if the same ticket has ready evidence. Test canonical approval hashes differ for changed source/content but not fetch timestamps:

```ts
const evidence = { sourceUrl:"https://jam.dev/c/capture-a", device:{browser:"Test Browser"},
  console:[{level:"error",message:"save failed"}], network:[], events:[], metadata:{},
  unavailableSections:[], truncatedSections:[] } satisfies JamEvidence;
expect(renderJamEvidence(evidence)).toContain("save failed");
expect(renderJamEvidence(evidence)).toContain("Untrusted ticket evidence");
expect(Buffer.byteLength(renderJamEvidence(evidence), "utf8")).toBeLessThanOrEqual(32768);
```

- [ ] **Step 2: Run `rtk proxy pnpm exec vitest run packages/domain/src/ticket-jam-evidence.test.ts apps/web/src/ticket-jam-approval.db.test.ts`.** Expected missing evidence mapping/staleness.
- [ ] **Step 3: Add admin evidence panel and safe reporter outcome.** Admin Original submission shows the Jam source link and import status. Ready/partial evidence is escaped in labeled device/console/network/events/metadata sections; unavailable/truncated sections are stated. Failed/not-configured states offer Retry and a safe explanation. Keep the link usable when imports fail. Source links use canonical HTTPS URLs and `rel='noopener noreferrer'` if opened in a new tab.

Reporter view shows only "Import pending", "Details imported", "Some details imported", or "Details could not be imported" alongside the source link, never provider access errors, worker/jobs IDs, timing, raw logs or retry controls. Poll only the scoped ticket detail endpoint while import is pending, stop on terminal outcome or 401/403/404, and do not poll generic job APIs. Public confirmation stays its existing submission receipt; anonymous users receive no read endpoint. For a submitter-deleted ticket, admin UI labels any skipped pending import "Import skipped: ticket deleted from portal" and stops polling; retry on such a ticket returns 409.
- [ ] **Step 4: Add evidence to planning and captured approval input.** `planningPromptInputs` reads current saved evidence and passes it to `buildPlanningPrompt`. `renderJamEvidence` emits an explicit untrusted-evidence block with sections, normalized source and truncated/absent markers, limited to 32 KiB UTF-8 at character boundaries. Incoming content is data, never system instructions. Do not fetch Jam during GET preview, plan approval, or execution.

`approvalInputsFor` includes the normalized source, content hash and sanitized evidence inside `approvedInput.ticket`; generation and fetch timestamps are concurrency metadata and stay outside the material hash. Add that same saved evidence to the captured execution/repair prompt or the approved-input builder, so downstream runs use the approved material rather than live context. Source/evidence changes mark approved plans stale; existing `checkPlanApprovalGate` then denies new execution until admin reapproves. Cover a queued execution when the import finishes: it must fail the stale-input gate before spawning the agent. An execution already started retains its captured evidence and does not hot-reload.

When source is pending/failed, include its URL and an explicit missing-evidence marker in planning; administrators may still plan. A later successful import invalidates an earlier approval. No auto-plan or auto-execute behavior is added.
- [ ] **Step 5: Add complete offline browser and provider verification.** Use a mock MCP HTTP endpoint in the existing isolated E2E harness; allow override only when `NODE_ENV!=='production'` and `DCC_JAM_TEST_ENDPOINT` is a loopback URL. Production adapter still enforces the fixed endpoint. Extend `tests/e2e/run-e2e.sh` to start/stop the mock in its owned process group and scrub the mock token from the web environment, using the harness's existing cleanup conventions. Have the mock implement discovery, selected read tools, a delayed response and transient failure.

Through the UI create a reporter ticket with a Jam link, assert ticket saves before the delayed import completes, then see a simple imported outcome. Log in as admin and assert normalized device/console/network evidence appears; initiate prompt preview as admin and verify evidence. Replace/clear the URL while import is delayed and assert old evidence does not reappear. Request admin context/preview as reporter and assert 403. Exercise a public form configured with `jam_link` and confirm it queues evidence without exposing it anonymously.
- [ ] **Step 6: Run final verification and document configuration.** `rtk proxy pnpm verify`; run each new DB suite with its own disposable URL; `rtk proxy bash tests/e2e/run-e2e.sh jam-import.spec.ts reporter-tickets.spec.ts ticket-image-paste.spec.ts public-intake.spec.ts planning.spec.ts execution.spec.ts`. Run the read-only live contract probe with a valid operator Jam token and accessible sample; record actual tool schemas, available sections and safe error behavior. If credentials are not available, report that live check separately instead of presenting the mock as live evidence. Verify deployment env split before configuring a real token. Commit `feat: expose Jam ticket evidence to admin planning` after `rtk git diff --check`.

## Acceptance checklist

- [ ] Builder, preview, public intake, admin and reporter create/edit all support one validated Jam link.
- [ ] Save/import enqueue is atomic and idempotent; no fetch blocks form submission.
- [ ] Official provider contract is tested; no scraped/private API or invented argument shape.
- [ ] Worker imports available technical details, caps work/data, redacts secrets and uses no LLM/agent execution.
- [ ] Missing/access-denied/expired/rate-limited/unavailable captures give safe outcomes and bounded retries.
- [ ] Replaced/cleared/deleted links and lost leases cannot publish stale evidence.
- [ ] Reporter/public users cannot access raw imported context or any admin workflow through the integration.
- [ ] Admin sees evidence; planning and execution snapshots include the approved evidence; changes invalidate future execution approval.
- [ ] Token configuration remains worker-only and an authenticated sample has passed before production enablement.

## Release notes and rollback

Ship the account boundary before allowing reporter account creation. The image increment follows, then Jam after the live provider check. Apply migrations through the existing reviewed deployment process, with a database backup and all suites passing. This document does not authorize deployment by itself.

If Jam must be disabled, stop accepting new imports through configuration while continuing to save source links and show `not_configured`; keep the columns/evidence/history. Do not roll back to an older build whose admin guard accepts every session while reporter accounts exist. Disable reporter accounts and invalidate their sessions before any emergency rollback to pre-role-aware code. Preserve uploaded artifacts and immutable approval snapshots; do not drop new columns/tables as an automatic rollback step.
