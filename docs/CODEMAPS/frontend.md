<!-- Generated: 2026-08-02 | Files scanned: 2 -->

# Frontend Pages — Server-Side Rendered UI

## Pattern Overview
- Files in `apps/web/src/pages/` export an async `render(url, session, metrics)` function
- Returns `{ status, title, body }` where body is HTML string
- No client-side framework; HTML with data attributes for JS enhancement

## PR Table (prs.ts)
- **Route**: `/admin/pull-requests` (list view), `/admin/pull-requests/{projectSlug}/{number}` (detail)
- **Current list columns** (line 182): PR | Title | Ticket | Checks | Review | Changes | Project | Conflicts | Created
- **Row class**: `ticket-row prs-row` 
- **Header class**: `list-head prs-head`
- **Row rendering** (line 153-157): Template string with `<a class="ticket-row">` containing `<span>` for each column
- **Data source** (line 143-149): SQL query joins projects, tickets; filters by search, status tab, repository
- **AI review** currently only in detail page (lines 188, 195 fetch from pr_ai_reviews)

## Ticket Table (tickets.ts reference)
- **Route**: `/admin/tickets` (table view at line 140)
- **Columns** (line 167): Ticket | Title | Project | Priority | AI config | Status | Updated
- **Row class**: `ticket-row tickets7`
- **Header class**: `list-head tickets7`
- **Row rendering** (line 140): Similar template string structure
- **Date format**: `new Date(ticket.updated_at).toLocaleDateString("nl-NL")`
- **Status styling**: `<span class="status">${status}</span>` with color classes

## Key Utilities (shared.ts)
- `escapeHtml(str)` — Sanitizes HTML strings
- `pool` — PostgreSQL connection pool
- `renderMarkdown(str)` — Converts markdown to HTML
