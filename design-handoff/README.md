# Handoff: Internet Nederland Development hub

Frontend for the **Development Control Center** PRD v1.0 — a self-hosted platform that collects
development feedback, turns it into tickets, generates implementation plans with Claude Code,
executes approved plans in isolated Git worktrees and centrally reviews the resulting pull requests.

---

## 1. About the design files

The files in this bundle are **design references created in HTML**. They are a prototype of the
intended look, structure and behaviour — **not production code to copy**.

Your task is to **recreate these designs in the target codebase's own environment** (Next.js /
Remix / plain React / whatever the repo already uses) with its established patterns, component
library, routing and data layer. If no frontend environment exists yet, pick the framework that best
fits the backend described in the PRD (a React meta-framework with server-side rendering is the
natural fit for a Postgres-backed admin tool) and implement the designs there.

Do not ship the `.dc.html` file. Do not port its runtime.

### What the file actually is

| File | What it is |
| --- | --- |
| `Development Control Center.dc.html` | The prototype. A single self-contained page: markup + a plain-JS logic class holding all mock data and screen state. |
| `support.js` | The prototype runtime that renders the file. Ignore it; it has no production role. |

Open the `.dc.html` in a browser to click through every screen. Everything is inline-styled — the
computed values in the file are authoritative when this document and the file disagree on a number.

### How to read the prototype's source

* All content lives in the markup between `<x-dc>` and `</x-dc>`.
* All mock data and interaction state lives in the `class Component extends DCLogic { … }` block:
  `projects`, `tickets`, `skills`, `prs`, `runs`, `jobs`, `forms`, `deliveries`, `audits`,
  `promptFiles`.
* `{{ path }}` are value holes, `<sc-for list=…>` is a loop, `<sc-if value=…>` is a conditional.
  Translate these to whatever your framework uses.
* Theme is a `data-theme="light|dark"` attribute on `<html>` plus a CSS-variable block. **This part
  is directly reusable** — see §7.

---

## 2. Fidelity

**High fidelity.** Colours, typography, spacing, radii, states and copy are final. Recreate the UI
faithfully using the codebase's existing primitives. Where the target codebase already has a Button
or Table primitive, use it and restyle to these tokens rather than rebuilding from scratch.

Two deliberate simplifications in the prototype that you must replace with real implementations:

1. All data is hardcoded mock data. Wire to the API routes in PRD §29.
2. "Live" runs are a static snapshot. Real runs stream `stream-json` events from the worker — see §6.

---

## 3. Information architecture

Routes follow PRD §25 exactly. The prototype implements every one of them.

```
/login
/f/{slug}                                   public intake form (no chrome, no auth)
/f/{slug}/submitted                         confirmation with ticket reference

/admin                                      dashboard
/admin/tickets                              list — table + board view
/admin/tickets/{ticketId}                   detail — 8 tabs
/admin/tickets/{ticketId}/plans/{version}   plan review
/admin/runs                                 run list
/admin/runs/{runId}                         run detail — events / prompt / diff
/admin/queue                                job queue
/admin/pull-requests                        central PR dashboard
/admin/pull-requests/{projectId}/{number}   PR detail
/admin/projects                             project cards
/admin/projects/{projectId}                 project detail — 5 tabs
/admin/forms                                form cards
/admin/forms/{formId}                       form builder — fields / settings / preview
/admin/prompts                              prompt editor (two-pane)
/admin/skills                               skill registry
/admin/skills/{skillId}                     skill reference detail
/admin/notifications                        rules / providers / templates / deliveries
/admin/audit                                audit log
/admin/settings                             general / auth / claude / github / retention
/admin/system                               system health
```

The prototype keeps the current route in a single `screen` string plus id fields
(`ticketId`, `runId`, `prNum`, `projectSlug`, `formSlug`, `promptId`, `skillSlug`). In production use
real URLs — deep-linkability matters for the notification `dashboardUrl` payload (PRD §23.4).

---

## 4. Application shell

```
┌────────────┬──────────────────────────────────────────┐
│ sidebar    │ header  64px, sticky, z-index 40         │
│ 246px      ├──────────────────────────────────────────┤
│ fixed      │ main                                     │
│            │   max-width 1480px, centred              │
│            │   padding 26px clamp(18px,2.6vw,34px) 72px│
└────────────┴──────────────────────────────────────────┘
```

### Sidebar — `width: 246px; flex: 0 0 246px`

