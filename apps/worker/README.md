# Worker service

The worker is a separate process with no HTTP listener. It implements the
PostgreSQL claim/complete/fail boundary, `project.validate`, and the Phase 5
`planning.generate` flow. Claude authentication is checked at startup and
again before a planning job is claimed. Planning uses the isolated
`@dcc/claude-runner` adapter with plan mode and read-only tools.

In development and tests, later Claude handlers may copy a
`payload_json.mock_scenario_path` value into the spawned mock CLI's
`MOCK_CLAUDE_SCENARIO` environment. Production builds must ignore that field.
Phase 5 uses this mechanism for planning jobs; the worker reads the payload
key only outside production.
