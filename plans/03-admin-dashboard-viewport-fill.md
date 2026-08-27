# Admin Dashboard Viewport-Fill Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task (single-file, linear CSS/markup change with a clear before/after — subagent-driven-development overhead isn't warranted). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the four `/admin` dashboard cards (`Waiting on your decision`, `Active Claude runs`, `System health`, `Blocked`) stretch to fill remaining viewport height down to the bottom of the screen on desktop, with zero page-level vertical scroll, while each card scrolls its own content independently under a fixed header.

**Architecture:** This codebase is **plain server-rendered HTML strings with inline `style="..."` attributes plus one shared CSS file** (`apps/web/src/design-tokens.css`) — there is no React/Tailwind here (verified by investigation; the task brief's Tailwind-flavored phrasing doesn't apply literally). PR #49 (commit `290f7b6`) already split the single 4-card grid into two independent 2-card grid rows to stop cross-pair height inheritance, but neither row nor the outer `.shell`/`.content`/`.main` chain is height-constrained to the viewport — so the page still grows/shrinks with content instead of filling to the bottom. Fix this by wrapping the dashboard's own body in a new `.dashboard-shell`/`.dashboard-rows` scoped flex layout (scoped to the dashboard route only, NOT the shared `.main`/`.content` rules, since those are used by every other `/admin/*` page which must keep normal page scrolling), gated to a desktop breakpoint so mobile stacking is untouched, and give every card's content region a `flex:1;min-height:0;overflow-y:auto` treatment (replacing the two existing hardcoded `max-height:400px` scroll wrappers and adding scroll wrappers to `System health`/`Blocked`, which currently have none).

**Tech Stack:** Plain CSS (`apps/web/src/design-tokens.css`), TypeScript template-literal HTML (`apps/web/src/pages/dashboard.ts`), Playwright (`tests/e2e/visual-sweep.spec.ts` already exercises `/admin` at 5 widths × 2 themes, currently only asserting horizontal overflow).

**Spec:** This markdown file is self-contained; source task is "Make `/admin` dashboard cards fill the viewport with internal scrolling" (see plans/INDEX.md for the full original task text).

## Global Constraints

