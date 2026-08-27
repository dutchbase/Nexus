# AI PR Review Defaults — False "internal error" on Save — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task (small, linear, single-file-cluster fix; subagent-driven-development is unnecessary overhead here). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the AI PR Review Defaults settings form from showing "internal error" after a save that actually succeeded, by (a) making the non-critical audit-log write unable to fail the response after the settings row is already persisted, (b) having the backend return the canonical saved configuration so the frontend never needs a page reload to confirm what was saved, and (c) giving the Save button a proper in-progress/duplicate-submit-safe/success-visible lifecycle.

**Architecture:** The bug is a single root cause: `POST /api/admin/settings/ai-review` in `apps/web/src/server.ts` runs `UPDATE ai_review_settings ...` (which succeeds) immediately followed by an **unguarded** `await audit(...)` call — a second, separate `INSERT INTO audit_events` with no `try/catch` and no transaction around either write. If that audit insert throws for any reason (bad FK on `actor_id`, transient connection error, serialization issue), the exception propagates uncaught all the way to the single top-level handler in `createServer(...)` (`server.ts` bottom), which stringifies *any* uncaught error without an explicit `.status` into the literal JSON `{ error: "internal error" }` at HTTP 500 — even though the settings row was already committed. The fix is to (1) treat the audit call as best-effort logging, not part of the save's success contract — wrap it in its own `try/catch` that logs via `console.error` (matching this file's existing top-level error-logging convention) and never affects the response, (2) use `RETURNING` on the `UPDATE` so the response reflects the actual persisted row instead of an echo of client input, and (3) rewrite the frontend submit handler to match the *already-established* no-reload pattern used by the ticket-level AI config form in this same file (`ui.ts` `#ai-config` handler — reuses the `.error` div to show `"Saved"` on success, no `location.reload()`), adding an in-flight guard and reconciling the form's fields from the server's canonical response.
- No DB schema change, no new endpoint, no new domain module — this is a targeted fix inside one existing route handler plus its one caller in `ui.ts`.

**Tech Stack:** TypeScript, Vitest (`vitest run --config vitest.config.ts`), Playwright (`tests/e2e/*.spec.ts`), node-postgres (`pg`), plain server-rendered HTML + vanilla client JS (no framework — template literal strings in `apps/web/src/pages/*.ts` and one big assembled script in `apps/web/src/ui.ts`).

**Spec:** This markdown file is self-contained; source task is "Fix false `internal error` when saving AI PR review defaults" (see `plans/INDEX.md` for the full original task text).

## Global Constraints

- Do not change AI review *behavior* (model/reasoning validation rules, `auto_review_enabled`/`auto_merge_on_approve` semantics, worker consumption of these settings) — only the save/response/error-reporting flow, per the source task's own "Avoid" list.
- The identical unguarded-`audit()`-after-write bug pattern also exists in the neighboring `POST /api/admin/settings/pull-request-merge` handler (`server.ts:864-869`, immediately above the handler this plan fixes). **Do not fix it as part of this plan** — it's a different settings screen, out of scope for this task — but leave a one-line comment or note it in the final report as a flagged follow-up so it isn't lost. The third sibling, `POST /api/admin/settings/system-ai` (`server.ts:891-930`), does **not** call `audit()` at all and needs no change.
- `validateAiSelection()` (`packages/domain/src/index.ts:142-155`) already throws `AiConfigurationError` (`status = 422`) for invalid model/reasoning/combination *before* any DB write — this path is already correct (the 422 message is not "internal error" because `errorEnvelope()` only substitutes the generic string for `status >= 500`). Do not change `validateAiSelection` or its call site's position (it must stay before the `UPDATE`).
- `adminApi()` (`server.ts`) has **no internal try/catch** — any thrown error from a route body propagates out of `adminApi` itself. The only place that turns a thrown error into an HTTP response is the top-level `route(request, response).catch(...)` wired in `createServer(...)` near the bottom of `server.ts`. This matters for how Task 2's tests must be written (see Task 2, Step 2's note on `AiConfigurationError`/DB-failure cases: assert on the rejected promise, not on `response.writeHead`, for errors thrown before any `json(response, ...)` call).
- Follow this file's existing logging convention: the top-level catch does `console.error(error)` for anything unhandled. The new audit `try/catch` added in Task 1 must also `console.error` the caught error (with enough context to identify it as the post-save audit failure) — never swallow it silently.
- Never expose the raw audit-insert exception (stack trace, DB error detail) to the frontend — the response must stay `{ ok: true, settings: {...} }` regardless of whether the audit write succeeded or failed.
- Reuse the exact no-reload/`.error`-div-shows-"Saved" convention already in production for the ticket AI-config form (`ui.ts` — see Task 3) rather than inventing a new success-message element or CSS class. This keeps the fix minimal and consistent with an existing, working pattern in the same file.
- Run `pnpm run verify` (or `npm run verify`) before each commit — this repo's convention is `tsc --noEmit && vitest run`.
- "Consider disabling Save when no settings have changed" (from the source task) is explicitly **not** implemented here: no other settings form in this codebase (`pull-request-merge`, `system-ai`, the ticket AI-config form) disables its Save button when the form is unchanged, so adding it only to this one form would be an inconsistent, one-off behavior. Skip it.