* Background `var(--side-bg)`, right border `1px solid var(--side-border)`.
* **Brand block**, height 64px, padding `0 20px`, bottom border `1px solid var(--side-border)`,
  `display:flex; align-items:center; gap:11px`:
  * 26×26 square, `background: var(--accent)`, `border-radius: 3px`, containing the letter **D** in
    Cormorant Garamond 700 / 17px / `#fff`.
  * Title **Development hub** — Cormorant Garamond 700, 18px, `#fff`, `line-height:1.1`,
    `letter-spacing:-.2px`.
  * Subtitle **INTERNET NEDERLAND** — 9px, weight 700, `letter-spacing:.2em`, uppercase,
    `var(--side-sub)`, ellipsised.
* **Nav**, `flex:1; overflow-y:auto; padding:14px 12px 8px; display:flex; flex-direction:column; gap:16px`.
  Four groups, each a `gap:1px` column with a 9px/700/`.2em` uppercase `var(--side-sub)` label,
  padding `0 10px 7px`:

  | Group | Items (badge) |
  | --- | --- |
  | Overview | Dashboard |
  | Work | Tickets (14) · Runs (2) · Queue (4) · Pull requests (5) |
  | Configure | Projects (4) · Forms (4) · Prompts · Skills (13) |
  | Operate | Notifications (1) · Audit log · Settings · System |

  Badges are live counts, not decoration: open tickets, active runs, queued+running jobs, open PRs,
  registered skills, failed notification deliveries.

* **Nav item** — full-width button, `padding:8px 10px`, `border-radius:4px`, font 13.5px,
  `display:flex; align-items:center; gap:10px`. Leading 3×15px rounded bar: `var(--accent)` when
  active, transparent otherwise. Trailing pill badge, 10.5px/700, `border-radius:99px`, padding
  `1px 6px`, tabular numerals.
  * default: `color: var(--side-text)`, weight 400, transparent background
  * active: `color: var(--side-active)`, weight 600, `background: var(--side-hover)`
  * hover: `background: var(--side-hover); color: var(--side-active)`
  * An item stays active on its own detail routes (`/admin/tickets/*` keeps **Tickets** lit).

* **Footer**, top border, `padding:12px`, `gap:10px`:
  * Theme segmented control — three equal buttons **Light / Auto / Dark** in a
    `background: rgba(255,255,255,.06)` track, `border-radius:4px`, `padding:2px`, `gap:2px`.
    Selected: `background: rgba(255,255,255,.14)`, `color:#fff`. Others `var(--side-sub)`. 11px/600.
  * User row: 28×28 `rgba(255,255,255,.1)` initials tile (radius 3px, 11px/700), username 12.5px,
    role 10px `var(--side-sub)`, and an **Exit** text button 11px.

### Header — 64px

`position: sticky; top:0; background: var(--surface); border-bottom: 1px solid var(--border);
display:flex; align-items:center; gap:12px; padding: 0 clamp(14px,2.4vw,26px)`.

* Left (mobile only): 36×36 hamburger, `1px solid var(--border)`, radius 4px, three 15×1.5px bars, gap 3.5px.
* Breadcrumb: section label 10px/700/`.2em` uppercase `var(--text3)`, a `/` separator, then the leaf
  in 13px `var(--text2)`, ellipsised.
* Right: worker pill — `padding:5px 10px`, `border:1px solid var(--border)`, `border-radius:99px`,
  a 6px `var(--t-ok)` dot animating `dccPulse 2.4s ease-in-out infinite`, label `worker-01 healthy`
  (shortens to `OK` on mobile). Then a **Public form** secondary button.

### Login and public form

Rendered without sidebar or header — full-bleed inside `main`.

---

## 5. Screens

Shared page-header pattern used by every list screen:

```
eyebrow   ── 22×1px var(--accent) rule + 10px/700/.2em uppercase var(--text3) label
title     ── Cormorant Garamond 700, clamp(30px,4.2vw,42px), letter-spacing -1px, line-height 1.05
actions   ── right-aligned button row, flex-wrap
```

Shared card/section pattern:

```
background: var(--surface); border: 1px solid var(--border); border-radius: 6px; overflow: hidden

  header  padding 13px 18px, bottom border, flex row:
          16×1px var(--accent) rule + 11.5px/700/.14em uppercase var(--text2) heading
  body    padding 18px
```

### 5.1 Login

Two-column card, `max-width:920px`, `grid-template-columns: repeat(auto-fit, minmax(320px,1fr))`,
`border-radius:8px`, `box-shadow: var(--shadow)`.

* Left panel `background: var(--side-bg)`, padding `clamp(28px,4vw,46px)`, `min-height:420px`,
  space-between. Brand mark + eyebrow; headline "Feedback in. / *Reviewed code out.*" in Cormorant
  Garamond 700 `clamp(34px,4.6vw,48px)`, second line italic `var(--accent)`; 14.5px/300 body at
  `rgba(255,255,255,.6)`; two 12px status lines each with a 5px `var(--t-ok)` dot.
