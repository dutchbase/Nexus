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