---

## File Structure

- **Modify:** `apps/web/src/server.ts` — lines 871-890 (the `POST /api/admin/settings/ai-review` handler): add `RETURNING` to the `UPDATE`, wrap the `audit(...)` call in `try/catch`, return `{ ok: true, settings: {...} }`.
- **Modify:** `apps/web/src/ui.ts` — lines ~626-636 (the `data-ai-review-settings-form` submit handler inside the `path==="/admin/settings"` block): replace the reload-on-success handler with an in-flight-guarded, no-reload handler that reconciles form fields from the response and shows `"Saved"`/the error text in the existing `.error` div.
- **Create:** `apps/web/src/settings-ai-review-route.test.ts` — new unit tests for the route handler (the audit-failure regression test is the one that directly encodes this bug report).
- **Modify:** `tests/e2e/ai-models.spec.ts` — extend the existing `"change the default AI review model in settings"` test (or add sibling tests) to cover `auto_review_enabled`/`auto_merge_on_approve`, the no-reload `"Saved"` message, and duplicate-submit prevention.

---

### Task 1: Make the audit-log write non-blocking and return the canonical saved settings

**Files:**
- Modify: `apps/web/src/server.ts:871-890`

**Interfaces:**
- No new exports. The JSON response shape for `POST /api/admin/settings/ai-review` changes from `{ ok: true }` to `{ ok: true, settings: { default_model, default_reasoning_level, auto_review_enabled, auto_merge_on_approve } }` on success. Error response shapes for the 400/422 branches are unchanged.

- [ ] **Step 1: Read the current handler fresh (context decay guard)**

Re-read `apps/web/src/server.ts:871-890` before editing — do not rely on the quoted version above; it is provided for orientation only.

- [ ] **Step 2: Rewrite the handler**

Replace the block at `server.ts:871-890` with:

```ts
if (url.pathname === "/api/admin/settings/ai-review" && request.method === "POST") {
  const body = await bodyOf(request);
  if (body.auto_review_enabled !== undefined && typeof body.auto_review_enabled !== "boolean") return json(response, 400, { error: "auto_review_enabled must be a boolean" });
  if (body.auto_merge_on_approve !== undefined && typeof body.auto_merge_on_approve !== "boolean") return json(response, 400, { error: "auto_merge_on_approve must be a boolean" });
  const selection = validateAiSelection({
    model: typeof body.default_model === "string" ? body.default_model : "",
    reasoning_level: typeof body.default_reasoning_level === "string" ? body.default_reasoning_level : "",
  });
  const { rows: [saved] } = await pool.query(
    `UPDATE ai_review_settings
     SET default_model=$1,default_reasoning_level=$2,
       auto_review_enabled=COALESCE($4,auto_review_enabled),
       auto_merge_on_approve=COALESCE($5,auto_merge_on_approve),
       updated_at=now(),updated_by=$3 WHERE id=1
     RETURNING default_model, default_reasoning_level, auto_review_enabled, auto_merge_on_approve`,
    [selection.model, selection.reasoning_level, session.user_id,
     body.auto_review_enabled ?? null, body.auto_merge_on_approve ?? null],
  );
  try {
    await audit({ actorType: "admin", actorId: session.user_id, action: "ai_review_settings.update", entityType: "ai_review_settings", entityId: "1", after: saved, ip: ipOf(request) });
  } catch (auditError) {
    console.error("ai_review_settings.update: settings saved but audit logging failed", auditError);
  }
  return json(response, 200, { ok: true, settings: saved });
}
```