* Right panel: eyebrow **SIGN IN**, h2 "Administrator" (Cormorant 700 30px), username + password
  fields, full-width accent submit, and a 11.5px footnote naming Argon2id, HttpOnly sessions, rate
  limiting and `pnpm admin:create`.
* Submit navigates to `/admin`. Real implementation: `POST /api/admin/login`, CSRF token, rate
  limiting, temporary lockout, audit event on success **and** failure.

### 5.2 Public intake form — `/f/{slug}`

`max-width:720px`, centred. Top strip shows the public URL in mono 10px. Card has
`border-top: 3px solid var(--accent)`.

Fields in order (all copy is Dutch, matching the mock form): project selector, category selector,
short summary, long description, page URL, environment, screenshot dropzone
(`1px dashed var(--border2)`, 24px padding, "PNG of JPG · max 8 MB · geen SVG"), optional e-mail.
Two-up rows use `grid-template-columns: repeat(auto-fit, minmax(220px,1fr)); gap:16px`.

Submit → confirmation card: 1×40px accent rule, Cormorant headline, body copy, and the reference in
a bordered inline block — 10px/700/.2em "REFERENTIE" over the ticket number in mono 22px.

Server-side requirements (PRD §27.2): validation, IP + form rate limit, honeypot, optional CAPTCHA,
max body size, MIME sniffing, random storage names, image-only, no SVG, no executables.

### 5.3 Dashboard — `/admin`

1. Header. Eyebrow is the date; title is a sentence that counts the open decisions
   ("Four things need you."). Actions: **Job queue** (secondary), **Open triage** (accent).
2. **Stat strip** — `grid-template-columns: repeat(auto-fit, minmax(168px,1fr)); gap:1px` over a
   `var(--border)` background inside a bordered rounded box, so the gap renders as hairlines. Each
   tile is a button: 10px/700/.16em uppercase label, Cormorant 700 38px value, 11.5px sub-line.
   Values: Awaiting triage 2 · Plans to review 2 (`var(--t-warn)`) · Active runs 2 (`var(--t-run)`) ·
   PRs to review 3 · Failed jobs 2 (`var(--t-danger)`).
3. **Four cards** in `repeat(auto-fit, minmax(330px,1fr))`:
   * *Waiting on your decision* — rows of `DCC-nnn` (mono 11px) + title + meta, with a coloured
     action chip on the right (`Review plan` / `Triage` / `Repair`).
   * *Active Claude runs* — per run: pulsing dot, run id, type · ticket · project, a 3px progress
     bar (`turn / maxTurns`), then `model · effort · turn n/m` and elapsed time.
   * *System health* — six label/value rows: Claude subscription auth, Anthropic API guard, worker
     heartbeat, GitHub auth, project health, notification deliveries.
   * *Blocked* — rows with a 3px full-height coloured bar and two-line explanation.

### 5.4 Tickets — `/admin/tickets`

Filter bar: search input (`flex:1 1 240px`), project select, status select, **Reset**, and a
right-aligned `n of 14` count. View toggle **Table / Board** lives in the page header.

**Table.** Not a `<table>` — a grid list.
`grid-template-columns: 110px minmax(220px,3fr) 1.2fr 1fr 1.1fr 1.3fr 0.8fr; gap:12px; padding:13px 18px`.
Header row uses the same columns with `background: var(--surface2)` and 10px/700/.14em uppercase
labels. Columns: ticket number (mono 11.5px), title (13.5px/500, ellipsised), project, priority
chip, `model · effort` (mono), status chip, updated (right-aligned).

**Board.** `repeat(auto-fit, minmax(230px,1fr))` columns titled Triage / Planning / Plan review /
Execution / PR review / Done, each a `var(--surface2)` well with a bordered header showing a count.
Cards are `var(--surface)` with `border-left: 2px solid <status colour>`; card body is number +
priority, title, then project + model.

Status-to-column mapping is in the prototype's `boardColumns()` — reuse it verbatim.

### 5.5 Ticket detail — `/admin/tickets/{id}`

Header: back link, ticket number, status chip, priority chip, then the title in Cormorant 700
`clamp(26px,3.6vw,38px)`, `max-width:24ch`. Actions: **Preview prompt**, **Request revision**,
**Approve plan v3**.

Tab bar: horizontally scrollable, `border-bottom: 1px solid var(--border)`, each tab 13px with a
2px bottom bar (`var(--accent)` when active) and `margin-bottom:-1px`.

Body grid: `minmax(0,1fr) 306px`.

