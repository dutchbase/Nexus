# Execution prompt — finish the frontend category (FE-01/02/05–12)

You are continuing the LFD run defined in `goal.md` (same directory). Read
`goal.md` and `harness/HARNESS_CONVENTIONS.md` in full before writing any
code. This prompt is scoped to one thing: the `frontend` eval category
(20% weight), which was **structurally blocked at 0/13 for the entire build
until 2026-07-27**, when an operator-level harness bug was fixed (probes
were running before frontend specs, permanently locking the login the
frontend specs also needed — see `LOG.md`'s "Harness scoring-accuracy
fixes" entry). Frontend is now scoring for the first time. Current state:

```
FE-01 fail   FE-02 fail   FE-03 pass   FE-04 pass   FE-05 fail
FE-06 fail   FE-07 fail   FE-08 fail   FE-09 fail   FE-10 fail
FE-11 fail   FE-12 fail   FE-13 pass
```

3/13 passing. The 10 failing cases below are **real, previously-invisible
application gaps** — not harness noise. Nobody has diagnosed *why* FE-05
through FE-12 fail yet (they were never visible before the harness fix);
FE-01/FE-02 have prior partial-pass history in `LOG.md` from an earlier
build phase, so something regressed or the fixture state shifted since.
Treat all 10 as fresh investigation, not known root causes.

## Working rules (same as the original build)

1. **ponytail skill for every change.** Ladder: does this need to exist →
   already in this codebase → stdlib/native platform feature → already-
   installed dependency → one line → only then new code. These are UI gaps
   in an existing shell/ticket-detail/routing system — expect most fixes to
   be CSS, markup, or a missing handler in `apps/web/src/ui.ts` /
   `apps/web/src/server.ts`, not new subsystems.
2. **Write only what turns these 10 cases green.** No redesign, no
   componentization pass, no unrequested a11y audit beyond what FE-09 asks.
3. **Never modify `harness/` or `goal.md`.** If a test's selector
   assumption looks wrong, report it in your commit message and a `LOG.md`
   entry — don't edit the test.
4. **Verify by running the actual spec file**, not by reading your diff and
   guessing. Each fix below names its exact file.
5. **Commit per case or small case-cluster** (cases sharing one file/root
   cause can land together), referencing the FE-ID(s) in the message.
6. **Design source of truth:** `design-handoff/README.md` §3–§11 (routes,
   shell layout, modals, responsive breakpoints, tokens) is the spec these
   tests encode. Read the relevant section before implementing each case —
   don't reverse-engineer requirements from the Playwright assertions
   alone; the handoff doc has the intent, the test has the exact contract.

## First action

```bash
cd /home/dutchbase/projects/dev-control-center/.worktrees/dcc-build
bash .lfd/dcc-build/harness/pg-ephemeral.sh stop 2>/dev/null
rm -rf data/
bash .lfd/dcc-build/harness/run-evals.sh
```

Confirm you reproduce the same 3-pass/10-fail baseline above before
starting. Then iterate one case (or cluster) at a time — after each fix,
re-run just that spec file directly rather than the full harness, to keep
iteration fast:

```bash
# example, after fixing shell.spec.ts's cases:
npx playwright test .lfd/dcc-build/harness/tests/frontend/shell.spec.ts \
  --root /home/dutchbase/projects/dev-control-center/.worktrees/dcc-build
```

Run the full `bash .lfd/dcc-build/harness/run-evals.sh` once at the end to
confirm the whole category and check for regressions elsewhere.

## The 10 cases, grouped by file

### `tests/frontend/shell.spec.ts` — FE-01, FE-02

- **FE-01** (`shell metrics and live badge counts`): the sidebar's
  `getComputedStyle(...).width` must equal exactly `"246px"`; the header's
  height must equal exactly `"64px"` with `position: sticky`; the sidebar
  must contain visible text for all four nav groups ("Overview", "Work",
  "Configure", "Operate"); the Tickets nav item's text must end in a
  trailing number between 1 and 14 (a live open-ticket count).
- **FE-02** (`nav item stays active on detail sub-routes`): navigating to
  `/admin/tickets/DCC-142` must leave the Tickets nav item with
  `aria-current="page"` set, even though the URL isn't the list route.

Check computed sidebar width/header height first — these are exact-pixel
assertions, easiest to get wrong via a token/CSS variable drift. Check
`aria-current` wiring next — likely a router-active-state check keyed only
on exact path match, not prefix match.

### `tests/frontend/ticket-detail.spec.ts` — FE-05, FE-06, FE-07, FE-08

All four load `/admin/tickets/DCC-142` (no approved plan) or
`/admin/tickets/DCC-141` (approved plan) — both seeded fixtures.

- **FE-05**: the page needs a `role="tablist"` containing exactly 8
  `role="tab"` elements, in this exact order and text: `Overview`,
  `AI & skills`, `Prompt`, `Plans`, `Runs`, `Validation`, `Pull request`,
  `Activity`.
- **FE-06**: on DCC-142 (no approved plan), the "Start execution" button
  must be `disabled`. On DCC-141 (approved plan), the same button must be
  enabled. (The live no-reload transition sub-case is already
  `test.fixme`'d in the harness — not required.)
- **FE-07**: on the "AI & skills" tab, clicking "+ Add skill" must reveal
  checkboxes; toggling an enabled one must update the "resolved references
  injected into the prompt" panel's text **without a page reload**
  (poll-friendly — a client-side re-render is enough), and the same
  reference lines (lines starting with `-`) must then appear verbatim in
  the Prompt tab's content.
- **FE-08**: automatic (project-level) skill chips need
  `title="Automatically added by project..."`, contain the text "auto",
  and have **no** `button[aria-label*="remove"]`. Manually-added chips need
  `title="Selected on this ticket..."` and **do** need exactly one
  `button[aria-label*="remove"]` that, when clicked, updates the resolved-
  references panel.

FE-07/FE-08 both hinge on the same two `title`-attribute conventions and
the same resolved-references panel existing near a heading matching
`/resolved references injected into the prompt/i` — implement that markup
once and both cases should move together.

### `tests/frontend/a11y.spec.ts` — FE-09

- Ticket DCC-142's page needs a button matching `/preview prompt/i` (§5.5
  header action) that opens a `role="dialog"` modal. While open: Tab must
  never move focus outside the modal (25 forward presses, 5 Shift+Tab
  reverse presses — a real focus trap, not just visual layering). Escape
  must close it. Closing must return focus to the trigger button
  (`toBeFocused()`).

If there's no modal/focus-trap primitive in the codebase yet, this is
likely the smallest new thing to write in this whole prompt — check
`apps/web/src/ui.ts` for existing dialog patterns before writing one from
scratch (ponytail step 2).

### `tests/frontend/responsive.spec.ts` — FE-10, FE-11

Both run at a 900px viewport (`design-handoff/README.md` §7, below the
980px breakpoint).

- **FE-10**: the sidebar must have an off-canvas `transform: translateX(…)`
  with the X component `< -50` in its closed state (§6:
  `translateX(-100%)`); a button matching `/menu|navigation|hamburger/i`
  must be visible and, when clicked, bring the sidebar back into view
  (`toBeInViewport()`); opening it must also produce a full-viewport
  `position: fixed` scrim element (covering >70% of viewport width/height)
  that, when clicked, closes the drawer again (back to `translateX < -50`).
  Separately, `/admin/tickets` at this width must show **zero**
  `role="columnheader"` elements (no desktop grid header) and DCC-142's
  number, status, and title must all appear together inside one
  reasonably-scoped container (a card row, not separate grid cells).
- **FE-11**: on `/admin/tickets` at 900px, sample up to 20 visible, enabled
  `button`/`a`/`input`/`select` elements — every one needs a bounding box
  ≥44×44 CSS px.

FE-10 and FE-11 are both purely CSS/breakpoint work on the same page — do
them together. FE-11 in particular is usually a padding/min-height fix on
existing controls, not new markup.

### `tests/frontend/all-routes.spec.ts` — FE-12

Loads all 22 documented routes (3 public + 19 admin) and asserts no
uncaught `pageerror` and no visible generic error-boundary text
(`/application error|something went wrong|500|internal server error/i`) on
any of them. Then checks four specific unhappy-path fixtures render their
expected state:

1. `/admin/projects/customer-portal` — visible text matching `/dirty|uncommitted/i` (dirty-repo banner, §5.9).
2. `/admin/tickets/DCC-144` → Validation tab — visible text matching `/validation failed/i`.
3. `/admin/notifications` → Deliveries tab — a row containing **both**
   `"ND-8841"` and `"504"` together, plus visible text matching `/failed/i`.
4. `/admin/runs` → click through to run `RUN-0898`'s detail page (URL
   becomes `/admin/runs/<uuid>` — don't hardcode the id, click the row
   showing `RUN-0898`'s label) — visible text matching `/timed out/i`.

Start by just loading each of the 22 static routes manually / via the test
and reading the first thrown error — this case bundles "does the route
render at all" with "does it show the right unhappy-path fixture data", so
a single crashing route can fail the whole case before the unhappy-path
assertions are even reached. Fix crashes first, then check each of the 4
fixture states individually.

## Definition of done

`bash .lfd/dcc-build/harness/run-evals.sh` shows all 13 `FE-*` cases
passing, `hard_fail_triggered: false`, and no regression in the other four
categories' scores vs. the current baseline in `LOG.md`
(`workflow=1.0 security=1.0 determinism=1.0 operational=1.0`). Append a
`LOG.md` entry (append-only, do not edit prior entries) summarizing what
changed per case and the final full scorecard.