- Scope this to the `/admin` dashboard route only. Do NOT modify the shared `.main`/`.content`/`.shell` rules in `design-tokens.css` unqualified — they're used by every `/admin/*` page (projects, tickets, runs, notifications, etc.), which must keep their normal page-level scroll behavior.
- Gate all viewport-fill behavior behind a desktop-width media query (use `min-width: 1024px` to match the narrowest "desktop" width already tested in `tests/e2e/visual-sweep.spec.ts`). Below that width, leave the existing single-column stacking + normal page scroll completely untouched — do not force fixed-height cards on mobile.
- Do not hardcode a pixel height derived from a screenshot. Compute the dashboard's available height from the actual layout chain: `.header` is `height:64px` (sticky), `.main` has `padding:26px ... 72px` (top/bottom), so the dashboard's own content region gets `height: calc(100vh - 64px - 26px - 72px)`.
- Preserve the four cards' existing headers, borders, colors, typography, spacing, and content — only change how much vertical space each card/row claims and how overflow is handled inside them.
- `System health`'s and `Blocked`'s content (`healthRows`, `blockedRows`) currently render with NO scroll wrapper at all — adding `flex:1;min-height:0;overflow-y:auto` around them is new behavior for those two cards, not a regression, since previously they simply couldn't overflow (health is fixed 3 rows; blocked is `LIMIT 5` in SQL) — confirm this doesn't silently hide rows by checking the SQL `LIMIT` clauses feeding `healthRows`/`blockedRows` before finishing (if there's a hard SQL limit already capping rows well below what fits on screen, scrolling is moot for those two cards today, but the wrapper should still be added for consistency and to handle future larger row counts).

---

## File Structure

- **Modify:** `apps/web/src/pages/dashboard.ts` — wrap the returned `body` template in a new `dashboard-shell`/`dashboard-rows` structure; replace the two `max-height:400px;overflow-y:auto` wrappers with `flex:1;min-height:0;overflow-y:auto`; add the same wrapper around `healthRows` and `blockedRows`.
- **Modify:** `apps/web/src/design-tokens.css` — add scoped `.dashboard-shell`/`.dashboard-rows`/`.dashboard-rows > div`/`.dashboard-rows .card` rules inside a `@media (min-width: 1024px)` block, placed near the existing `.card`/`.main` rules (after line 68) for locality.
- **Modify:** `tests/e2e/visual-sweep.spec.ts` — add a vertical-fill assertion for `/admin` specifically at desktop widths (the file already loops over `/admin/*` routes at `WIDTHS` incl. 1024/1280/1366/1425/1440 — extend its existing per-route assertion block rather than writing a new spec file).

---

### Task 1: Scope the dashboard body in a viewport-fill flex container

**Files:**
- Modify: `apps/web/src/pages/dashboard.ts:168-218` (the `body` template literal)

**Interfaces:**
- Consumes: nothing new.
- Produces: new CSS class names `dashboard-shell` and `dashboard-rows`, consumed by Task 2's CSS.

- [ ] **Step 1: Wrap the body in the new structural classes**

Change lines 168-218 of `apps/web/src/pages/dashboard.ts` from:
```ts
const body = `
  <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:18px;flex-wrap:wrap">
    ...title/date/buttons...
  </div>

  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(168px,1fr));gap:1px;...">
    ...kpi tiles...
  </div>

  <div style="display:grid;...">
    <section class="card" ...>Waiting on your decision...</section>
    <section class="card" ...>Active Claude runs...</section>
  </div>

  <div style="display:grid;...">
    <section class="card" ...>System health...</section>
    ${blockedRows ? `<section class="card" ...>Blocked...</section>` : ''}
  </div>
`;
```
to:
```ts
const body = `
  <div class="dashboard-shell">
    <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:18px;flex-wrap:wrap">
      <div>
        <div style="font-size:10px;font-weight:700;letter-spacing:.2em;text-transform:uppercase;color:var(--text3);margin-bottom:6px">${escapeHtml(dateStr)}</div>
        <h1>${escapeHtml(totalNeedAttention)} ${escapeHtml(needsPlural)} need you.</h1>
      </div>
      <div style="display:flex;gap:8px">
        <a class="button" href="/admin/queue" style="border:1px solid var(--border);background:transparent;color:var(--text2);border-radius:4px;padding:9px 14px;font-size:13px;text-decoration:none;cursor:pointer" onmouseover="this.style.borderColor='var(--border2)';this.style.color='var(--text)'" onmouseout="this.style.borderColor='var(--border)';this.style.color='var(--text2)'">Job queue</a>
        <a class="button" href="/admin/tickets?status=Triage" style="border:0;background:var(--primary);color:var(--primary-fg);border-radius:4px;padding:9px 16px;font-size:13px;font-weight:600;text-decoration:none;cursor:pointer" onmouseover="this.style.filter='brightness(1.08)'" onmouseout="this.style.filter='brightness(1)'" >Open triage</a>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(168px,1fr));gap:1px;background:var(--border);margin-top:18px;border-radius:6px;overflow:hidden">
      ${kpiTile("Awaiting triage", awaitingCount, "", "text", "/admin/tickets?status=Triage")}
      ${kpiTile("Plans to review", plansCount, "", "warn", "/admin/tickets?status=Plan%20Ready%20for%20Review")}
      ${kpiTile("Active runs", runsCount, "", "run", "/admin/runs")}
      ${kpiTile("PRs to review", prsCount, "", "text", "/admin/pull-requests")}
      ${kpiTile("Failed jobs", jobsCount, "", "danger", "/admin/queue")}
    </div>

    <div class="dashboard-rows">
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:22px;margin-top:22px;align-items:start">
        <section class="card" style="margin-top:0">
          <div class="card-head">Waiting on your decision</div>
          ${waitingRows ? `<div style="flex:1;min-height:0;overflow-y:auto">${waitingRows}</div>` : `<div style="padding:20px 18px;color:var(--text3);font-size:13px">No tickets waiting for your decision.</div>`}
        </section>

        <section class="card" style="margin-top:0">
          <div style="padding:13px 18px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
            <div style="font-size:11.5px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--text2)">Active Claude runs</div>
            <a href="/admin/runs" style="font-size:12px;color:var(--primary);text-decoration:none" onmouseover="this.style.textDecoration='underline'" onmouseout="this.style.textDecoration='none'">All runs →</a>
          </div>
          ${runRows ? `<div style="flex:1;min-height:0;overflow-y:auto">${runRows}</div>` : `<div style="padding:20px 18px;color:var(--text3);font-size:13px">No active runs.</div>`}
          <a href="/admin/queue" style="display:block;padding:10px 18px;border-top:1px solid var(--border);font-size:12px;color:var(--text3);text-decoration:none">Queued behind: ${queuedCount} jobs · Inspect queue</a>
        </section>
      </div>

      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:22px;margin-top:22px;align-items:start">
        <section class="card" style="margin-top:0">
          <div style="padding:13px 18px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between">
            <div style="font-size:11.5px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--text2)">System health</div>
            <a href="/admin/system" style="font-size:12px;color:var(--primary);text-decoration:none" onmouseover="this.style.textDecoration='underline'" onmouseout="this.style.textDecoration='none'">Details →</a>
          </div>
          <div style="flex:1;min-height:0;overflow-y:auto">${healthRows}</div>
        </section>

        ${blockedRows ? `<section class="card" style="margin-top:0">
          <div class="card-head">Blocked</div>
          <div style="flex:1;min-height:0;overflow-y:auto">${blockedRows}</div>
        </section>` : ''}
      </div>
    </div>
  </div>