| Tab | Content |
| --- | --- |
| Overview | Normalized ticket (description, expected/actual side-by-side, numbered repro steps, 120×80 attachment thumbs); Original submission in a mono block marked "Untrusted · read-only"; Internal notes thread + composer |
| AI & skills | Basic/Advanced segmented control; in Advanced, three model+effort pairs (Planning / Execution / Repair) separated by hairlines; a green validation note stating the resolved precedence chain; then the skills block |
| Prompt | Four-up summary strip (composed-from, prompt versions, skills injected, AI used) over the assembled prompt in a mono block, sections numbered 1–10 per PRD §14.5 |
| Plans | Version list — current version highlighted with `var(--accent-soft)`, each row showing version, state, `model · effort · run · hash`, timestamp |
| Runs | Run rows linking to run detail |
| Validation | The 12-step pipeline with per-step dots; greyed out until an execution attempt exists |
| Pull request | Empty state until the worker opens a draft PR |
| Activity | Status-history timeline: 9px dots on a 1px connector, newest first, each with actor and reason |

Right rail: **Ticket** metadata list · **Approval gates** (gate 1 ticked, gate 2 open, with the two
action buttons — *Start execution* is disabled until a plan is approved) · **Danger zone** (request
more information, mark duplicate, reject).

#### Skills block (this is the part that changed most recently — read carefully)

A skill is **a reference, never a copy**: a slug plus the path to its `SKILL.md`.

* **Chips.** `border-radius:99px`, `padding:5px 6px 5px 12px`, 12.5px. Automatic skills:
  `var(--surface2)` fill, `var(--border)` border, `var(--text2)` text, plus a 9.5px uppercase
  `auto` tag and **no** remove control. Manually selected: `var(--accent-soft)` fill,
  `var(--accent)` border, `var(--text)` text, with a `×` button. The `title` attribute reads
  `Automatically added by project · <path>` or `Selected on this ticket · <path>`.
* **`+ Add skill`** opens an inline picker: search input, **Done**, category pill row
  (All, Frontend, Backend, Database, Security, Testing, Performance, SEO, Accessibility,
  Architecture, DevOps), then a `max-height:330px` scroll list. Each row: 15px checkbox
  (accent fill + `✓` when on), name, uppercase category, coloured risk label, description, then the
  **filesystem path** in mono, then `v<version> · <note>` where note is `Disabled in registry`,
  `Project default`, or the allowed phases. Disabled skills are not selectable.
* **Resolved references block.** A bordered panel headed "RESOLVED REFERENCES INJECTED INTO THE
  PROMPT" with the live count, whose body is exactly what gets injected:

  ```
  Use the following skills:
  - ponytail: skills/global/ponytail/SKILL.md
  - project-conventions: skills/projects/va-jobs-platform/project-conventions/SKILL.md
  - secure-development: skills/global/secure-development/SKILL.md
  - testing-standards: skills/global/testing-standards/SKILL.md
  - frontend-design: skills/global/frontend-design/SKILL.md
  - playwright-e2e: skills/projects/va-jobs-platform/playwright-e2e/SKILL.md
  ```

  It must regenerate on every selection change. This is the contract between the UI and the prompt
  builder — the same lines appear in the Prompt tab, the Preview-prompt modal and the run snapshot.
* Info note: automatic skills come from `projects.yaml` and can only be removed when the project
  allows overrides; on approval paths, versions and hashes are frozen into a skill snapshot.

### 5.6 Plan review — `/admin/tickets/{id}/plans/{version}`

Body grid `minmax(0,1fr) 306px`.

Left: mode toggle **Rendered / Raw Markdown / Diff v2 → v3** plus the plan hash.
* *Rendered* — `max-width:74ch`. H1 Cormorant 700 32px, a mono sub-line, then numbered sections whose
  headings are 12px/700/.14em uppercase `var(--accent)` and whose body is 14.5px/1.8 `var(--text2)`.
  Inline code: `var(--code-bg)`, `padding:1px 5px`, radius 3px. File lists are mono blocks.
* *Raw* — the same document as `<pre>` in mono 12px/1.85 on `var(--code-bg)`.
* *Diff* — per-line rows, 2px vertical padding, 16px horizontal. Removed: `var(--s-danger)` on
  `var(--t-danger)`. Added: `var(--s-ok)` on `var(--t-ok)`. Context: `var(--text3)`.

Right rail: version list (selected row gets `var(--accent-soft)` + a 2px accent left border) ·
run snapshot (model, effort, session, skills, base commit) · feedback composer with a
"Change model for the revision" checkbox and a **Submit feedback & queue revision** button.

### 5.7 Runs, run detail, queue

* **Runs** — grid list `90px 1.4fr 1fr 0.9fr 1fr 110px`. Row two-lines the ticket · project over the
  working directory in mono. Status chip is tinted by tone; active runs use `var(--t-run)`.
