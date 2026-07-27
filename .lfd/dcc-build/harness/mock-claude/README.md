# Mock Claude CLI

A fake `claude` CLI executable for testing worker services that invoke the real Claude Code CLI as a subprocess. Prevents real Anthropic API/CLI calls during tests.

## Setup

Add to `$PATH`:
```bash
export PATH="/home/dutchbase/projects/dev-control-center/.worktrees/dcc-build/.lfd/dcc-build/harness/mock-claude:$PATH"
```

## Environment Variables

### `MOCK_CLAUDE_LOG` (optional)
Path to a file where invocations are logged. Each call appends one JSON line:
```json
{
  "timestamp": "2026-07-27T12:34:56.789Z",
  "argv": ["-p", "task", "--session-id", "s1"],
  "cwd": "/home/user/project",
  "env_snapshot": {"CLAUDE_CODE_OAUTH_TOKEN": true},
  "parsed": {"model": "opus", "effort": "high", ...}
}
```

### `MOCK_CLAUDE_SCENARIO` (optional)
Path to a JSON file describing what this invocation returns. If unset, defaults to a valid plan scenario.

#### Scenario JSON Shape
```json
{
  "mode": "plan_valid" | "plan_invalid" | "timeout" | "exec_stream" | "invalid_model_combo",
  "plan_markdown": "string (plan_valid mode)",
  "invalid_plan_text": "string (plan_invalid mode)",
  "events": [{...}, ...],
  "timeout_after_events": 2,
  "session_id_expected": "optional string",
  "exit_code": 0
}
```

#### Mode Examples

**plan_valid** (default):
```json
{
  "mode": "plan_valid",
  "plan_markdown": "# Implementation Plan\n\n## 1. Summary\n\nDo X."
}
```

**plan_invalid**:
```json
{
  "mode": "plan_invalid",
  "invalid_plan_text": "Not a valid plan"
}
```

**timeout** (prints first 2 events, exits 124):
```json
{
  "mode": "timeout",
  "events": [
    {"type": "turn", "turn_index": 0},
    {"type": "tool_use", "tool": "read"}
  ],
  "timeout_after_events": 2
}
```

**exec_stream** (relays all events):
```json
{
  "mode": "exec_stream",
  "events": [
    {"type": "event1"},
    {"type": "event2"}
  ],
  "exit_code": 0
}
```

**invalid_model_combo**:
```json
{
  "mode": "invalid_model_combo"
}
```

## Forbidden Environment Variables

If ANY of these are set to a non-empty value, the mock exits 1 and prints an error (even for `auth status`):
- `ANTHROPIC_API_KEY`
- `ANTHROPIC_AUTH_TOKEN`
- `CLAUDE_CODE_USE_BEDROCK`
- `CLAUDE_CODE_USE_VERTEX`
- `CLAUDE_CODE_USE_FOUNDRY`

This mirrors the real CLI's precedence check: API-key/gateway auth is refused if subscription auth should be used.

## Subcommands

### `claude auth status`
Returns `{"authenticated": true, "method": "subscription", "account": "mock-operator"}` if `CLAUDE_CODE_OAUTH_TOKEN` is set, otherwise `{"authenticated": false, "method": null}` and exits 1.

### Main Invocation
```
claude -p "<task>" --session-id ID --model MODEL --effort EFFORT --output-format json|stream-json [flags...]
```

Supported flags: `--session-id`, `--model`, `--effort`, `--permission-mode`, `--tools`, `--append-system-prompt-file`, `--add-dir`, `--output-format`, `--max-turns`, `--verbose`.

Returns scenario-based output (see Scenario JSON Shape above).