`;
```

Note: the two inner grid `<div>`s (title/kpi wrapper untouched; the two card-row grids) keep their existing inline `display:grid` styles unchanged — only the outer wrapping `<div class="dashboard-shell">`/`<div class="dashboard-rows">` and the per-card content wrappers (`max-height:400px` → `flex:1;min-height:0`, plus two new wrappers) are new.

- [ ] **Step 2: Manually verify the HTML still renders (no syntax errors in the template literal)**

Run: `npx tsc --noEmit -p apps/web` (or the project's actual tsconfig path — check root `package.json`'s `verify` script for the exact invocation) to confirm the edited file still type-checks; template literal syntax errors would surface as parse errors here.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/pages/dashboard.ts
git commit -m "refactor: scope dashboard body in dashboard-shell/dashboard-rows containers"
```

---

### Task 2: Add scoped viewport-fill CSS gated to desktop widths

**Files:**
- Modify: `apps/web/src/design-tokens.css` (add new rules after line 68, the `.card` rule)

**Interfaces:** none — pure CSS addition.

- [ ] **Step 1: Add the new rules**

Insert after line 68 (`.card { ... }`) in `apps/web/src/design-tokens.css`:

```css
@media (min-width: 1024px) {
  .dashboard-shell { display:flex;flex-direction:column;height:calc(100vh - 64px - 26px - 72px) }
  .dashboard-rows { flex:1;min-height:0;display:flex;flex-direction:column;gap:0 }
  .dashboard-rows > div { flex:1;min-height:0 }
  .dashboard-rows > div .card { display:flex;flex-direction:column;min-height:0 }
}
```

Rationale for each value:
- `calc(100vh - 64px - 26px - 72px)`: `64px` is `.header`'s fixed `height` (design-tokens.css line 62), `26px`/`72px` are `.main`'s top/bottom padding (line 64: `padding:26px clamp(18px,2.6vw,34px) 72px`) — this reconstructs "the rest of the viewport below the header, inside main's padding box" without hardcoding a screenshot-derived number.
- `.dashboard-rows { flex:1;min-height:0 }`: lets the two card-row grids share the remaining height after the title/date row and KPI-tile grid (which keep their natural content height above `.dashboard-rows` inside `.dashboard-shell`'s flex column).
- `.dashboard-rows > div { flex:1;min-height:0 }`: targets the two existing `display:grid` row wrappers (Task 1 didn't add classes to these — they're matched structurally as direct children of `.dashboard-rows`), making each of the two rows share `.dashboard-rows`'s height equally (both rows get equal height, and within each row the two cards already stretch to match each other via each row's `align-items:start` → actually change this: `align-items:start` on the grid rows currently prevents cards from stretching to fill the row's cross-axis height; for cards to fill their row's height, the row's `align-items` needs to become `stretch` (the grid default) at desktop widths — see Step 2 below).
- `.dashboard-rows > div .card { display:flex;flex-direction:column;min-height:0 }`: turns each card into a flex column so its header stays natural height and its content wrapper (now `flex:1;min-height:0;overflow-y:auto` per Task 1) can claim the remaining card height.

- [ ] **Step 2: Override `align-items:start` to `stretch` on the two row grids at desktop widths**

The two row `<div>`s in `dashboard.ts` currently have `align-items:start` inline (this was intentional in PR #49 to prevent the OLD single-4-card-grid cross-inheritance bug — but now that Task 1 already split them into two independent 2-card rows, `align-items:start` is what stops the cards from stretching to fill `.dashboard-rows > div`'s new flex-stretched height). Since inline `style` attributes have higher specificity than an external stylesheet rule for the same property on the same element, add this override directly in the CSS using `!important`, scoped to the media query and the new structural class, rather than editing the inline styles in `dashboard.ts` (which would require duplicating the change across two nearly-identical inline style strings and risks drifting from the mobile/stacked behavior which still wants `align-items:start`... actually re-examine: does mobile stacking need `align-items:start`? With `grid-template-columns:repeat(auto-fit,minmax(330px,1fr))` collapsing to 1 column on narrow screens, `align-items` on a single-column grid only affects each item's own alignment within its own row-track, which for a single card per row is a no-op either way — so it's safe to always use `stretch`). Simplify: remove `align-items:start` from BOTH inline style attributes in `dashboard.ts` entirely (both row `<div>`s) instead of fighting specificity with `!important` — `stretch` is the grid default and is desirable at all widths (a lone stacked mobile card stretching to its grid cell's height, which equals its own content height when there's only one row, is harmless).

Go back to Task 1 Step 1 and remove `;align-items:start` from both `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:22px;margin-top:22px;align-items:start">` occurrences, leaving `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:22px;margin-top:22px">`.

- [ ] **Step 3: Run the app locally and visually verify**

Use the project's `run` skill or existing dev script (check root `package.json` for `dev`/`start`) to launch the app, open `/admin` in a browser at a desktop width (≥1024px):
- Confirm no page-level vertical scrollbar appears when all four cards have little content.
- Confirm all four cards visually reach the bottom of the viewport.
- Seed/simulate a `Waiting on your decision` card with many rows (or check against a project/env that already has several tickets awaiting decision) and confirm only that card's content scrolls internally, with its header staying visible and pinned.
- Resize the browser window height shorter and confirm cards resize accordingly with no page scroll appearing.
- Resize the browser window to below 1024px width and confirm cards stack vertically with normal page scroll restored (the media query's mobile fallback).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/design-tokens.css apps/web/src/pages/dashboard.ts
git commit -m "feat: fill admin dashboard cards to viewport height with internal scroll"
```