* **Run detail** — header with a pulsing status chip and **Download logs** / **Cancel run**.
  Tabs *Event stream* / *Prompt snapshot* / *Working diff*. Event stream is a `max-height:560px`
  scrolling mono block, `[hh:mm:ss] channel message`, ending in a `█` cursor while live. Right rail:
  immutable run snapshot (type, model, effort, turns, elapsed, session id) and
  **Permissions in force** — an `allow` line and two `deny` lines listing the blocked commands and
  protected paths.
* **Queue** — grid list `105px 1.3fr 1fr 0.7fr 0.7fr 0.8fr 0.9fr` over job id, type (mono), ticket ·
  project, priority, attempt `n / m`, status chip, availability. Page header carries the concurrency
  limits and worker heartbeat.

### 5.8 Pull requests

* **List** — tab bar All / Open / Draft / Merged / Closed, then search + repository filter, then a
  grid list `70px minmax(200px,3fr) 1.1fr 0.9fr 1.1fr 1fr`: `#n`, title over `project · head branch`
  in mono, linked ticket (accent when linked, `Not linked` in `var(--text3)` otherwise), checks,
  review chip, and `+adds −dels · n files` right-aligned.
* **Detail** — body grid `minmax(0,1fr) 306px`.
  Left: *Pull request body* (problem, approved plan summary, a four-up metadata strip of model, plan
  hash, run, skills applied, and a four-item human review checklist); *Validation output* — nine
  dotted steps with timings and an "All 9 steps passed" summary; *Changed files* — mono rows with
  `+n` in `var(--t-ok)` and `−n` in `var(--t-danger)`.
  Right: metadata (linked ticket, author, base, head sha, created, last synced), checks list, and a
  **Repair** panel with an instructions textarea, **Start repair workflow**, and the standing note
  that merging only ever happens on GitHub.

### 5.9 Projects

* **List** — cards in `repeat(auto-fit, minmax(300px,1fr))`, each with a 2px top border tinted by
  health, Cormorant 22px name, description, repository path in mono, and a bottom stat row
  (Open, PRs, Default AI, Validated).
* **Detail** — health chip in the header; if the repository is dirty, a full-width
  `var(--s-danger)` banner with a 3px left border stating that planning and execution are blocked
  and that the checkout is never reset automatically. Tabs: *Overview* (paths + validation commands),
  *YAML config* (`config/projects.yaml` in a mono `<pre>` with a "Schema valid" indicator),
  *Skills* (automatic list with per-skill path, version and an `override` checkbox),
  *Validation* (the PRD §11.4 checklist with dots), *Prompts* (project prompt files and versions).
  Right rail: default AI selects for planning and execution, and the protected-paths list.

### 5.10 Forms and form builder

* **List** — cards showing status chip, public URL in mono, field count, submissions, project binding.
* **Builder** — tabs *Fields* / *Settings* / *Preview*.
  * *Fields*: left column is the ordered field list — each row has an index, label, `key · type` in
    mono, a Required/Optional tag, and ↑ ↓ × controls; the selected row gets `var(--accent-soft)`
    and a 2px accent left border. Right column edits the selected field: label, key, type
    (15 types per PRD §15.3), Required checkbox, plus the upload-safety note.
  * *Settings*: internal name, public title, slug, project binding, rate limit, CAPTCHA, completion
    message, and two toggles.
  * *Preview*: renders the current field list as a live public-form mock inside a `var(--surface2)` well.

### 5.11 Prompts

Two-pane, `250px minmax(0,1fr)`. Left is a file tree grouped `prompts / global` and
`projects / <slug>`, each row showing the filename in mono and its version; the selected row gets
`var(--accent-soft)` + a 2px accent left border. Right pane header shows filename, scope, version
and last-updated, plus an **Edit / Rendered / History** toggle.

* *Edit* — a full-width mono textarea on `var(--code-bg)`.
* *Rendered* — the same content as typographic Markdown, `max-width:70ch`.
* *History* — version rows with message and timestamp; the active version is highlighted.

### 5.12 Skills

* **Registry** — search, category pill row, then a grid list
  `minmax(200px,2fr) 1fr 0.8fr 0.7fr 0.8fr 0.7fr`: name over its **filesystem path** in mono,
  category, scope, version, risk (tinted), enabled/disabled chip.
* **Detail** — a pure reference page, with **no file contents inlined** so nothing can drift from
  the file on disk:
  * Header: back link, `v<version> · <hash>` in mono, risk chip, name.
  * *Prompt line* — the exact injected line in a mono block: `- <slug>: <path>`.
  * *Description* — from the registry.
  * *Resolved path* — the path plus a green **Resolves** chip.
  * A note explaining that the registry stores a reference, that the `SKILL.md` and its supporting
    files live on disk under Git, and that before each run the worker symlinks the exact version into
    `data/skill-bundles/{run-id}/.claude/skills/` and records its content hash in the run snapshot.

