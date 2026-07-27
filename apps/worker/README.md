# Worker service

The worker is a separate process with no HTTP listener. Phase 1 implements
the PostgreSQL claim/complete/fail boundary and the `project.validate` job.
Later phases add Claude, Git, GitHub, and notification handlers.

In development and tests, later Claude handlers may copy a
`payload_json.mock_scenario_path` value into the spawned mock CLI's
`MOCK_CLAUDE_SCENARIO` environment. Production builds must ignore that field.