---

### Task 3: Add automated regression coverage

**Files:**
- Modify: `tests/e2e/visual-sweep.spec.ts`

**Interfaces:** none — extends an existing Playwright spec's per-route assertion loop.

- [ ] **Step 1: Read the existing per-route assertion structure**

Open `tests/e2e/visual-sweep.spec.ts` and find the loop over routes × `WIDTHS` (1024/1280/1366/1425/1440) × themes, and the existing horizontal-overflow assertion (`document.documentElement.scrollWidth <= viewport`). Identify the exact route string used for the dashboard (`/admin`) in its route list.

- [ ] **Step 2: Add a vertical no-page-scroll assertion scoped to `/admin`**

Add, alongside the existing horizontal check, a conditional check that only applies to the `/admin` route at desktop widths (≥1024, matching the CSS media query breakpoint):

```ts
if (route === "/admin" && width >= 1024) {
  const scrollHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  const viewportHeight = await page.evaluate(() => window.innerHeight);
  expect(scrollHeight).toBeLessThanOrEqual(viewportHeight);
}
```
Match this to whatever variable names (`route`, `width`, `page`) the existing loop actually uses — read the real loop structure first rather than assuming these exact names.

- [ ] **Step 3: Add an equal-card-height / fill-to-bottom assertion**