### 5.13 Notifications

Tabs *Event rules* / *Providers* / *Templates* / *Deliveries*.

* *Event rules* — one row per event: event name in mono, a Required/Optional tag, the provider, and
  an Enabled/Disabled chip. The six PRD §23.2 events are marked Required.
* *Providers* — two cards. **WhatsApp server** (marked *Placeholder*: base URL, endpoint, auth type,
  secret reference, timeout, max attempts, enable toggle) and **Generic webhook** (endpoint plus a
  sample JSON payload in mono).
* *Templates* — a mono textarea holding the message template with `{{ticket.number}}`-style
  placeholders **rendered literally**, and a row of variable pills beneath it.
* *Deliveries* — grid list `90px 1.4fr 0.8fr 1.1fr 0.7fr 0.8fr 0.9fr` with the standing note that a
  failed delivery never fails the ticket workflow.

### 5.14 Audit, settings, system

* **Audit** — search plus a grid list `110px 110px minmax(180px,1.4fr) 1.2fr 110px`: when, actor,
  action (mono, tinted by outcome), entity, IP (right-aligned).
* **Settings** — tabs General / Authentication / Claude runtime / GitHub / Retention. The Claude tab
  carries a green confirmation that `CLAUDE_CODE_OAUTH_TOKEN` is present and worker-only, and a row
  of red mono pills for the five refused environment variables.
* **System** — four stat cards with health-tinted top borders (Worker, Claude Code, Queue depth,
  Disk), then Project health, Recent system errors and Backups.

---

## 6. Interactions and behaviour

| Interaction | Behaviour |
| --- | --- |
| Nav | Sets route; scrolls to top; closes the mobile drawer |
| Mobile drawer | Sidebar becomes `position:fixed`, `translateX(-100%)`, `transition: transform .22s ease`; opening adds a `var(--overlay)` scrim at z-index 55 (sidebar 60) that closes on click |
| Theme | Light / Auto / Dark. Auto follows `matchMedia('(prefers-color-scheme: dark)')` and re-applies on change. Writes `data-theme` on `<html>`. Persist the choice server-side or in a cookie |
| Ticket filters | Client-side in the prototype; use server-side filters and pagination in production (PRD §30.2) |
| Table / Board toggle | Same filtered set, two presentations |
| Tabs | Local state only; make them real URL segments |
| Skill picker | Toggling updates chips **and** the resolved-references block in the same tick |
| Modals | Centred, `max-width:660px`, `max-height:86vh`, `animation: dccIn .16s ease-out`, scrim `var(--overlay)`. Four: prompt preview, approve plan, request revision, execution-blocked. Close on scrim click and on `Escape` (add the key handler — the prototype omits it) |
| Form builder | Reorder, delete and add mutate the field array and re-render the live preview |
| Buttons | Secondary hover `border-color: var(--border2); color: var(--text)`. Accent hover `filter: brightness(1.08)`. Destructive hover tints with `var(--s-danger)` |
| Rows | Hover `background: var(--surface2)` |
| Disabled | `cursor: not-allowed`, `var(--text3)` text — used for *Start execution* before plan approval |

### Real-time (not in the prototype)

Run detail must stream. The worker emits `stream-json`; surface it over SSE or WebSocket and append
to the event list. Update the dashboard's active-run progress bar from `turn / maxTurns` and tick
the elapsed timer client-side. On disconnect, fall back to polling `GET /api/admin/runs/{id}/events`.

### Approval gates — enforce in the UI as well as the API

1. A ticket cannot enter planning until it is explicitly approved.
2. Execution cannot start until a **specific plan version** is approved; the approve action must
   carry the plan hash. If the ticket, prompts, project config or skills change afterwards, show the
   plan as `potentially_stale` and block execution until the operator reconfirms.
3. Never expose a merge action. Merging happens on GitHub.

---

## 7. Design tokens

Copy this block verbatim. Every colour in the design is one of these variables — there are no
one-off hex values in the UI.

