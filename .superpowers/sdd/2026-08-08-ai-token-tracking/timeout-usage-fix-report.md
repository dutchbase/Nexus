# OpenCode planning timeout usage retention

## Root cause

`runOpenCode()` buffered stdout but constructed timeout, cancellation, signal-termination, launch, and nonzero-exit `OpenCodeError`s without consistently attaching the normalized final provider usage. Planning already passes thrown errors to `finalizeAiUsage`, so the missing `error.usage` made finalization record usage as unavailable.

## Change

Added one planning-timeout regression using a stub that emits a valid `step-finish` usage event then exceeds its timeout. `runOpenCode()` now reuses the existing `parseOpenCodeFinalUsage` parser over its buffered stdout whenever it constructs an error. Error codes, messages, timeout/cancellation behavior, and usage validation are unchanged.

No worker change was required: the planning failure path already calls `finalizeAiUsage(runId, error)`, and `finalizeAiUsage` records `result.usage` when present.

## RED evidence

Before the production change:

```text
npx vitest run apps/worker/src/opencode.test.ts
20 tests | 1 failed
invokeOpenCodePlanning > preserves final provider usage when planning times out
Expected usage { inputTokens: 10, outputTokens: 20 }
Received usage: undefined
```

## GREEN evidence

After the production change:

```text
npx vitest run apps/worker/src/opencode.test.ts
20 passed

npx vitest run apps/worker/src/ai-token-lifecycle.test.ts
4 passed

npx tsc --noEmit
exit 0

git diff --check
exit 0
```

## Note

A combined two-file Vitest invocation caused pre-existing-looking cross-file stub interference (the OpenCode child yielded no stdout); each focused file passes when run independently. No production behavior was changed to address this test-runner interaction.
