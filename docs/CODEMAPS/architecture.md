<!-- Generated: 2026-08-02 | Files scanned: 12 -->

# Project Architecture — Development Control Center

## Overview
TypeScript monorepo for a development control center with web UI and worker processes. Manages pull requests, tickets, execution attempts, and AI reviews.

## Key Directories
- `apps/web/src/pages/` — Server-side rendered HTML pages for admin UI
  - `prs.ts` — Pull request listing and detail pages
  - `tickets.ts` — Ticket management (table and board views)
  - `shared.ts` — Utilities: escapeHtml, pool, renderMarkdown
  
- `apps/worker/` — Background job processing

## Database Tables (Relevant)
- `pull_requests` — PR metadata (number, title, state, merged_at, is_draft, etc.)
- `pr_ai_reviews` — AI review verdicts (id, pull_request_id, status, created_at)
- `projects` — Project metadata (id, name, slug)
- `tickets` — Ticket metadata (number, title, status, priority, etc.)

## Rendering Pattern
- Server-side rendered HTML via Deno + PostgreSQL
- Template strings with escapeHtml for XSS prevention
- CSS classes for styling (prs-row, tickets7, status badges)
- Data attributes for JavaScript interactivity (data-pr-approve, etc.)

## Test Framework
- Vitest (detected from package.json)
- Command: `npx vitest run [test-file]`