```ts
if (route === "/admin" && width >= 1024) {
  const cardBoxes = await page.locator(".dashboard-rows .card").evaluateAll(
    (cards) => cards.map((c) => c.getBoundingClientRect().bottom),
  );
  const viewportHeight = await page.evaluate(() => window.innerHeight);
  // Every card's bottom edge should land within a few pixels of the viewport bottom
  // (allowing for border-box rounding), confirming they all stretch to fill it.
  for (const bottom of cardBoxes) {
    expect(Math.abs(bottom - viewportHeight)).toBeLessThan(4);
  }
}
```

- [ ] **Step 4: Run the test**

Run: `npx playwright test tests/e2e/visual-sweep.spec.ts -g "/admin"` (adjust the grep pattern to match how tests are actually titled in this file — check the `test()` call's title string format first)
Expected: PASS at all desktop widths (1024/1280/1366/1425/1440), for both themes.

- [ ] **Step 5: Run the full existing sweep to confirm no regressions on other routes**

Run: `npx playwright test tests/e2e/visual-sweep.spec.ts`
Expected: PASS — all 17 other `/admin/*` routes still pass their existing horizontal-overflow-only checks, since the new vertical assertions are conditionally scoped to `route === "/admin"` only.

- [ ] **Step 6: Commit**

```bash
git add tests/e2e/visual-sweep.spec.ts
git commit -m "test: assert admin dashboard fills viewport with no page scroll on desktop"
```

---

## Self-Review Notes

- **Spec coverage**: viewport-fill without page scroll (Task 1+2), independent per-card internal scroll with headers staying visible (Task 1's per-content flex wrappers), no hardcoded pixel height (Task 2 Step 1's `calc()` derivation), account for header height (same calc), preserve 4-column desktop layout (untouched — `grid-template-columns:repeat(auto-fit,minmax(330px,1fr))` unchanged), preserve mobile stacking (media query gate, Task 2 Step 3 verification), `min-height:0` applied correctly at every flex nesting level (Task 2 Step 1's 4 rules), regression tests (Task 3).
- **Placeholder scan**: all CSS/HTML is concrete; the one "read existing structure first" instruction (Task 3 Step 1) is a deliberate discovery step, not a placeholder, since the exact loop variable names in `visual-sweep.spec.ts` weren't captured verbatim during investigation.
- **Type consistency**: N/A (no TS types introduced — pure CSS/HTML change). Class names `dashboard-shell`/`dashboard-rows` introduced in Task 1 are consumed identically in Task 2's CSS and Task 3's Playwright selectors (`.dashboard-rows .card`).

## Execution Handoff

Plan complete and saved to `plans/03-admin-dashboard-viewport-fill.md`. Recommended: **Inline Execution** (superpowers:executing-plans) — three small, sequential tasks in two files with a manual visual-verification checkpoint in Task 2; low risk of needing a review gate between tasks.