```css
:root{
  --bg:#F7F7F5; --surface:#FFFFFF; --surface2:#F0F2F6; --raised:#FFFFFF;
  --border:rgba(11,35,86,.12); --border2:rgba(11,35,86,.22);
  --text:#0B2356; --text2:#3A4A66; --text3:#8791A5;
  --accent:#C8102E; --accent-fg:#FFFFFF; --accent-soft:rgba(200,16,46,.08);
  --side-bg:#0B2356; --side-sub:rgba(255,255,255,.34); --side-text:rgba(255,255,255,.62);
  --side-active:#FFFFFF; --side-border:rgba(255,255,255,.10); --side-hover:rgba(255,255,255,.06);
  --t-ok:#12734A; --t-warn:#8F6210; --t-danger:#C8102E; --t-info:#23508F;
  --t-run:#6B3FA0; --t-muted:#8791A5;
  --s-ok:rgba(18,115,74,.10); --s-warn:rgba(143,98,16,.12); --s-danger:rgba(200,16,46,.09);
  --s-info:rgba(35,80,143,.10); --s-run:rgba(107,63,160,.11); --s-muted:rgba(135,145,165,.13);
  --code-bg:#F0F2F6;
  --shadow:0 1px 2px rgba(11,35,86,.05),0 10px 30px rgba(11,35,86,.07);
  --overlay:rgba(7,24,64,.42);
}
:root[data-theme="dark"]{
  --bg:#061334; --surface:#0B2356; --surface2:#102C6B; --raised:#0E2657;
  --border:rgba(255,255,255,.11); --border2:rgba(255,255,255,.22);
  --text:#F2F4F8; --text2:rgba(242,244,248,.72); --text3:rgba(242,244,248,.46);
  --accent:#E5384F; --accent-fg:#FFFFFF; --accent-soft:rgba(229,56,79,.15);
  --side-bg:#040E27; --side-sub:rgba(255,255,255,.30); --side-text:rgba(255,255,255,.58);
  --side-active:#FFFFFF; --side-border:rgba(255,255,255,.08); --side-hover:rgba(255,255,255,.05);
  --t-ok:#46C98D; --t-warn:#E3AA47; --t-danger:#F0566C; --t-info:#82ACEF;
  --t-run:#B692E4; --t-muted:rgba(242,244,248,.46);
  --s-ok:rgba(70,201,141,.13); --s-warn:rgba(227,170,71,.14); --s-danger:rgba(240,86,108,.14);
  --s-info:rgba(130,172,239,.13); --s-run:rgba(182,146,228,.14); --s-muted:rgba(242,244,248,.09);
  --code-bg:#040E27;
  --shadow:0 1px 2px rgba(0,0,0,.34),0 10px 30px rgba(0,0,0,.28);
  --overlay:rgba(2,7,20,.62);
}
```

### Typography

| Role | Family | Size | Weight | Notes |
| --- | --- | --- | --- | --- |
| Page title | Cormorant Garamond | `clamp(30px,4.2vw,42px)` | 700 | `letter-spacing:-1px; line-height:1.05` |
| Detail title | Cormorant Garamond | `clamp(26px,3.6vw,38px)` | 700 | `letter-spacing:-.8px` |
| Card title | Cormorant Garamond | 20–22px | 700 | `letter-spacing:-.3px` |
| Stat value | Cormorant Garamond | 26–38px | 700 | `line-height:1` |
| Section heading | DM Sans | 11.5–12px | 700 | `letter-spacing:.14em`, uppercase, `var(--text2)` |
| Eyebrow | DM Sans | 10px | 700 | `letter-spacing:.2em`, uppercase, `var(--text3)` |
| Body | DM Sans | 14–14.5px | 400 | `line-height:1.75` |
| UI / rows | DM Sans | 12.5–13.5px | 400–500 | |
| Meta | DM Sans | 11–12px | 400 | `var(--text3)` |
| Code / ids / paths | JetBrains Mono | 11–12.5px | 400–500 | |

Fonts: `Cormorant Garamond` (600/700 + italics), `DM Sans` (300/400/500/700), `JetBrains Mono`
(400/500). Numeric columns and timers use `font-variant-numeric: tabular-nums`.

### Spacing, radii, motion

* Spacing steps actually used: 2, 4, 6, 7, 8, 9, 10, 11, 12, 14, 16, 18, 20, 22, 26, 34px.
  Card padding 18px, row padding `12–13px 18px`, section gap 16px, page gap 16–22px.
* Radii: 3px chips/badges/small controls · 4px inputs and buttons · 5–6px cards and sections ·
  8px modals and the login card · 99px pills.
* Borders are always 1px `var(--border)`; emphasis borders are 2px and coloured.
* Motion: `dccPulse` 1.4s (active) / 2.4s (healthy) `ease-in-out infinite`; `dccIn`
  `.16s ease-out` (opacity + 6px rise) for modals; drawer `.22s ease`. Nothing else animates.

### Responsive

Single JS breakpoint at **980px** (`window.innerWidth < 980` → mobile). Everything else is
`clamp()` and `repeat(auto-fit, minmax(…, 1fr))`.