Key changes from the current code: `RETURNING` on the `UPDATE` (so `saved` is the actual persisted row, not an echo of raw request input — this is the "re-read the saved settings server-side" requirement); the `audit(...)` call is now inside its own `try/catch` that only logs on failure; the response includes `settings: saved`.

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors. (`pool.query`'s destructured `rows: [saved]` needs no new type annotation — the existing file already destructures `pool.query` results the same way elsewhere, e.g. `server.ts` lines 842-846.)

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/server.ts
git commit -m "fix: don't fail AI PR review settings save when audit logging fails"
```

---

### Task 2: Regression tests for the route handler

**Files:**
- Create: `apps/web/src/settings-ai-review-route.test.ts`

**Interfaces:**
- Consumes: `adminApi` exported from `./server.ts` (already exported at `server.ts:699`).
- Follow the exact mocking pattern already established in `apps/web/src/approval-route-regressions.test.ts` (read that file in full first — it is the canonical template for testing `adminApi` routes in this codebase: mock `@dcc/database`'s `pool.query` via `sql.includes(...)` branching inside `mockImplementation`, build a fake `IncomingMessage` with the `request(body, method)` helper, assert on `response.writeHead`/`response.end` calls via a fake `response` object).

- [ ] **Step 1: Write the tests**

```ts
// apps/web/src/settings-ai-review-route.test.ts
import { beforeEach, expect, test, vi } from "vitest";

process.env.DCC_PROCESS_ROLE = "web";

const pool = { query: vi.fn() };
vi.mock("@dcc/database", () => ({
  artifactDataRoot: () => "/primary", legacyArtifactDataRoot: () => "/legacy",
  finalizeArtifact: vi.fn(), inTransaction: vi.fn(), pool,
  readArtifact: vi.fn(), readStagedArtifact: vi.fn(), stageArtifact: vi.fn(),
}));

const { adminApi } = await import("./server.ts");

function request(body: unknown, method = "POST") {
  return {
    method, headers: {}, socket: { remoteAddress: "127.0.0.1" },
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); },
  } as any;
}

const path = "http://test/api/admin/settings/ai-review";
const savedRow = { default_model: "haiku", default_reasoning_level: "low", auto_review_enabled: true, auto_merge_on_approve: false };

beforeEach(() => {
  pool.query.mockReset();
});

