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
- [x] Confirm local boot path (scripts/dev.ts, DATABASE_URL) and login flow used by tests/e2e/helpers.ts.
- [x] Add `tests/e2e/visual-sweep.spec.ts`: visit every /admin route at widths 1024/1280/1366/1425/1440 in light+dark; assert `document.documentElement.scrollWidth <= window.innerWidth` (automated clipping guard for 4.1); save screenshots for eyeballing.
- [x] Baseline run recorded; known failures listed (7 journey failures on master: auth sign-out, execution retry, planning usage, AI-review race, approve&merge, public intake submission, acknowledge).
- Verify: harness runs; screenshots browsable.

### C1 — Color semantics: separate primary from danger (fixes 3.2)
- [x] design-tokens.css: add `--primary`, `--primary-fg`, `--primary-soft` (light+dark); switch `.button.primary`, link color, `:focus-visible`/outline-color, `.tabs button[aria-selected]`, `.nav-item.active::before`, `.brand-mark`, `.note`, `.public .card` border-top, `.skill-chip` bg, `.status` base bg → primary/neutral (base `.status` becomes muted gray, not pink).
- [x] Replace remaining hardcoded `var(--accent)` inline styles: dashboard "Open triage" button (use `.button.primary`), tickets toolbar active-tab pill, skills checkbox accent, forms/skills/tickets inline accents (grep `var(--accent)` in pages/ui.ts).
- [x] Danger styling untouched (all use `--t-danger` inline already).
- Verify (click-through): dashboard, tickets list+detail, PR detail, settings, forms — light+dark @1366px: primary buttons navy, links navy/blue, Failed-jobs stat & Reject/Cancel still red. visual-sweep green except known 4.1 items.

### C2 — Text containment: global pre wrap + Description card padding (fixes 1.1, 1.2)
- [x] prs.ts:126 Description card → `<div class="card-head">Description</div><div class="card-body">…</div>` like sibling cards.
- [x] design-tokens.css: `pre { white-space:pre-wrap; overflow-wrap:anywhere }` (keeps existing dialog/pre overflow rules); confirm YAML panel, plan raw-markdown, prompts, run task/rendered prompt pres all wrap now.
- Verify: PR detail `/admin/pull-requests/va-hub/87` — Description padded like Metadata; AI Review history long lines wrap (the `ops.product_publish_version…` line fully visible); plan raw markdown tab wraps; light+dark.

### C3 — One status badge everywhere (fixes 3.1)
- [x] shared.ts: export `statusTone(label)` + `statusBadge(label)` using maps: ticket statuses (move/extend board-view statusToneMap), lowercase run/job/delivery states (queued→info, running→run, completed→ok, failed/error/rejected/exhausted→danger, timed_out/cancellation_requested→warn, cancelled/blocked_*→muted), plus Enabled/Disabled, Active/Inactive, Captured/Pending, health_status (healthy→ok, repository_dirty→danger, stale→warn), Placeholder→muted.
- [x] Apply at every tone-less call site (grep list from audit): tickets table/board/detail/PR-panel/run rows, runs list/detail/log statuses, queue rows, ai-usage coverage, notifications deliveries + event rules + provider headers, forms status, projects health (list + operate), operate price Active/Historic.
- [x] Unit test for the tone map (vitest, pure function).
- Verify: tickets list shows red failures / amber review-needed / gray archived at a glance; runs, queue, notifications, forms, projects consistent; light+dark.

### C4 — Human empty states + WhatsApp copy (fixes 2.4, 2.5)
- [x] prs.ts Changed files & validation card: empty → sentence ("No changed files recorded yet."); non-empty → render changed-file count + names list and validation results as list items, not JSON dump.
- [x] Sweep other cards for data-dump/leak patterns (grep JSON.stringify in rendered HTML → only prs.ts hits).
- [x] notifications.ts whatsappCard → "Not yet available" coming-soon panel (what it will do, current state line kept, no dev note).
- Verify: PR detail with empty validation shows sentence identical in style to "No approved plan linked."; Notifications ▸ Event rules ▸ Providers tab reads as product copy.

### C5 — Merge page recovery: retry + timeouts (fixes 2.3)
- [x] ui.ts merge script: extract `loadBranches()`; on project change show "Loading branches…" with built-in timeout (pollJob cap already 20s) → on timeout/failure set dropdowns to an explicit error option ("Couldn't load branches") + enable Retry button next to the status box; Retry re-invokes loadBranches without re-selecting the project.
- [x] Pre-flight timeout/failure gets the same Retry affordance (re-run runPreview()).
- [x] Extend merge-page-wiring.test.ts (DOM stub): timeout path enables retry, retry re-calls preview endpoint, dropdowns leave "Loading…" state.
- Verify: throttle network (or point at unreachable remote) → timeout message + working Retry; normal path unchanged.

### C6 — Create PR action on merge workbench (fixes 1.4)
- [x] worker provider-jobs.ts: add `github.open_pull_request` to providerJobTypes + handler (payload project_id/head/base/title?/body?) calling createPullRequest; refuse when open PR already exists for head (findOpenPullRequestForHead) with clear result outcome `already_open`; audit `project.open_pull_request`.
- [x] server.ts: POST `/api/admin/projects/:id/open-pull-request` mirroring merge-branches validation (ref pattern, head≠base, owner/repo required, idempotency key incl. request token).
- [x] merge.ts + ui.ts wiring: second button `data-create-pr-button` beside Merge; enable logic per Decision 4 (refs exist & differ; conflicts/up-to-date handled: up_to_date disables with reason, conflict allowed with hint "GitHub will flag conflicts"); success → status line with PR link; duplicate → link to existing PR.
- [x] provider-jobs tests for new handler (success, already_open, invalid payload).
- Verify: real pair → PR opens; same pair again → duplicate link; missing base → disabled with reason; Merge behavior unchanged.