* Sidebar → off-canvas drawer, hamburger appears, worker pill shortens.
* `main` padding drops to `18px 14px 56px`.
* Two-column detail grids (`… 306px`) collapse to `1fr` — the right rail stacks under the content.
* **Every grid list drops its header row and switches to a card row** (~96px tall):
  line 1 identifier + status chip, line 2 the title, line 3 a meta row with a right-aligned
  timestamp. Applies to Tickets, Runs, Queue, Pull requests, Skills, Deliveries and Audit.
  Do not let a desktop grid collapse to `1fr` — unlabelled stacked cells are unreadable.

---

## 8. State

Screen state held by the prototype, and what it becomes in production:

| Prototype state | Production |
| --- | --- |
| `screen`, `ticketId`, `runId`, `prNum`, `projectSlug`, `formSlug`, `promptId`, `skillSlug` | URL segments |
| `ticketTab`, `projectTab`, `formTab`, `notifTab`, `settingsTab`, `runTab`, `planMode`, `promptMode`, `prTab` | URL query or nested routes |
| `tq`, `tProject`, `tStatus`, `prq`, `prProject`, `skillQ`, `skillCat`, `auditQ` | Query params → server-side filters |
| `ticketView` | Persisted user preference |
| `theme` | Cookie / user preference; `data-theme` on `<html>` |
| `mobile`, `navOpen` | Client-only |
| `selectedSkills`, `aiMode` | Ticket record; `PUT /api/admin/tickets/{id}/skills`, `PATCH /api/admin/tickets/{id}` |
| `formFields`, `fieldIdx` | Form record; `PATCH /api/admin/forms/{id}` |
| `planVersion` | Route segment |
| `modal` | Client-only |
| `publicStep` | Route (`/f/{slug}` → `/f/{slug}/submitted`) |

Data the UI needs, per PRD §26: `projects`, `tickets` (+ `ticket_status_history`), `skills`
(+ `project_skills`, `ticket_skills`, `skill_snapshots`), `prompt_files` / `prompt_versions` /
`prompt_snapshots`, `plans` / `plan_versions` / `plan_reviews`, `agent_runs` / `agent_run_events`,
`execution_attempts`, `pull_requests`, `forms` / `form_fields`, `notification_*`, `jobs`,
`audit_events`.

---

## 9. Mock data in the prototype

Four projects (`va-jobs-platform`, `corporate-site`, `customer-portal`, `billing-api`), 14 tickets
(DCC-135 … DCC-148) spanning every workflow state, 13 skills, 7 pull requests, 8 runs, 8 jobs,
4 forms, 6 notification deliveries, 10 audit events, 12 prompt files.

Note the intentional unhappy paths — reproduce these states in your fixtures:
`customer-portal` has a **dirty repository** (blocked), DCC-144 has a **failed validation**,
delivery `ND-8841` **failed with a 504**, and `RUN-0898` **timed out at 40 turns**.

Skill paths are derived from ownership, not from a hardcoded project:
`skills/global/<slug>/SKILL.md` for global skills, `skills/projects/<owning-project>/<slug>/SKILL.md`
for project skills. One slug resolves to exactly one path everywhere in the app.

---

## 10. Assets

None. No images, no icon library, no SVG illustrations. Every graphic element is CSS — the brand
mark is a coloured square with a letter, status indicators are coloured dots and chips, the progress
bar is a nested div, the timeline is dots on a 1px line. Keep it that way; if you need icons, adopt
whatever icon set the codebase already ships rather than introducing one.

---

## 11. Accessibility and quality bar

* Contrast: all text pairs meet WCAG AA in both themes; do not lighten `var(--text3)` further.
* Every interactive element is a real `<button>`, `<a>`, `<input>` or `<select>`. Focus is visible:
  `outline: 2px solid var(--accent); outline-offset: 1px`.
* Icon-only controls carry `aria-label` (hamburger, chip remove, field reorder, modal close).
* Add what the prototype lacks: `Escape` to close modals, focus trapping in modals, focus restore on
  close, `aria-current="page"` on the active nav item, `role="tablist"`/`aria-selected` on tab bars,
  and a live region announcing filter result counts.
* Minimum touch target 44px on mobile.
* Tables must stay navigable by keyboard when rendered as card rows.

---

## 12. Files in this bundle

| File | Purpose |
| --- | --- |
| `README.md` | This document — self-sufficient implementation spec |
| `Development Control Center.dc.html` | The clickable design reference. Open in a browser |
| `support.js` | Prototype runtime. Required only to view the reference; not part of the deliverable |

Open the prototype, click through all 22 admin routes plus login and the public form, and toggle
Light / Auto / Dark and desktop / mobile before you start. Where this document and the prototype
disagree on a number, the prototype wins.
