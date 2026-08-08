# AI token tracking implementation plan

## Goal

Record one durable `agent_runs` row for every top-level AI invocation, with normalized token usage, the effective model price, and its computed API cost. Preserve historical prices, surface costs on tickets and run detail, and add an admin AI-usage dashboard and price management.

## Global constraints

- Extend the existing `agent_runs` lifecycle; do not introduce a per-turn ledger or a new dependency.
- A row represents one top-level provider invocation: planning, plan revision, execution, repair, PR AI review, follow-up description, or conflict resolution. Aggregate internal turns/subagents into that row.
- Never fabricate usage. New rows are `pending`; terminal rows become `captured` only with provider-reported usage, otherwise `unavailable`. Existing rows remain null and show “Not captured”.
- Store exact rendered prompts and task prompts for authenticated admin detail views only. List pages show prompt name/version, never prompt bodies. Escape every rendered value.
- Price lookup is by model and `effective_from <= agent_runs.started_at`; pricing is immutable, append-only, and the selected price id and computed USD cost remain historic facts.
- Token accounting is `input + output + cache read + cache write`; reasoning is a subset of output and is not double-counted. Cost is nullable when no effective price exists.
- Keep scope to required telemetry, UI, and tests: no CSV/export, budgets, alerts, polling, or backfill.
- Follow existing TypeScript, SQL migration, keyset pagination, session-auth, audit-log, and design-token patterns. Write a focused failing test before production behavior.

## Task 1: Persist immutable pricing and invocation accounting

**Files:** new migration after `048`, `packages/domain/src/index.ts`, `packages/domain/src/prompts.ts`, focused domain tests.

1. Add `ai_model_prices`: immutable rows keyed by model/effective time, provider, four non-negative USD-per-million rates (input/output/cache write/cache read), HTTPS source URL, creator, timestamps, and an index for effective price lookup. Apply the project’s append-only trigger pattern.
2. Add nullable AI metadata to `agent_runs`: provider, `pull_request_id`, task prompt, usage status, input/output/reasoning/cache-read/cache-write/total tokens, raw usage JSON, price id, and estimated USD cost. Add non-negative and accounting constraints without changing legacy rows.
3. Add domain types and helpers for provider mapping, lifecycle grouping, invocation creation, and idempotently recording usage/unavailable status. `recordAiUsage` resolves the effective price in SQL and computes the persisted total/cost.
4. Extend prompt snapshot phase typing for all invocation phases.
5. Seed the approved current effective pricing in the migration: Claude Fable/Opus/Sonnet/Haiku and DeepSeek V4 Flash/Pro, with the official HTTPS source URLs and current rates from the approved design.
6. Tests cover provider/lifecycle mapping, totals, idempotency, missing price, effective dated pricing, and legacy null behavior.

## Task 2: Normalize provider usage without changing runner behavior

**Files:** `packages/claude-runner/src/index.ts` and tests; `apps/worker/src/opencode.ts` and tests.

1. Export parsers that extract final normalized usage from Claude JSON/stream events and OpenCode final step events.
2. Preserve raw provider payload in normalized usage and normalize names into the Task 1 domain shape.
3. Handle absent/malformed usage as unavailable rather than throwing or guessing.
4. Deduplicate OpenCode final step updates by stable event/part id.
5. Keep existing runner return contracts backward compatible while exposing final usage to callers.
6. Tests cover Claude planning/execution, cache fields, reasoning subset, OpenCode final events/deduplication, and no-usage paths.

## Task 3: Instrument every worker AI lifecycle

**Files:** `apps/worker/src/worker.ts` and worker tests.

1. At each top-level AI invocation, create the enhanced `agent_runs` row with provider, related ticket/project/PR, task prompt, prompt snapshot, model, and `pending` status before calling a runner.
2. At termination, persist normalized usage/cost or mark it `unavailable`, while retaining normal status/error handling.
3. Cover planning, plan revision, execution, execution repair, PR AI review, PR follow-up description, and PR conflict resolution. Create a prompt snapshot for every path that lacks one today.
4. Associate PR-oriented calls to their pull request and related ticket where available.
5. Test one full captured workflow and unavailable-provider behavior, plus assertions that each lifecycle route records its invocation context.

## Task 4: Add append-only admin model pricing management

**Files:** `apps/web/src/pages/operate.ts`, `apps/web/src/server.ts`, CSS/tests as needed.

1. In the existing admin AI settings tab, list model prices by model and effective date with rates, source, creator, and active/historic labeling.
2. Add a create-only form for model, effective-from, four rates, and HTTPS source. Derive provider server-side from supported models.
3. Validate finite non-negative numbers, a valid timestamp, a supported model, and HTTPS source; never add edit/delete endpoints.
4. Authorize through existing admin sessions and add an `ai_model_price.create` audit event.
5. Tests cover rendering, validation, auth, append-only insert behavior, and audit logging.

## Task 5: Build the admin AI-usage dashboard and enrich run details

**Files:** new `apps/web/src/pages/ai-usage.ts`, `apps/web/src/server.ts`, `apps/web/src/ui.ts`, `apps/web/src/pages/runs.ts`, tests.

1. Add `/admin/ai-usage` under Operate. Default to the past 30 days; support all-time and filters for dates, project, lifecycle group/run type, model, usage status, and ticket/PR search.
2. Use keyset pagination and server-side joins. Provide KPI cards for invocation count, captured total tokens, estimated API cost, and coverage exceptions.
3. List started time, lifecycle, model/provider, compact token breakdown, cost, ticket/PR links, prompt name/version, and status. No prompt body appears in the list.
4. Expand the existing run detail with usage status, totals/breakdown, effective rates/source, price/cost state, task prompt, and exact rendered prompt in collapsed escaped preformatted blocks.
5. Use USD formatting that retains small API costs (up to 8 fraction digits) and existing responsive/admin styles.
6. Tests cover default/filter queries, cursor behavior, totals/coverage, escaping, nav/route, and legacy/not-captured output.

## Task 6: Surface lifecycle costs on each ticket

**Files:** `apps/web/src/pages/tickets.ts` and ticket tests.

1. Rename the ticket “Runs” tab to “AI usage”.
2. Add cost summary cards for Planning (`planning`, `plan_revision`), Execution (`execution`, `execution.repair`), PR work (remaining PR types), and all AI work.
3. Show invocation count, captured total tokens, summed known costs, and coverage labels for unavailable/unpriced/legacy rows.
4. Keep the existing runs list, augment it with concise token/cost/status information, and link each run to its enriched detail.
5. Tests cover group classification, partial coverage, zero/legacy values, and HTML escaping.

## Task 7: Verify the complete cross-cutting feature

**Files:** focused test fixtures/e2e mock and test scripts only where necessary.

1. Extend the mock AI output fixtures to optionally emit valid provider usage and no-usage cases.
2. Add a focused migration/database integration path proving a known price is selected by run time and is unchanged after a later price entry.
3. Run focused suites while implementing, then `pnpm verify` and the relevant E2E/database checks available in this environment.
4. Review the final diff for scope: no unauthenticated prompt exposure, no price mutation, no fabricated usage, no unrequested feature.
