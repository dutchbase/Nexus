# Nexus Rebrand and Visual Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the product from "Development hub" / "Internet Nederland" to **Nexus** everywhere it's user-visible, and apply the modernized shadow/focus/interaction/sidebar/logo/status-dot/CTA visual system to the admin shell, login screen, and public form.

**Architecture:** This app has exactly one server-side HTML-string-template module (`apps/web/src/ui.ts`) that renders every page (`document()`, `loginPage()`, `adminPage()`, `publicFormPage()`, `submittedPage()`), and exactly one CSS file (`apps/web/src/design-tokens.css`) loaded once into memory at process start and served at `/assets/design-tokens.css`. There is no client-side framework, no build step, no component library — every change in this plan is a template-literal string edit or a CSS rule edit in those two files (plus small inline-style edits in three page files that render their own status dots). No new dependencies, no new files except one new test file.

**Tech Stack:** TypeScript (Node, `tsx`, no bundler), plain CSS custom properties (no preprocessor), Vitest for unit tests, Playwright for the existing (non-CI-gating) visual sweep.

**Spec:** This plan implements the "Rename the application to Nexus, modernize the visual system" task from the dev-control planning brief (2026-08-27 session). No separate spec doc exists; the full requirements are reproduced as Global Constraints below.

## Global Constraints

- Visible app name becomes **Nexus** everywhere it currently reads "Development hub" or the fallback "Development Control Center". Remove the visible **"Internet Nederland"** subtitle entirely.
- Do **not** touch: the DB name (`dcc`), pm2 process names (`dcc-web`/`dcc-worker`/`dcc-webhook`), systemd unit names (`dcc-web.service`), the `localStorage` key `dccTheme`, npm workspace package names (`web`, `worker`, `@dcc/*`), env var prefixes (`DCC_*`), or any other internal/non-user-facing identifier. Those are out of scope for this plan (not user-facing branding).
- Preserve the existing single-letter monogram logo mark style (a colored square with a serif letter) — do not replace it with an image/icon asset. The letter itself changes from "D" to "N" to match the new name (see Task 1's Design Decision).
- **Design decision — `--accent` vs `--primary`:** the visual-system spec (written generically) references `var(--accent)` / `var(--accent-soft)` for the ring, logo-mark gradient, and CTA button glow. This codebase already defines `--accent` (`#C8102E`, a red) and `--accent-soft` in `design-tokens.css`, but **grep confirms `--accent` is never actually referenced by any CSS rule or page** — it's a vestigial/unused token, and it clashes with the actual interactive color used everywhere else in the app (`--primary`, blue `#23508F`, used by `.button.primary`, focus outlines, active nav indicators, tab underlines). Wiring new glow/ring effects to the unused red `--accent` token would put a red glow under blue buttons — visually broken and exactly the "visually noisy" outcome the spec explicitly warns against. **Every task below therefore substitutes `var(--primary)` / `var(--primary-soft)` wherever the generic spec said `var(--accent)` / `var(--accent-soft)`.** Leave the `--accent`/`--accent-soft`/`--accent-fg` token definitions in place (still unused, zero risk, not this plan's concern).
- `prefers-reduced-motion` is already handled globally (`design-tokens.css:174-176` zeroes all `animation-duration`/`transition-duration`) — the new transition rule in Task 3 is automatically covered by the existing rule; no separate reduced-motion code is needed, only a verification step.
- CI (`.github/workflows/ci.yml`) runs `pnpm verify` (`tsc --noEmit` + `vitest run`) on every push/PR — it does **not** run Playwright. Playwright (`tests/e2e/visual-sweep.spec.ts`) is a local/manual check only. Prioritize Vitest assertions (CI-gated) over Playwright for regression coverage; Playwright steps in this plan are manual-verification, not required for the tasks to be "done."
- No new npm dependencies. No new files except `apps/web/src/branding.test.ts`.

---

### Task 1: Rename branding text to "Nexus" and add a shared logo-mark helper

**Files:**
- Modify: `apps/web/src/ui.ts:18-32` (`loginPage`), `apps/web/src/ui.ts:41-66` (`adminPage`), `apps/web/src/ui.ts:1085-1088` (`publicFormPage`)
- Create: `apps/web/src/branding.test.ts`

