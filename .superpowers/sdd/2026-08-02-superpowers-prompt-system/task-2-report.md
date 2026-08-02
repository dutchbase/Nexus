# Task 2 report

## Files

- `config/agent-content.json`
- `scripts/update-superpowers.ts`
- `scripts/sync-agent-content.ts`
- `scripts/superpowers-content.test.ts`
- `packages/database/migrations/017_agent_content.sql`

## TDD evidence

Red: `pnpm exec vitest run scripts/superpowers-content.test.ts` failed because `scripts/update-superpowers.ts` did not exist.

Red: the changed-source prompt test failed because sync read the repository prompt instead of the supplied catalog source.

Green: `pnpm exec vitest run scripts/agent-content.test.ts scripts/superpowers-content.test.ts` — 2 files, 6 tests passed.

## Verification

- `pnpm exec tsc --noEmit` — passed.
- `git diff --check` — passed.

## Commit

`5373929 feat: sync curated agent content`

## Concerns

The importer intentionally requires a local checkout with matching `package.json` version and MIT `LICENSE`; it makes no network calls.

## Fix round 1

### Files

- `scripts/update-superpowers.ts`
- `scripts/sync-agent-content.ts`
- `scripts/superpowers-content.test.ts`

### TDD evidence

Red: the new provenance, destructive-destination, and removed-registry tests failed because the pre-fix importer accepted a non-tagged same-version checkout, accepted an out-of-bound destination, and sync did not disable stale rows.

Red: the configured-vendor catalog test failed with `readImportedAgentContentCatalog is not a function`.

Green: `pnpm exec vitest run scripts/agent-content.test.ts scripts/superpowers-content.test.ts` — 2 files, 10 tests passed.

### Verification

- `pnpm exec tsc --noEmit` — passed.
- `git diff --check` — passed.

### Changes

- Verify `HEAD` against the local peeled tag ref, supporting annotated and lightweight tags.
- Derive and enforce a strict `skills/vendor` destination boundary before deleting staging or vendored files.
- Read the manifest-configured vendor directory; validate catalog source, hash, and allowlisted skill set before opening the transaction.
- Disable removed Superpowers-owned registry rows within the sync transaction.
