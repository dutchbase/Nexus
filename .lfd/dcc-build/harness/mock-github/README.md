# Mock GitHub Server

A minimal in-memory HTTP mock of GitHub's REST API for testing PR-creation code in CI/eval harnesses, without touching real GitHub.

## Quick Start

```bash
MOCK_GITHUB_PORT=8991 node server.js
```

The server listens on `127.0.0.1:8991` (localhost only, no external network).

## Base URL

Point your GitHub client to `http://127.0.0.1:8991` in test setup:

```javascript
const github = new GitHubClient({ baseUrl: 'http://127.0.0.1:8991' });
```

## Production Routes

| Method | Path | Behavior |
|--------|------|----------|
| POST | `/repos/:owner/:repo/pulls` | Create a PR; responds 201 with PR object. Counter auto-increments per repo. |
| GET | `/repos/:owner/:repo/pulls` | List PRs; optional query: `state` (open\|closed\|all, default open), `head` (branch name). |
| GET | `/repos/:owner/:repo/pulls/:number` | Fetch a PR; responds 200 or 404. |
| PATCH | `/repos/:owner/:repo/pulls/:number` | Update title, body, or state; bumps `updated_at`. Responds 200 or 404. |
| PUT | `/repos/:owner/:repo/pulls/:number/merge` | **ALWAYS responds 403** with a message that no automatic merge is allowed. By design—merging is human-only on real GitHub. |

## Test-Control Routes

Prefix `/_control/` for test setup/teardown and event simulation.

| Method | Path | Behavior |
|--------|------|----------|
| POST | `/_control/repos/:owner/:repo/pulls/:number/merge` | Simulate a successful merge; sets state to closed, merged=true, merged_at, merge_commit_sha. Responds 200 or 404. |
| POST | `/_control/repos/:owner/:repo/pulls/:number/close` | Close a PR unmerged; sets state to closed, merged=false, closed_at. Responds 200 or 404. |
| POST | `/_control/repos/:owner/:repo/pulls/:number/review` | Simulate a review; body `{"state": "approved"\|"changes_requested"\|"commented"}`. Responds 200 or 404. |
| POST | `/_control/repos/:owner/:repo/pulls/:number/checks` | Simulate CI checks; body `{"state": "success"\|"failure"\|"pending"}`. Responds 200 or 404. |
| POST | `/_control/reset` | Clear all in-memory state (all repos, all PRs, all counters). Responds 200 `{"ok": true}`. Call between test cases for isolation. |
| GET | `/_control/dump` | Return full in-memory state as JSON for test assertions. Responds 200 with object `{owner/repo: [pr, pr, ...], ...}`. |

## Environment Variables

- `MOCK_GITHUB_PORT` — port to listen on (default 8991)
- `MOCK_GITHUB_LOG` — optional file path; if set, each request is logged as one JSON line for post-hoc test assertions

## Important Notes

- **Localhost-only**: Binds to `127.0.0.1`, never `0.0.0.0`. Suitable for local testing only.
- **In-memory only**: State is lost on restart. Call `/_control/reset` between test runs for clean isolation.
- **PUT /merge always 403**: The real `/merge` endpoint (PUT) always returns 403 to catch code that tries to auto-merge. Use `POST /_control/merge` in tests to simulate merges.
- **No npm dependencies**: Uses Node.js built-ins only (`http`, `url`, `crypto`).