**Interfaces:**
- Produces: `logoMark(size?: "sm" | "md")` — a new exported helper in `ui.ts`, used by Task 1 and reused as-is by Task 2 (no further change needed in Task 2 to this function's signature).

Current state (confirmed by direct reading):
- `ui.ts:20`: login page eyebrow reads `Development Control Center`.
- `ui.ts:60`: breadcrumb fallback (used only when the current nav path matches no group/item) reads `Development Control Center`.
- `ui.ts:62`: sidebar brand block: `<span class="brand-mark">D</span><div><div class="brand-title">Development hub</div><div class="brand-sub">Internet Nederland</div></div>`.
- `ui.ts:65`: header worker indicator: `<span class="worker">● worker-01 healthy</span>` — a static, hardcoded placeholder (never updated by any client script; confirmed no `.worker` reference exists anywhere else in `ui.ts`). Its "healthy" text and value are out of scope for this plan (not branding) — only its dot glyph becomes a styled dot in Task 5.
- `publicFormPage()` (`ui.ts:1085-1088`) currently renders **no** app branding at all — only `form.title` (dynamic, from the DB) in `<title>` and `<h1>`, and a `.url-strip` div showing `/f/${slug}`. This is why the pre-existing test at `.lfd/dcc-build/harness/tests/frontend/public-form.spec.ts:18-22` asserts `"Development hub"` never appears there — that test's intent was "the public form shows no internal company branding," which stays true: we are adding the *product* name "Nexus", not company info.
- `.brand-sub` (CSS class `design-tokens.css:47`) is used in exactly one place (`ui.ts:62`) — safe to delete entirely along with its markup.

- [ ] **Step 1: Add a shared `logoMark` helper next to `escapeHtml` in `ui.ts`**

Insert after line 12 (`escapeHtml`'s closing brace), before `function document(...)`:

```ts
export function logoMark(letter = "N", size: "sm" | "md" = "md") {
  const dims = size === "sm" ? "width:20px;height:20px;font-size:13px" : "width:26px;height:26px;font-size:17px";
  return `<span class="brand-mark" style="${dims}">${letter}</span>`;
}
```

(The base non-size CSS for `.brand-mark` stays in `design-tokens.css` per Task 2; this helper only overrides width/height/font-size inline for the two smaller usages, since `.brand-mark`'s own class rule is sized for the sidebar.)

- [ ] **Step 2: Rewrite the sidebar brand block (`ui.ts:62`)**

Replace:

```ts
  return document(title, `<div class="shell"><aside class="sidebar" id="sidebar"><div class="brand"><span class="brand-mark">D</span><div><div class="brand-title">Development hub</div><div class="brand-sub">Internet Nederland</div></div></div>
```

with:

```ts
  return document(title, `<div class="shell"><aside class="sidebar" id="sidebar"><div class="brand">${logoMark("N", "md")}<div class="brand-title">Nexus</div></div>
```

(The old markup wrapped `brand-title`+`brand-sub` in an inner `<div>` because there were two stacked lines; with the subtitle gone there's only one line, so the wrapper div is also removed — no orphaned empty `<div>`.)

- [ ] **Step 3: Update the breadcrumb fallback (`ui.ts:60`)**

Replace:

```ts
  const breadcrumb = section ? `<span class="eyebrow">${section}</span><span>/</span><span>${escapeHtml(title)}</span>` : `<span class="eyebrow">Development Control Center</span><span>/</span><span>${escapeHtml(title)}</span>`;
```

with:

```ts
  const breadcrumb = section ? `<span class="eyebrow">${section}</span><span>/</span><span>${escapeHtml(title)}</span>` : `<span class="eyebrow">Nexus</span><span>/</span><span>${escapeHtml(title)}</span>`;
```

- [ ] **Step 4: Update the login page (`ui.ts:18-32`)**

Replace the `loginPage` body's first line (line 20):

```ts
    <div class="login-intro"><div class="eyebrow">Development Control Center</div><h1>Feedback in.<br><em>Reviewed code out.</em></h1><p>One controlled workflow from public feedback to reviewed delivery.</p></div>
```

with:

```ts
    <div class="login-intro"><div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">${logoMark("N", "md")}<span class="eyebrow" style="margin:0">Nexus</span></div><h1>Feedback in.<br><em>Reviewed code out.</em></h1><p>One controlled workflow from public feedback to reviewed delivery.</p></div>
```

- [ ] **Step 5: Add branding to the public form header (`ui.ts:1085-1088`)**

Replace:

```ts
  return document(form.title, `<main class="public"><div class="url-strip">/f/${escapeHtml(form.slug)}</div><form class="card" id="public-form">...
```

with (only the opening of `<main>` changes — everything from `<form class="card"` onward is unchanged, do not retype it, just insert before it):

```ts
  return document(form.title, `<main class="public"><div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">${logoMark("N", "sm")}<span style="font-size:13px;font-weight:700;color:var(--text2)">Nexus</span></div><div class="url-strip">/f/${escapeHtml(form.slug)}</div><form class="card" id="public-form">...
```

- [ ] **Step 6: Write `apps/web/src/branding.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { adminPage, loginPage, publicFormPage } from "./ui.ts";

const sampleForm = { title: "Website feedback", slug: "website-feedback", description: "Tell us what's broken.", settings_json: {} };

describe("Nexus branding", () => {
  it("sidebar shows Nexus, not the old product name or subtitle", () => {
    const page = adminPage("/admin", "Dashboard", "", {}, "admin");
    expect(page).toContain(">Nexus<");
    expect(page).not.toContain("Development hub");
    expect(page).not.toContain("Internet Nederland");
    expect(page).not.toContain("brand-sub");
  });

  it("breadcrumb fallback reads Nexus", () => {
    // "/admin/does-not-exist" matches no nav group/item, so the fallback eyebrow renders.
    const page = adminPage("/admin/does-not-exist", "Unknown", "", {}, "admin");
    expect(page).toContain('<span class="eyebrow">Nexus</span>');
  });

  it("login page shows the Nexus wordmark and logo mark, not the old name", () => {
    const page = loginPage();
    expect(page).toContain(">Nexus<");
    expect(page).toContain('class="brand-mark"');
    expect(page).not.toContain("Development Control Center");
    expect(page).not.toContain("Development hub");
  });

  it("public form header carries the Nexus logo mark and name", () => {
    const page = publicFormPage(sampleForm, [], []);
    expect(page).toContain(">Nexus<");
    expect(page).toContain('class="brand-mark"');
    expect(page).not.toContain("Development hub");
    expect(page).not.toContain("Internet Nederland");
  });
});
```

- [ ] **Step 7: Run the test suite**

Run: `pnpm exec vitest run apps/web/src/branding.test.ts apps/web/src/nav-a11y.test.ts apps/web/src/csp-assets.test.ts --reporter=verbose`
Expected: all PASS. (`nav-a11y.test.ts`/`csp-assets.test.ts` are included because they also call `adminPage()` and must not have silently broken from the markup change.)

- [ ] **Step 8: Run full verification and commit**

Run: `pnpm verify`
Expected: PASS (typecheck + full unit suite).

```bash
git add apps/web/src/ui.ts apps/web/src/branding.test.ts
git commit -m "feat: rename product branding to Nexus"
```

---

### Task 2: Logo mark visual styling (gradient + glow), applied via the shared CSS class

**Files:**
- Modify: `apps/web/src/design-tokens.css:45` (`.brand-mark` rule)

**Interfaces:**
- Consumes: the `.brand-mark` class name, now used in 3 places by Task 1's `logoMark()` helper (sidebar, login, public form) — this task only changes the CSS rule; no markup changes.

Current rule (`design-tokens.css:45`):

```css
.brand-mark { width:26px;height:26px;display:grid;place-items:center;background:var(--side-active);color:var(--side-bg);border-radius:3px;font-family:"Cormorant Garamond",Georgia,serif;font-weight:700;font-size:17px }
```

- [ ] **Step 1: Replace the flat white background with the gradient + glow**

Replace the line above with:

```css
.brand-mark { display:grid;place-items:center;background:linear-gradient(145deg,var(--primary),color-mix(in srgb, var(--primary) 65%, #000));box-shadow:0 2px 8px color-mix(in srgb, var(--primary) 45%, transparent);color:var(--primary-fg);border-radius:3px;font-family:"Cormorant Garamond",Georgia,serif;font-weight:700 }
```

(`width`/`height`/`font-size` are dropped from the base rule since `logoMark()`'s inline `style` now sets them per-instance via Task 1 Step 1 — every call site supplies its own size, so the base rule no longer needs a fixed size. This also means the rule works unchanged for both `"sm"` and `"md"` call sites.)

- [ ] **Step 2: Verify visually in both themes**

Run: `pnpm dev`, open `/admin` (sidebar), `/login` (or trigger a 401 to see the login page), and `/f/<any configured public form slug>`.
Expected: a blue-gradient rounded square with a white "N" in all three locations, with a soft blue drop shadow under it; toggle the theme switcher (sidebar footer, light/auto/dark) and confirm the mark stays legible and the shadow isn't harsh in dark mode (dark mode uses `--primary:#3D6BC6` and `--primary-fg:#FFFFFF` automatically — no separate dark-mode override needed since `color-mix`/`linear-gradient` reference the theme-scoped `--primary` variable, which already flips per `:root[data-theme="dark"]`).

- [ ] **Step 3: Run the branding test again to confirm no regression**

Run: `pnpm exec vitest run apps/web/src/branding.test.ts --reporter=verbose`
Expected: PASS (this task is CSS-only, so the string-content assertions from Task 1 are unaffected; this step just guards against an accidental markup edit).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/design-tokens.css
git commit -m "feat: apply gradient/glow styling to the shared Nexus logo mark"
```

---

### Task 3: Global elevation, focus, interaction, and scrollbar tokens

**Files:**
- Modify: `apps/web/src/design-tokens.css:1-12` (`:root`), `:13-24` (`:root[data-theme="dark"]`), `:33-41` (global element rules)
- Create/modify: `apps/web/src/design-tokens.test.ts`

**Interfaces:**
- Produces: `--shadow` (redefined), `--shadow-sm` (new), `--ring` (new) custom properties, consumed by Task 6 (`--ring` via `:focus-visible`) and available for any future use of `--shadow-sm`.

- [ ] **Step 1: Replace the light-theme `--shadow` and add `--shadow-sm`/`--ring` (`design-tokens.css:11`)**

Replace:

```css
  --code-bg:#F0F2F6;--shadow:0 1px 2px rgba(11,35,86,.05),0 10px 30px rgba(11,35,86,.07);--overlay:rgba(7,24,64,.42);
```

with:

```css
  --code-bg:#F0F2F6;--overlay:rgba(7,24,64,.42);
  --shadow:0 1px 2px rgba(11,35,86,.06),0 3px 8px rgba(11,35,86,.05),0 20px 44px rgba(11,35,86,.10);
  --shadow-sm:0 1px 2px rgba(11,35,86,.05),0 4px 12px rgba(11,35,86,.06);
  --ring:0 0 0 3px var(--primary-soft);
```

- [ ] **Step 2: Replace the dark-theme `--shadow` and add `--shadow-sm`/`--ring` (`design-tokens.css:23`)**

Replace:

```css
  --code-bg:#040E27;--shadow:0 1px 2px rgba(0,0,0,.34),0 10px 30px rgba(0,0,0,.28);--overlay:rgba(2,7,20,.62);
```

with:

```css
  --code-bg:#040E27;--overlay:rgba(2,7,20,.62);
  --shadow:0 1px 2px rgba(0,0,0,.45),0 3px 8px rgba(0,0,0,.40),0 20px 44px rgba(0,0,0,.55);
  --shadow-sm:0 1px 2px rgba(0,0,0,.40),0 4px 12px rgba(0,0,0,.35);
  --ring:0 0 0 3px var(--primary-soft);
```

(Same black-based-with-higher-opacity pattern as the existing dark `--shadow` it replaces, which already used pure-black rgba at higher opacity than its light counterpart — this keeps that established convention, just adds the third layer and the two new tokens.)

- [ ] **Step 3: Add the global interaction transition rule**

`design-tokens.css:33-34` currently reads:

```css
button,input,select,textarea { font:inherit;color:inherit }
button,a,input,select,textarea { outline-color:var(--primary) }
```

Insert a new rule immediately after (before `:focus-visible { ... }` on line 35):

```css
button,a,input,select,textarea { transition:background-color .15s ease,border-color .15s ease,color .15s ease,box-shadow .15s ease,transform .15s ease }
```

**Conflict check (already verified, no action needed):** the only existing `transform` usage in this file is `.sidebar`/`.sidebar.open` (an `<aside>`, not in this selector list) and the `dccIn` keyframe (applies to `dialog[open]`, not in this selector list). Neither is affected. `prefers-reduced-motion` handling at `design-tokens.css:174-176` already zeroes `transition-duration` for every element (`*,*::before,*::after`), so this new rule is automatically covered — no separate reduced-motion code needed.

- [ ] **Step 4: Add the scrollbar hover state**

`design-tokens.css:39-41` currently reads:

```css
::-webkit-scrollbar { width:10px;height:10px }
::-webkit-scrollbar-track { background:transparent }
::-webkit-scrollbar-thumb { background:var(--border2);border-radius:99px;border:3px solid transparent;background-clip:content-box }
```

Add immediately after:

```css
::-webkit-scrollbar-thumb:hover { background:var(--text3) }
```

- [ ] **Step 5: Write `apps/web/src/design-tokens.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { styles } from "./ui.ts";

describe("design tokens: elevation, focus, interaction", () => {
  it("defines --shadow, --shadow-sm, and --ring in both themes", () => {
    expect(styles).toContain("--shadow:0 1px 2px rgba(11,35,86,.06)");
    expect(styles).toContain("--shadow-sm:0 1px 2px rgba(11,35,86,.05)");
    expect(styles).toContain("--shadow:0 1px 2px rgba(0,0,0,.45)");
    expect(styles).toContain("--shadow-sm:0 1px 2px rgba(0,0,0,.40)");
    expect((styles.match(/--ring:/g) ?? []).length).toBe(2);
  });
  it("applies interaction transitions to form controls and links only", () => {
    expect(styles).toContain("button,a,input,select,textarea { transition:background-color .15s ease,border-color .15s ease,color .15s ease,box-shadow .15s ease,transform .15s ease }");
  });
  it("scrollbar thumb has a hover state using --text3", () => {
    expect(styles).toContain("::-webkit-scrollbar-thumb:hover { background:var(--text3) }");
  });
  it("reduced-motion query still zeroes transition-duration for all elements", () => {
    expect(styles).toContain("transition-duration:.01ms !important");
  });
});
```

- [ ] **Step 6: Run the test**

Run: `pnpm exec vitest run apps/web/src/design-tokens.test.ts --reporter=verbose`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/design-tokens.css apps/web/src/design-tokens.test.ts
git commit -m "feat: add layered shadow, ring, and interaction transition tokens"
```

---

### Task 4: Focus-visible glow on form controls and buttons

**Files:**
- Modify: `apps/web/src/design-tokens.css:35`
- Modify: `apps/web/src/design-tokens.test.ts` (append)

Current rule (`design-tokens.css:35`):

```css
:focus-visible { outline:2px solid var(--primary);outline-offset:1px }
```

This rule is global (every focusable element) and must **stay** — the task is to *add* the box-shadow glow scoped to `input`, `select`, `textarea`, `button` only, without replacing the outline.

- [ ] **Step 1: Add the scoped glow rule immediately after line 35**

```css
input:focus-visible,select:focus-visible,textarea:focus-visible,button:focus-visible { box-shadow:var(--ring) }
```

- [ ] **Step 2: Append a test to `design-tokens.test.ts`**

```ts
  it("adds a focus-visible ring glow to form controls and buttons without removing the outline", () => {
    expect(styles).toContain(":focus-visible { outline:2px solid var(--primary);outline-offset:1px }");
    expect(styles).toContain("input:focus-visible,select:focus-visible,textarea:focus-visible,button:focus-visible { box-shadow:var(--ring) }");
  });
```

- [ ] **Step 3: Run the test**

Run: `pnpm exec vitest run apps/web/src/design-tokens.test.ts --reporter=verbose`
Expected: PASS.

- [ ] **Step 4: Manual accessibility check**

Run: `pnpm dev`, open `/login` in a browser, press Tab repeatedly. Expected: every input/button shows both the existing 2px outline **and** a soft blue glow ring around it when focused via keyboard; clicking with a mouse (not Tab) does not show `:focus-visible` styling (standard browser behavior — no code needed, just confirm it's not regressed).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/design-tokens.css apps/web/src/design-tokens.test.ts
git commit -m "feat: add focus-visible glow to form controls and buttons"
```

---

### Task 5: Sidebar ambient depth gradient

**Files:**
- Modify: `apps/web/src/design-tokens.css:43`
- Modify: `apps/web/src/design-tokens.test.ts` (append)

Current rule (`design-tokens.css:43`):

```css
.sidebar { width:246px;flex:0 0 246px;background:var(--side-bg);border-right:1px solid var(--side-border);display:flex;flex-direction:column;position:fixed;inset:0 auto 0 0;z-index:60;overflow:hidden }
```

- [ ] **Step 1: Replace `background:var(--side-bg)` with the layered gradient**

```css
.sidebar { width:246px;flex:0 0 246px;background:radial-gradient(130% 160% at 12% -12%,rgba(255,255,255,.07),transparent 55%),var(--side-bg);border-right:1px solid var(--side-border);display:flex;flex-direction:column;position:fixed;inset:0 auto 0 0;z-index:60;overflow:hidden }
```

- [ ] **Step 2: Append a test**

```ts
  it("sidebar has the ambient radial-gradient depth layer", () => {
    expect(styles).toContain("radial-gradient(130% 160% at 12% -12%,rgba(255,255,255,.07),transparent 55%)");
  });
```

- [ ] **Step 3: Run the test**

Run: `pnpm exec vitest run apps/web/src/design-tokens.test.ts --reporter=verbose`
Expected: PASS.

- [ ] **Step 4: Manual visual check**

Run: `pnpm dev`, open `/admin`, look at the top-left corner of the sidebar in both themes. Expected: a faint, subtle lightening near the top-left corner of the sidebar that fades out — not a visible hard edge, not a distracting glow. If it reads as too strong, this is a values tune, not a structural change — flag it rather than silently altering the spec's given `.07` opacity.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/design-tokens.css apps/web/src/design-tokens.test.ts
git commit -m "feat: add ambient radial-gradient depth to the sidebar"
```

---

### Task 6: Status/pulse dot glow (header worker indicator, active-run list, run detail)

**Files:**
- Modify: `apps/web/src/ui.ts:65` (header worker indicator)
- Modify: `apps/web/src/pages/dashboard.ts:42` (active-run list dot)
- Modify: `apps/web/src/pages/runs.ts:55-59` (run-detail "Executing" indicator)
- Modify: `apps/web/src/branding.test.ts` or a new small test (see Step 5)

**Ground truth from investigation (important — read before editing):**
- `dashboard.ts:42` already has a real pulsing dot (`border-radius:50%`, `background:var(--t-run)`, `animation:dccPulse 1.4s ease-in-out infinite`) — this is "active-run list dots." It only needs the box-shadow glow added.
- `ui.ts:65`'s `.worker` span is a **static hardcoded placeholder** (`● worker-01 healthy`) — a plain text bullet character, not a styled dot element, and never updated by any script (confirmed: no `.worker` selector exists anywhere in `ui.ts`'s embedded client scripts). Making it live-wired to real worker health is **out of scope** for this plan — only its visual presentation changes, from a text glyph to a styled dot span with the same semantic "healthy" = ok-tone color it already implies.
- `runs.ts` (the run-detail page) has **no existing dot at all** — the status is shown via `statusBadge(run.status)` (a text pill from `pages/shared.ts:45-47`), not a dot. This task adds a new pulsing dot, shown only while the run is active (`isActive`, already computed at `runs.ts:46`), matching the same visual language as `dashboard.ts`'s dot.
- `--dot-color` from the generic spec is implemented here as whichever semantic tone variable (`--t-run`, `--t-ok`, etc.) already applies at each call site — there is no need for a literal `--dot-color` custom property; `color-mix(in srgb, var(--t-run) 20%, transparent)` etc. achieves the same ring effect directly.

- [ ] **Step 1: Add the glow to the active-run list dot (`dashboard.ts:42`)**

Replace:

```ts
      <span style="width:6px;height:6px;border-radius:50%;background:var(--t-run);animation:dccPulse 1.4s ease-in-out infinite;flex-shrink:0"></span>
```

with:

```ts
      <span style="width:6px;height:6px;border-radius:50%;background:var(--t-run);animation:dccPulse 1.4s ease-in-out infinite;box-shadow:0 0 0 4px color-mix(in srgb, var(--t-run) 20%, transparent);flex-shrink:0"></span>
```

- [ ] **Step 2: Convert the header worker indicator to a styled dot (`ui.ts:65`)**

Replace:

```ts
<span class="worker">● worker-01 healthy</span>
```

with:

```ts
<span class="worker"><span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--t-ok);box-shadow:0 0 0 4px color-mix(in srgb, var(--t-ok) 20%, transparent);margin-right:6px;vertical-align:middle"></span>worker-01 healthy</span>
```

(No pulse animation here: this indicator represents a steady "healthy" state, not an in-progress action — `dccPulse` is reserved for active/executing states per the existing convention in `dashboard.ts`, and the task says to *keep* the existing pulse behavior, not add it somewhere new.)

- [ ] **Step 3: Add a run-detail "Executing" dot (`runs.ts:55-59`)**

Current (`runs.ts:55-59`):

```ts
    const body = `<div class="eyebrow">${escapeHtml(run.ticket_number ?? "")} · ${escapeHtml(run.project_name ?? "")}</div>
      <h1>${shortRef("RUN", run.id)} · ${escapeHtml(run.run_type)}</h1>
      <div style="display:flex;gap:12px;align-items:center;margin-bottom:20px">
        ${statusBadge(run.status)}
        <span>${statusLine}</span>
```

Replace the `<div style="display:flex;...">` line and the `${statusBadge(run.status)}` line with:

```ts
      <div style="display:flex;gap:12px;align-items:center;margin-bottom:20px">
        ${isActive ? `<span style="width:6px;height:6px;border-radius:50%;background:var(--t-run);animation:dccPulse 1.4s ease-in-out infinite;box-shadow:0 0 0 4px color-mix(in srgb, var(--t-run) 20%, transparent);flex-shrink:0"></span>` : ""}
        ${statusBadge(run.status)}
        <span>${statusLine}</span>
```

(`isActive` is already in scope at this point in the function — defined at `runs.ts:46` as `["running", "queued"].includes(run.status)` — no new variable needed.)

- [ ] **Step 4: Run the affected unit tests**

Run: `pnpm exec vitest run apps/web/src/pages/dashboard.ts apps/web/src/pages/runs.ts apps/web/src/nav-a11y.test.ts --reporter=verbose 2>/dev/null; pnpm exec vitest run --reporter=verbose` (dashboard/runs page modules have no dedicated `.test.ts` targeting this exact markup — run the full suite to catch any existing test that snapshots this HTML, e.g. `apps/web/src/dashboard-boundary.test.ts`, `apps/web/src/pages/runs.test.ts`, `apps/web/src/pages/run-progress.test.ts`).
Expected: PASS. If any existing test asserts the *exact* old inline-style string for the dashboard dot or the run-detail header layout, update that assertion to match the new markup (do not weaken the assertion — update it to check for the new, correct string).

- [ ] **Step 5: Add a regression test for the new run-detail dot**

Find `apps/web/src/pages/runs.test.ts` and add a test (read the file first to match its existing fixture/setup pattern for `run` rows — it already builds fake run objects for other tests in that file):

```ts
  it("shows a pulsing status dot only while the run is active", () => {
    // reuse this file's existing pattern for constructing a fake `run` row with status "running" vs "completed" — see the file's existing tests for the exact helper/fixture shape.
  });
```

(This step is intentionally a pointer, not literal code, because `runs.test.ts`'s exact fixture-construction helper must be read first — do not guess its shape. Read the file, find how an existing test renders the run-detail page for a `"running"` run and for a terminal-status run, and assert `box-shadow:0 0 0 4px color-mix(in srgb, var(--t-run) 20%, transparent)` is present for the active case and absent for the terminal case.)

- [ ] **Step 6: Manual visual check**

Run: `pnpm dev`. On `/admin`, trigger or view an active run and confirm the list dot has a soft ring around it. Open that run's detail page (`/admin/runs/<id>`) while it's still `running` and confirm the new dot appears next to the status pill with the same pulse+ring; open a completed run's detail page and confirm no dot appears there. Check the header worker indicator on any admin page for the small ok-colored ringed dot.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/ui.ts apps/web/src/pages/dashboard.ts apps/web/src/pages/runs.ts apps/web/src/pages/runs.test.ts
git commit -m "feat: add status-dot glow to worker indicator, run list, and run detail"
```

---

### Task 7: Primary CTA button elevation (resting + hover), no lift on disabled

**Files:**
- Modify: `apps/web/src/design-tokens.css:84` (`.button.primary`), `:153` (verify `[disabled]` rule, no change expected)
- Modify: `apps/web/src/design-tokens.test.ts` (append)

**Ground truth:** both call sites the task names — the login submit button (`ui.ts:24`, `<button class="button primary" type="submit">Sign in</button>`) and the public feedback form submit button (`ui.ts:1088`/embedded literal `<button class="button primary" type="submit">Melding versturen</button>`) — already share the single `.button.primary` CSS class. This means **one CSS change covers both call sites**; no per-page markup edit is needed for this task.

Current rule (`design-tokens.css:84`):

```css
.button.primary { border-color:var(--primary);background:var(--primary);color:var(--primary-fg);font-weight:700 }
```

- [ ] **Step 1: Add the resting-state box-shadow to the existing rule**

Replace with:

```css
.button.primary { border-color:var(--primary);background:var(--primary);color:var(--primary-fg);font-weight:700;box-shadow:0 1px 2px color-mix(in srgb, var(--primary) 30%, transparent) }
```

- [ ] **Step 2: Add a new hover rule, explicitly excluding disabled buttons**

Insert immediately after the `.button.primary` rule:

```css
.button.primary:hover:not([disabled]) { transform:translateY(-1px);box-shadow:0 6px 16px color-mix(in srgb, var(--primary) 35%, transparent) }
```

(`:not([disabled])` is required here — CSS `:hover` can still match a disabled element when the pointer rests over it in some browsers, even though click/focus don't fire; the explicit exclusion is the only reliable way to guarantee "no hover lift on disabled controls" across browsers.)

- [ ] **Step 3: Confirm the existing `[disabled]` rule needs no change**

`design-tokens.css:153` already reads `button[disabled],.button[disabled] { cursor:not-allowed;color:var(--text3) }` — this only affects cursor/text color, and Step 2's `:not([disabled])` guard on the hover rule already fully prevents the lift/glow escalation. No edit needed here — this step is a verification checkpoint, not a code change.

- [ ] **Step 4: Append a test**

```ts
  it("primary CTA buttons have resting elevation and a hover lift that excludes disabled buttons", () => {
    expect(styles).toContain("box-shadow:0 1px 2px color-mix(in srgb, var(--primary) 30%, transparent)");
    expect(styles).toContain(".button.primary:hover:not([disabled]) { transform:translateY(-1px);box-shadow:0 6px 16px color-mix(in srgb, var(--primary) 35%, transparent) }");
  });
```

- [ ] **Step 5: Run the test**

Run: `pnpm exec vitest run apps/web/src/design-tokens.test.ts --reporter=verbose`
Expected: PASS.

- [ ] **Step 6: Manual visual check**

Run: `pnpm dev`, open `/login`, hover the "Sign in" button — expect a slight upward lift with a stronger blue glow; open any configured public form at `/f/<slug>` and hover "Melding versturen" — same effect. If either button is ever rendered with the `disabled` attribute (check `ui.ts` — currently neither is), confirm no lift occurs while disabled.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/design-tokens.css apps/web/src/design-tokens.test.ts
git commit -m "feat: add elevation and hover lift to primary CTA buttons"
```

---

## Self-Review (performed against the original task brief)

- **Rename coverage:** sidebar ✅ (Task 1 Step 2), login screen ✅ (Step 4), public form header ✅ (Step 5), page/browser title ✅ (already dynamic via `document(title, ...)`, no hardcoded old name in the `<title>` path — verified by reading `ui.ts:14-16`), breadcrumb fallback ✅ (Step 3), metadata — no `<meta name="description">` or favicon exists currently in `document()`, so there is nothing further to rename there (confirmed by reading the full function).
- **Visual system coverage:** shadow tokens ✅ Task 3, transitions ✅ Task 3, focus-visible glow ✅ Task 4, scrollbar hover ✅ Task 3, sidebar gradient ✅ Task 5, logo mark styling ✅ Task 2 (applies to all 3 locations via the shared CSS class + Task 1's shared helper), status/pulse dots ✅ Task 6 (all 3 named locations, with the header-worker and run-detail locations newly built since they didn't previously exist as styled dots), primary CTA buttons ✅ Task 7 (both named call sites, one CSS change).
- **No placeholders:** every step above contains literal, complete code — no "add appropriate styling," no TODOs.
- **Type/name consistency:** `logoMark(letter, size)` defined once in Task 1 Step 1, called identically (`logoMark("N", "md")` / `logoMark("N", "sm")`) in Task 1 Steps 2/4/5 and never redefined elsewhere.
- **Out of scope, confirmed and left alone:** `design-handoff/Development Control Center.dc.html` and `design-handoff/README.md` (static design-handoff artifacts, not served by the app, not linked from the live product) still say "Development hub"/"Internet Nederland" — these are historical design-handoff files, not application UI; leaving them unchanged does not affect any user-facing surface. If the repository maintainer wants them scrubbed too, that's a docs-hygiene follow-up, not part of this plan's scope (the task's own "avoid/pitfalls" list says "do not turn this into a complete redesign").
