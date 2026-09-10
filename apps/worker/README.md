# Worker service

The worker is a separate process with no HTTP listener. It implements the
PostgreSQL claim/complete/fail boundary, project validation, planning, plan
revision, execution, and repair jobs. Claude authentication is checked at
startup and again before a Claude job is claimed. Planning uses plan mode
with read-only tools. Execution uses a ticket-specific Git worktree, streams
events to PostgreSQL, writes a raw run log under `data/logs`, and stops at
the independent-validation handoff.

In development and tests, later Claude handlers may copy a
`payload_json.mock_scenario_path` value into the spawned mock CLI's
`MOCK_CLAUDE_SCENARIO` environment. Production builds must ignore that field.
Planning and execution jobs use this mechanism; the runner reads the payload
key only outside production.

Jam ticket evidence imports require `DCC_JAM_TOKEN` in the worker environment
only. Use a workspace-scoped Jam PAT with `mcp:read`; do not expose it to the
web process. `DCC_JAM_TEST_ENDPOINT` is accepted only outside production and
only for a loopback HTTP endpoint used by the isolated test harness.

The adapter and mock-provider tests are offline. Before enabling Jam imports
in production, run `pnpm --filter worker exec tsx src/jam-contract.ts` with
`DCC_JAM_TOKEN` and `DCC_JAM_SAMPLE_URL` set, and record the live schemas and
available sections. No authenticated live Jam probe was run for this change.
