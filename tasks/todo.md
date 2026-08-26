# UI/UX Remediation — Dev Control admin (planning output)

Scope: all findings from the live /admin audit. Session = planning only; execution follows this file top-to-bottom, one commit per phase, click-through verification after each.

## Orientation (facts that determine every fix)

- No framework: pages are HTML template strings in `apps/web/src/pages/*.ts`, shell + inline client JS in `apps/web/src/ui.ts`, single stylesheet `apps/web/src/design-tokens.css`.
- Cards: `.card { overflow:hidden }` + `.card-head` / `.card-body` (18px padding). Any card content that skips `.card-body` renders flush (root of 1.1).
- `<pre>` has no global wrap rule → inside `.card{overflow:hidden}` long lines are clipped with no scrollbar (root of 1.2).
- `.status` base class = pale pink (`--accent-soft`); tone classes `.ok/.warn/.danger/.info/.run/.muted` exist but most pages omit them (root of 3.1). PR page already does tone mapping correctly — copy that pattern.
- `--accent:#C8102E` (red) drives primary buttons, links, focus ring, tabs underline, nav-active marker, brand mark (root of 3.2).
- List grids: `.list-head`/`.ticket-row` share per-page grid-template overrides (`runs-head`, `prs-head`, …). AI usage has 8 cells but uses the default 6-column template → last two headers wrap under the first two (root of 3.5 — it's a column-count mismatch, not intentional stacked labels).
- Merge page client JS lives in `ui.ts` under `path==="/admin/merge"`; pre-flight = enqueue `github.merge_preview` job + pollJob(20s). Timeout message has no retry; branch selects stay "Loading…" forever (2.3).
- GitHub PR creation already exists as a provider function (`createPullRequest` in packages/github-provider) and is used by the execution pipeline; there is no standalone "open PR" worker job yet (needed for 1.4).
- Worker provider jobs: registry array + handler chain in `apps/worker/src/provider-jobs.ts`; API endpoints enqueue via `enqueueJob` in server.ts (`github.merge_branches` endpoint is the template).

## Design decisions (defaults chosen; reversible)

1. **Primary color**: new tokens `--primary` / `--primary-fg`. Light: navy `#23508F` (existing info blue family), dark: lighter navy (pick ~`#5B8AD9`, verify ≥4.5:1 with white text during implementation). Red stays only as `--t-danger` / danger styling. Brand mark becomes neutral (raised chip, primary letter) since red-as-brand is part of the overload.
2. **Status scale**: green ok / red danger / amber warn / blue info / purple run / gray muted — reuse existing tone classes; add shared `statusBadge(label)` helper in `pages/shared.ts` with explicit maps for ticket statuses (extend the map already in tickets.ts board view), run statuses, job statuses, delivery/event/form/project states. Default = muted.
3. **Dates**: display standard dd-mm-yyyy via explicit `"nl-NL"` everywhere; UI copy stays English. Native `<input type="date">`/`datetime-local` replaced by text inputs with `placeholder="dd-mm-yyyy"` (+ `dd-mm-yyyy hh:mm` where time needed) parsed on submit to ISO; URL params stay ISO.
4. **Create PR precondition** (= what the code says the integration allows): enabled when head/base selected, distinct, and pre-flight confirmed both refs exist (`outcome !== missing_head/missing_base`). NOT gated on clean merge, reviews, or checks — opening a PR is non-destructive and GitHub itself flags conflicts. If an open PR already exists for head (`findOpenPullRequestForHead`), show link instead of creating a duplicate.
5. **WhatsApp panel**: proper coming-soon empty state (lazy option; full config form later if WhatsApp goes live).
6. **Public form button**: rendered only on `/admin/forms*` pages.
7. **Empty states**: short English sentence, never raw JSON / implementation notes.
8. **Danger zone**: Reject + Cancel stay red; Archive moves out as a neutral secondary action (toolbar next to Reopen, same enable logic).

## Phases → commits

### C0 — Visual verification harness (prerequisite)
- [ ] Confirm local boot path (scripts/dev.ts, DATABASE_URL) and login flow used by tests/e2e/helpers.ts.
- [ ] Add `tests/e2e/visual-sweep.spec.ts`: visit every /admin route at widths 1024/1280/1366/1425/1440 in light+dark; assert `document.documentElement.scrollWidth <= window.innerWidth` (automated clipping guard for 4.1); save screenshots for eyeballing.
- [ ] Baseline run recorded; known failures listed (expected: dashboard clipping at ≤1425px).
- Verify: harness runs; screenshots browsable.

### C1 — Color semantics: separate primary from danger (fixes 3.2)
- [ ] design-tokens.css: add `--primary`, `--primary-fg`, `--primary-soft` (light+dark); switch `.button.primary`, link color, `:focus-visible`/outline-color, `.tabs button[aria-selected]`, `.nav-item.active::before`, `.brand-mark`, `.note`, `.public .card` border-top, `.skill-chip` bg, `.status` base bg → primary/neutral (base `.status` becomes muted gray, not pink).
- [ ] Replace remaining hardcoded `var(--accent)` inline styles: dashboard "Open triage" button (use `.button.primary`), tickets toolbar active-tab pill, skills checkbox accent, forms/skills/tickets inline accents (grep `var(--accent)` in pages/ui.ts).
- [ ] Danger styling untouched (all use `--t-danger` inline already).
- Verify (click-through): dashboard, tickets list+detail, PR detail, settings, forms — light+dark @1366px: primary buttons navy, links navy/blue, Failed-jobs stat & Reject/Cancel still red. visual-sweep green except known 4.1 items.

### C2 — Text containment: global pre wrap + Description card padding (fixes 1.1, 1.2)
- [ ] prs.ts:126 Description card → `<div class="card-head">Description</div><div class="card-body">…</div>` like sibling cards.
- [ ] design-tokens.css: `pre { white-space:pre-wrap; overflow-wrap:anywhere }` (keeps existing dialog/pre overflow rules); confirm YAML panel, plan raw-markdown, prompts, run task/rendered prompt pres all wrap now.
- Verify: PR detail `/admin/pull-requests/va-hub/87` — Description padded like Metadata; AI Review history long lines wrap (the `ops.product_publish_version…` line fully visible); plan raw markdown tab wraps; light+dark.

### C3 — One status badge everywhere (fixes 3.1)
- [ ] shared.ts: export `statusTone(label)` + `statusBadge(label)` using maps: ticket statuses (move/extend board-view statusToneMap), lowercase run/job/delivery states (queued→info, running→run, completed→ok, failed/error/rejected/exhausted→danger, timed_out/cancellation_requested→warn, cancelled/blocked_*→muted), plus Enabled/Disabled, Active/Inactive, Captured/Pending, health_status (healthy→ok, repository_dirty→danger, stale→warn), Placeholder→muted.
- [ ] Apply at every tone-less call site (grep list from audit): tickets table/board/detail/PR-panel/run rows, runs list/detail/log statuses, queue rows, ai-usage coverage, notifications deliveries + event rules + provider headers, forms status, projects health (list + operate), operate price Active/Historic.
- [ ] Unit test for the tone map (vitest, pure function).
- Verify: tickets list shows red failures / amber review-needed / gray archived at a glance; runs, queue, notifications, forms, projects consistent; light+dark.

### C4 — Human empty states + WhatsApp copy (fixes 2.4, 2.5)
- [ ] prs.ts Changed files & validation card: empty → sentence ("No changed files recorded yet."); non-empty → render changed-file count + names list and validation results as list items, not JSON dump.
- [ ] Sweep other cards for data-dump/leak patterns (grep JSON.stringify in rendered HTML → only prs.ts hits).
- [ ] notifications.ts whatsappCard → "Not yet available" coming-soon panel (what it will do, current state line kept, no dev note).
- Verify: PR detail with empty validation shows sentence identical in style to "No approved plan linked."; Notifications ▸ Event rules ▸ Providers tab reads as product copy.

### C5 — Merge page recovery: retry + timeouts (fixes 2.3)
- [ ] ui.ts merge script: extract `loadBranches()`; on project change show "Loading branches…" with built-in timeout (pollJob cap already 20s) → on timeout/failure set dropdowns to an explicit error option ("Couldn't load branches") + enable Retry button next to the status box; Retry re-invokes loadBranches without re-selecting the project.
- [ ] Pre-flight timeout/failure gets the same Retry affordance (re-run runPreview()).
- [ ] Extend merge-page-wiring.test.ts (DOM stub): timeout path enables retry, retry re-calls preview endpoint, dropdowns leave "Loading…" state.
- Verify: throttle network (or point at unreachable remote) → timeout message + working Retry; normal path unchanged.

### C6 — Create PR action on merge workbench (fixes 1.4)
- [ ] worker provider-jobs.ts: add `github.open_pull_request` to providerJobTypes + handler (payload project_id/head/base/title?/body?) calling createPullRequest; refuse when open PR already exists for head (findOpenPullRequestForHead) with clear result outcome `already_open`; audit `project.open_pull_request`.
- [ ] server.ts: POST `/api/admin/projects/:id/open-pull-request` mirroring merge-branches validation (ref pattern, head≠base, owner/repo required, idempotency key incl. request token).
- [ ] merge.ts + ui.ts wiring: second button `data-create-pr-button` beside Merge; enable logic per Decision 4 (refs exist & differ; conflicts/up-to-date handled: up_to_date disables with reason, conflict allowed with hint "GitHub will flag conflicts"); success → status line with PR link; duplicate → link to existing PR.
- [ ] provider-jobs tests for new handler (success, already_open, invalid payload).
- Verify: real pair → PR opens; same pair again → duplicate link; missing base → disabled with reason; Merge behavior unchanged.

### C7 — Projects page: cards → table (fixes 1.3)
- [ ] projects.ts list: keep eyebrow/h1/+ Add project toolbar; replace card grid with `section.card` + list-head/row grid (new `projects-head/row` template): Name (linked) · Status (statusBadge health) · Repository (owner/name if set else —) · Local path (mono). Row count ≈ one line each.
- [ ] Keep empty-state sentence; mobile stacking via data-label attrs (prs-row pattern).
- Verify: 8 projects visible in ~one screenful @1366px; row click navigates to detail; light+dark; matches Tickets/PRs look.

### C8 — AI usage table header fix + date inputs (fixes 3.5, 3.4)
- [ ] ai-usage.ts + CSS: add `aiusage-head/aiusage-row` 8-column grid template (Started, Lifecycle, Model/provider, Tokens, Cost, Ticket/PR, Prompt, Usage status); add data-labels for narrow widths.
- [ ] Date filters: text inputs placeholder dd-mm-yyyy (To also accepts empty), tiny submit handler converts to ISO before GET; value echoed back formatted dd-mm-yyyy. Same treatment for settings price form datetime-local → dd-mm-yyyy hh:mm.
- [ ] Locale sweep: replace bare `toLocaleString()` with explicit `"nl-NL"` (operate.ts prices table, prs.ts Created/AI-review timestamps) — shared `fmtDateTime`/`fmtDate` helpers in shared.ts.
- Verify: headers read as eight columns; date fields show dd-mm-yyyy regardless of browser locale (test with en-US locale browser); filtering round-trips correctly through URL.

### C9 — Tickets: archive out of danger zone + approval-gates explanation (fixes 3.3, 4.3)
- [ ] Remove Archive from Danger Zone card; add neutral secondary "Archive" button to toolbar next to Reopen (same terminal-status enable logic + title reason). Danger zone keeps Reject/Cancel red.
- [ ] approvalGatesCard(): add one-line explanation, e.g. "Intake gate: acknowledging moves this Submitted ticket into triage. It unlocks once the ticket is submitted." (visible explanation, not just title attr).
- Verify: ticket detail — Archive neutral & outside red group; Acknowledge disabled state self-explains; actions still hit same endpoints.

### C10 — Dashboard heights + responsive clipping (fixes 3.6, 4.1)
- [ ] Heights: four-card grid gets `align-items:start` so short cards (Blocked) stop stretching; keep inner max-height scroll lists.
- [ ] Clipping: run visual-sweep; walk DOM for elements wider than viewport (scrollWidth offender report); expected culprits: grid children with `min-width:auto` + nowrap mono rows (dashboard runRow meta, similar elsewhere). Fix pattern: `min-width:0` on grid/flex children (.card in grids, .ticket-row spans) + drop nowrap on wrappable long meta lines.
- [ ] Re-run sweep at 1024/1280/1366/1425/1440 until zero horizontal overflow on all routes; spot-check tablet 768 (hamburger nav path).
- Verify: Open triage visible at 1366px; sweep assertion green everywhere.

### C11 — Shell: Public form scoping + sidebar footer (fixes 4.2, 4.4)
- [ ] ui.ts adminPage: render "Public form" link only when path startsWith `/admin/forms`.
- [ ] Sidebar footer: verify claim first (footer is outside scrolling `.nav`, sidebar is fixed flex-column — may already be pinned). If confirmed fine: no change, record evidence screenshot. If it can collapse/scroll on short viewports: give footer `flex-shrink:0` / sticky placement and slightly more breathing room.
- Verify: Audit log/settings have no mystery button; Forms page keeps it; footer reachable at 768×600 viewport.

### C12 — Consistency sweep + regression
- [ ] Clickable-affordance audit (2.2): Runs/Queue/PRs/Skills/Prompts/Forms lists — rows with detail pages must be anchors (skills/prompts/forms already are), bold-title-without-link cases fixed or de-styled; Queue jobs intentionally not links (no detail page) — ensure they don't look like links.
- [ ] Spacing audit: any other component rendering content without `.card-body` wrapper (grep sections with direct children besides card-head).
- [ ] Remaining `var(--accent)` grep = zero outside tokens block (except public-facing pages if intentionally branded).
- [ ] Full `pnpm verify` (tsc + vitest) + visual-sweep + manual pass over all 15 routes × light/dark × 1366/1024.

## Risks / notes

- C1 changes link + focus colors app-wide — highest blast radius, do early so every later commit is reviewed in the new palette.
- C6 touches worker + API + UI; keep behind the same job/audit conventions as merge_branches; no DB migration needed (jobs are generic).
- 4.1 root cause not yet proven — C10 includes the diagnostic step before fixing; don't guess-fix.
- E2E specs may assert current strings/colors (e.g., tabs, badges); update alongside each commit, not in a bulk fixup.
- Live environment runs via webhook deploy (deploy.sh) — execution session should confirm where to verify (local dev vs staging) before click-throughs.