### C7 — Projects page: cards → table (fixes 1.3)
- [x] projects.ts list: keep eyebrow/h1/+ Add project toolbar; replace card grid with `section.card` + list-head/row grid (new `projects-head/row` template): Name (linked) · Status (statusBadge health) · Repository (owner/name if set else —) · Local path (mono). Row count ≈ one line each.
- [x] Keep empty-state sentence; mobile stacking via data-label attrs (prs-row pattern).
- Verify: 8 projects visible in ~one screenful @1366px; row click navigates to detail; light+dark; matches Tickets/PRs look.

### C8 — AI usage table header fix + date inputs (fixes 3.5, 3.4)
- [x] ai-usage.ts + CSS: add `aiusage-head/aiusage-row` 8-column grid template (Started, Lifecycle, Model/provider, Tokens, Cost, Ticket/PR, Prompt, Usage status); add data-labels for narrow widths.
- [x] Date filters: text inputs placeholder dd-mm-yyyy (To also accepts empty), tiny submit handler converts to ISO before GET; value echoed back formatted dd-mm-yyyy. Same treatment for settings price form datetime-local → dd-mm-yyyy hh:mm.
- [x] Locale sweep: replace bare `toLocaleString()` with explicit `"nl-NL"` (operate.ts prices table, prs.ts Created/AI-review timestamps) — shared `fmtDateTime`/`fmtDate` helpers in shared.ts.
- [x] Pre-existing 500: untyped `timestamptz < interval` param in the To-filter fixed (`::timestamptz` cast).
- Verify: headers read as eight columns; date fields show dd-mm-yyyy regardless of browser locale (test with en-US locale browser); filtering round-trips correctly through URL.

### C9 — Tickets: archive out of danger zone + approval-gates explanation (fixes 3.3, 4.3)
- [x] Remove Archive from Danger Zone card; add neutral secondary "Archive" button to toolbar next to Reopen (same terminal-status enable logic + title reason; stays visible-but-disabled elsewhere, matching its prior behavior). Danger zone keeps Reject/Cancel red.
- [x] approvalGatesCard(): add one-line explanation, e.g. "Intake gate: acknowledging moves this Submitted ticket into triage. It unlocks once the ticket is submitted." (visible explanation, not just title attr).
- Verify: ticket detail — Archive neutral & outside red group; Acknowledge disabled state self-explains; actions still hit same endpoints.

### C10 — Dashboard heights + responsive clipping (fixes 3.6, 4.1)
- [x] Heights: four-card grid gets `align-items:start` so short cards (Blocked) stop stretching; keep inner max-height scroll lists.
- [x] Clipping: visual-sweep offender walk (PR list scrollWidth 1117 at 1024 viewport); fix pattern applied: `min-width:0` on grid/list cells, `.status` max-width:100% wrap, dashboard run-row meta wraps instead of nowrap, `.card` min-width:0.
- [x] Sweep at 1024/1280/1366/1425/1440 green on all routes; tablet 768 spot-checked (hamburger path, no overflow).
- Verify: Open triage visible at 1366px; sweep assertion green everywhere.

### C11 — Shell: Public form scoping + sidebar footer (fixes 4.2, 4.4)
- [x] ui.ts adminPage: render "Public form" link only when path startsWith `/admin/forms`.
- [x] Sidebar footer: verified already pinned outside the scrolling `.nav` (fixed flex-column sidebar) at 1280×600 — no change needed, evidence screenshot recorded.
- Verify: Audit log/settings have no mystery button; Forms page keeps it; footer reachable at 768×600 viewport.

### C12 — Consistency sweep + regression
- [x] Clickable-affordance audit (2.2): Runs/PRs/Skills/Prompts/Forms lists are anchors; Queue jobs intentionally not links (no detail page) and carry no link styling; audit log rows have no bold pseudo-titles.
- [x] Spacing audit: /admin/system read-only field cards rendered flush — wrapped in card-body (same bug class as the PR Description card).
- [x] Remaining `var(--accent)` grep = zero outside tokens block (except public-facing pages if intentionally branded).
- [x] Full `pnpm verify` (tsc + vitest, 706 pass) + visual-sweep + full journey suite on a fresh hermetic stack: 24/28 pass; remaining 4 failures are the pre-existing master failures (auth sign-out, execution retry, planning usage capture, approve&merge) — out of UI scope. Fixed along the way: public-intake submission 500 (untyped $4 param, 42P18 — same class as ai-usage 500) and the AI-review spec's reload race.

## Risks / notes

- C1 changes link + focus colors app-wide — highest blast radius, do early so every later commit is reviewed in the new palette.
- C6 touches worker + API + UI; keep behind the same job/audit conventions as merge_branches; no DB migration needed (jobs are generic).
- 4.1 root cause not yet proven — C10 includes the diagnostic step before fixing; don't guess-fix.
- E2E specs may assert current strings/colors (e.g., tabs, badges); update alongside each commit, not in a bulk fixup.
- Live environment runs via webhook deploy (deploy.sh) — execution session should confirm where to verify (local dev vs staging) before click-throughs.