test("saving a new model and reasoning level returns the persisted row, not an echo", async () => {
  pool.query.mockImplementation(async (sql: string) => {
    if (sql.includes("UPDATE ai_review_settings")) return { rows: [savedRow] };
    if (sql.includes("INSERT INTO audit_events")) return { rows: [] };
    throw new Error(`unexpected query: ${sql}`);
  });
  const response: any = { writeHead: vi.fn(), end: vi.fn() };

  await adminApi(request({ default_model: "haiku", default_reasoning_level: "low" }), response, new URL(path), { user_id: "admin" });

  expect(response.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
  expect(response.end).toHaveBeenCalledWith(JSON.stringify({ ok: true, settings: savedRow }));
});

test("toggling auto_review_enabled and auto_merge_on_approve in one request saves successfully", async () => {
  pool.query.mockImplementation(async (sql: string, values?: unknown[]) => {
    if (sql.includes("UPDATE ai_review_settings")) {
      expect(values?.[3]).toBe(false); // auto_review_enabled
      expect(values?.[4]).toBe(true); // auto_merge_on_approve
      return { rows: [{ ...savedRow, auto_review_enabled: false, auto_merge_on_approve: true }] };
    }
    if (sql.includes("INSERT INTO audit_events")) return { rows: [] };
    throw new Error(`unexpected query: ${sql}`);
  });
  const response: any = { writeHead: vi.fn(), end: vi.fn() };

  await adminApi(request({ default_model: "haiku", default_reasoning_level: "low", auto_review_enabled: false, auto_merge_on_approve: true }), response, new URL(path), { user_id: "admin" });

  expect(response.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
});

test("a non-critical audit-log failure after a successful save still reports success (regression for the reported bug)", async () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  pool.query.mockImplementation(async (sql: string) => {
    if (sql.includes("UPDATE ai_review_settings")) return { rows: [savedRow] };
    if (sql.includes("INSERT INTO audit_events")) throw new Error("simulated audit insert failure (e.g. FK violation, transient connection error)");
    throw new Error(`unexpected query: ${sql}`);
  });
  const response: any = { writeHead: vi.fn(), end: vi.fn() };

  await adminApi(request({ default_model: "haiku", default_reasoning_level: "low" }), response, new URL(path), { user_id: "admin" });

  // The bug this regresses: before the fix, the audit exception propagated uncaught
  // out of adminApi and the top-level error handler turned it into a 500 "internal error"
  // even though the UPDATE above had already committed.
  expect(response.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
  expect(response.end).toHaveBeenCalledWith(JSON.stringify({ ok: true, settings: savedRow }));
  expect(consoleError).toHaveBeenCalled(); // the failure must be logged, not swallowed
  consoleError.mockRestore();
});

test("an invalid model is rejected before any write, and is not reported as 'internal error'", async () => {
  const response: any = { writeHead: vi.fn(), end: vi.fn() };

  // validateAiSelection throws AiConfigurationError (status 422) synchronously inside
  // the handler; adminApi has no internal try/catch, so the promise rejects here rather
  // than adminApi itself calling response.writeHead. The 422-vs-500 distinction is proven
  // by the thrown error's own `.status`, which errorEnvelope() (server.ts) reads at the
  // real HTTP layer — that layer isn't exercised by calling adminApi() directly, so this
  // test only needs to confirm the request is rejected before any DB write happens.
  await expect(adminApi(request({ default_model: "not-a-real-model", default_reasoning_level: "low" }), response, new URL(path), { user_id: "admin" }))
    .rejects.toMatchObject({ status: 422 });
  expect(pool.query).not.toHaveBeenCalled();
});

test("an invalid reasoning level is rejected before any write", async () => {
  const response: any = { writeHead: vi.fn(), end: vi.fn() };
  await expect(adminApi(request({ default_model: "haiku", default_reasoning_level: "not-a-real-level" }), response, new URL(path), { user_id: "admin" }))
    .rejects.toMatchObject({ status: 422 });
  expect(pool.query).not.toHaveBeenCalled();
});

test("a genuine persistence failure does not report success", async () => {
  pool.query.mockImplementation(async (sql: string) => {
    if (sql.includes("UPDATE ai_review_settings")) throw new Error("simulated connection failure");
    throw new Error(`unexpected query: ${sql}`);
  });
  const response: any = { writeHead: vi.fn(), end: vi.fn() };

  await expect(adminApi(request({ default_model: "haiku", default_reasoning_level: "low" }), response, new URL(path), { user_id: "admin" }))
    .rejects.toThrow("simulated connection failure");
  expect(response.writeHead).not.toHaveBeenCalledWith(200, expect.any(Object));
  expect(pool.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO audit_events"))).toBe(false); // never reached
});

test("auto_review_enabled must be a boolean", async () => {
  const response: any = { writeHead: vi.fn(), end: vi.fn() };
  await adminApi(request({ auto_review_enabled: "yes" }), response, new URL(path), { user_id: "admin" });
  expect(response.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
  expect(pool.query).not.toHaveBeenCalled();
});
```

Read `packages/domain/src/index.ts:137-140` first to confirm `AiConfigurationError`'s exact shape (`status = 422`) before writing the `.rejects.toMatchObject({ status: 422 })` assertions — match the real property name.

- [ ] **Step 2: Run the tests**

Run: `npx vitest run apps/web/src/settings-ai-review-route.test.ts`
Expected: all tests pass. If the audit-failure regression test fails before Task 1's fix is applied (it should — verify this by running it against the pre-fix code first if you're executing Task 2 before Task 1), that confirms the test actually exercises the bug.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/settings-ai-review-route.test.ts
git commit -m "test: regression coverage for AI PR review settings save (audit-failure, validation, persistence)"
```

---

### Task 3: Frontend — no-reload save with in-flight guard and canonical reconciliation

**Files:**
- Modify: `apps/web/src/ui.ts` (the `data-ai-review-settings-form` block inside `path==="/admin/settings"`, currently ~lines 626-636)

**Interfaces:**
- Consumes: the new `{ ok: true, settings: {...} }` response shape from Task 1.
- No markup change needed in `apps/web/src/pages/operate.ts` — reuse the existing `.error` div (`operate.ts:99`) for both error and success text, exactly like the established convention in this same file for the ticket AI-config form (`ui.ts`, `#ai-config` handler: `aiForm.querySelector(".error").textContent=response.ok?"Saved":result.error;`). The only addition beyond that existing pattern is inline-coloring the div green on success (that convention's `.error` class is always red via `design-tokens.css:133`, which is a minor pre-existing cosmetic issue in the ticket form too — not this plan's job to fix there, but worth getting right here since the task explicitly asks for "a clear success state").

- [ ] **Step 1: Re-read the current block fresh**

Re-read `apps/web/src/ui.ts` around the `path==="/admin/settings"` section (search for `data-ai-review-settings-form`) before editing — line numbers may have drifted.

- [ ] **Step 2: Replace the submit handler**

Replace:
```js
const form=document.querySelector("[data-ai-review-settings-form]");
if(form){
  form.addEventListener("submit",async(event)=>{
    event.preventDefault();
    const data=new FormData(form);
    const response=await fetch("/api/admin/settings/ai-review",{method:"POST",headers:{"content-type":"application/json","x-csrf-token":csrf},body:JSON.stringify({default_model:data.get("default_model"),default_reasoning_level:data.get("default_reasoning_level"),auto_review_enabled:form.querySelector('[name=auto_review_enabled]').checked,auto_merge_on_approve:form.querySelector('[name=auto_merge_on_approve]').checked})});
    if(response.ok)location.reload();else{const result=await response.json();form.querySelector(".error").textContent=result.error}
  });
}
```
with:
```js
const form=document.querySelector("[data-ai-review-settings-form]");
if(form){
  let aiReviewSaving=false;
  const aiReviewSubmit=form.querySelector('button[type="submit"]'),aiReviewError=form.querySelector(".error");
  form.addEventListener("submit",async(event)=>{
    event.preventDefault();
    if(aiReviewSaving)return;
    aiReviewSaving=true;
    if(aiReviewSubmit)aiReviewSubmit.disabled=true;
    aiReviewError.style.color="";aiReviewError.textContent="";
    const data=new FormData(form);
    try{
      const response=await fetch("/api/admin/settings/ai-review",{method:"POST",headers:{"content-type":"application/json","x-csrf-token":csrf},body:JSON.stringify({default_model:data.get("default_model"),default_reasoning_level:data.get("default_reasoning_level"),auto_review_enabled:form.querySelector('[name=auto_review_enabled]').checked,auto_merge_on_approve:form.querySelector('[name=auto_merge_on_approve]').checked})});
      const result=await response.json();
      if(response.ok){
        form.querySelector('[name=default_model]').value=result.settings.default_model;
        form.querySelector('[name=default_reasoning_level]').value=result.settings.default_reasoning_level;
        form.querySelector('[name=auto_review_enabled]').checked=result.settings.auto_review_enabled;
        form.querySelector('[name=auto_merge_on_approve]').checked=result.settings.auto_merge_on_approve;
        aiReviewError.style.color="var(--t-ok)";aiReviewError.textContent="Saved";
      }else{
        aiReviewError.textContent=result.error;
      }
    }catch(networkError){
      aiReviewError.textContent="Could not reach the server. Please retry.";
    }finally{
      aiReviewSaving=false;
      if(aiReviewSubmit)aiReviewSubmit.disabled=false;
    }
  });
}
```

Note the `aiReview`-prefixed local variable names — this block sits inside the same shared `path==="/admin/settings"` template literal as the `pull-request-merge`/`system-ai`/`ai-model-price` forms (see `ui.ts:637-660+`), which each declare their own similarly-named `const form`/`response`/`result` inside their own `if(form){...}` block scope, so there is no collision — but double-check by re-reading the surrounding 40 lines before committing, in case a sibling block was refactored to hoist any of these names to a shared outer scope since this plan was written.

- [ ] **Step 3: Manual smoke check**

This app has no component-level test harness for `ui.ts` (it's one assembled template string) — Task 4 covers automated e2e coverage. If a local dev server is easy to start (`pnpm run dev` — check `package.json`), manually load `/admin/settings`, change the model, click Save, and confirm: no page reload, "Saved" appears in green, values persist. If starting a full dev environment isn't practical in this execution context, skip this step and rely on Task 4's Playwright coverage — state explicitly in the execution report whether this manual check was performed.

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors (`ui.ts`'s client script is a plain string constant from TypeScript's point of view — `tsc` does not type-check the JS inside the template literal — so this step mainly guards against breaking the surrounding TypeScript).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/ui.ts
git commit -m "fix: save AI PR review defaults without a page reload, with a real success state"
```

---

### Task 4: Playwright regression coverage for the full save UX

**Files:**
- Modify: `tests/e2e/ai-models.spec.ts`

**Interfaces:**
- Consumes: `loginViaUI`, `queryOne` from `./helpers` (already imported in this file).

- [ ] **Step 1: Read the existing test in full**

Re-read `tests/e2e/ai-models.spec.ts:11-32` (the `"change the default AI review model in settings"` test) fresh before editing — it currently asserts `page.waitForLoadState("load")` after submit, which encodes the *old* reload behavior; this must be updated, not left in place, once Task 3 lands (leaving it as-is would still technically pass since a `<button type="submit">` without a reload just never re-triggers `load`, but `waitForLoadState("load")` on a page that never reloads can hang/timeout — replace it with a wait on the visible "Saved" text instead, matching the pattern already used at `ai-models.spec.ts:83` for the ticket AI-config form).

- [ ] **Step 2: Update the existing test and add new cases**

```ts
test("change the default AI review model in settings", async ({ page }) => {
  await page.goto("/admin/settings");
  await page.getByRole("tab", { name: "AI" }).click();
  const form = page.locator("[data-ai-review-settings-form]");
  await form.locator('select[name="default_model"]').selectOption("haiku");
  await form.locator('select[name="default_reasoning_level"]').selectOption("low");
  await form.locator('button[type="submit"]').click();

  // No reload required — the save must resolve in place.
  await expect(form.locator(".error")).toHaveText("Saved");
  await expect(form.locator('select[name="default_model"]')).toHaveValue("haiku");
  const row = await queryOne("select default_model, default_reasoning_level from ai_review_settings where id = 1");
  expect(row).toMatchObject({ default_model: "haiku", default_reasoning_level: "low" });

  // Restore the seeded default so other journeys are unaffected.
  await form.locator('select[name="default_model"]').selectOption("sonnet");
  await form.locator('select[name="default_reasoning_level"]').selectOption("high");
  await form.locator('button[type="submit"]').click();
  await expect(form.locator(".error")).toHaveText("Saved");
});

test("toggling auto-review and auto-merge on the AI PR review defaults form saves without a reload", async ({ page }) => {
  await page.goto("/admin/settings");
  await page.getByRole("tab", { name: "AI" }).click();
  const form = page.locator("[data-ai-review-settings-form]");
  const autoReview = form.locator('input[name="auto_review_enabled"]');
  const autoMerge = form.locator('input[name="auto_merge_on_approve"]');
  const initialReview = await autoReview.isChecked();
  const initialMerge = await autoMerge.isChecked();

  await autoReview.setChecked(!initialReview);
  await autoMerge.setChecked(!initialMerge);
  await form.locator('button[type="submit"]').click();

  await expect(form.locator(".error")).toHaveText("Saved");
  const row = await queryOne("select auto_review_enabled, auto_merge_on_approve from ai_review_settings where id = 1");
  expect(row).toMatchObject({ auto_review_enabled: !initialReview, auto_merge_on_approve: !initialMerge });

  // Restore.
  await autoReview.setChecked(initialReview);
  await autoMerge.setChecked(initialMerge);
  await form.locator('button[type="submit"]').click();
  await expect(form.locator(".error")).toHaveText("Saved");
});

test("clicking Save twice in quick succession only submits once", async ({ page }) => {
  await page.goto("/admin/settings");
  await page.getByRole("tab", { name: "AI" }).click();
  const form = page.locator("[data-ai-review-settings-form]");

  let requestCount = 0;
  await page.route("**/api/admin/settings/ai-review", async (route) => {
    requestCount++;
    await route.continue();
  });

  const submit = form.locator('button[type="submit"]');
  await Promise.all([submit.click(), submit.click()]);
  await expect(form.locator(".error")).toHaveText("Saved");
  expect(requestCount).toBe(1);
});
```

- [ ] **Step 3: Run the tests**

Run: `npx playwright test tests/e2e/ai-models.spec.ts`
Expected: all tests pass, including the two new ones. If Playwright/browsers aren't installed in this execution environment (`npx playwright install` may be required first — check whether this has already been provisioned before assuming it needs a fresh install), note that explicitly in the execution report rather than silently skipping.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/ai-models.spec.ts
git commit -m "test: e2e coverage for no-reload AI PR review defaults save and duplicate-submit prevention"
```

---

## Self-Review Notes

- **Spec coverage**: every bullet in the source task's Requirements/Error handling/Tests sections is covered: root-cause fix (Task 1), normalized success response with canonical persisted values (Task 1), no-refresh success state that clears stale errors (Task 3), in-progress/duplicate-submit-safe Save button (Task 3), detailed server logs without leaking internals to the UI (Task 1's `console.error`), and regression tests for every listed scenario (Tasks 2 and 4) except "unauthorized settings update", which is already covered generically by the existing `requireAdmin()` gate applied to all `/api/admin/*` routes before `adminApi` is ever reached — no per-route test is needed for that since this route adds no new authorization logic.
- **Explicitly out of scope, flagged for follow-up**: the identical unguarded-`audit()` bug in `POST /api/admin/settings/pull-request-merge` (`server.ts:864-869`). Whoever executes this plan should mention this in the final report to the user as a candidate for a small follow-up fix, without doing it here.
- **Placeholder scan**: no TODOs or invented APIs — every function/column/convention referenced (`validateAiSelection`, `AiConfigurationError`, `audit()`, the `.error` div reuse pattern, `RETURNING`) already exists in the codebase today and was confirmed by direct investigation, not assumed.
- **Type consistency**: the response shape change (`{ ok: true }` → `{ ok: true, settings: {...} }`) is additive/backward-compatible — nothing else in the codebase reads this endpoint's response body today (confirmed: only `ui.ts`'s own submit handler, which Task 3 updates in lockstep).

## Execution Handoff

Plan complete and saved to `plans/08-ai-pr-review-defaults-save-error.md`. Recommended: **Inline Execution** (superpowers:executing-plans) — four small, linear tasks with a single clear root cause; no multi-task review checkpoints needed.
