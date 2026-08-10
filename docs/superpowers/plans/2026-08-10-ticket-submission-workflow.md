# Ticket Submission Editing and Workflow Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Let administrators edit every non-attachment field from a ticket's source form, and show one clear workflow action set at the top of each ticket.

**Architecture:** Extract the existing form-control markup into one reusable renderer. The ticket editor uses the ticket's source-form fields and submits them as a separate `submission` payload. The existing planning, plan review, revision, and execution endpoints remain unchanged.

**Tech Stack:** TypeScript, server-rendered HTML, native browser form controls, Vitest, Playwright.

## Global Constraints

- Do not add dependencies or database migrations.
- Keep existing attachments visible and read-only.
- Do not expose static or hidden source-form fields in the admin editor.
- Do not change plan or execution API endpoints.
- Work on a feature branch; never commit directly to `main` or `master`.

---

### Task 1: Reusable source-form controls

**Files:** `apps/web/src/ui.ts`, `apps/web/src/ticket-submission-form.test.ts`

**Interface:** Produce `formControls(fields, projects, values, mode)` for public forms and admin ticket editing. `mode` is `"public"` or `"admin"`; admin mode omits hidden, static, and image-upload fields.

- [ ] Write a failing unit test for saved Source URL, custom text, selected choice, checked checkbox, and no file input in admin mode.
- [ ] Extract the form-control markup from `publicFormPage` into `formControls`.
- [ ] Preserve public-form behavior and use saved values only for admin editing.
- [ ] Run the focused test and commit `feat: reuse source form controls`.

### Task 2: Validate and save source-form submission edits

**Files:** `apps/web/src/server.ts`, `apps/web/src/ticket-submission-edit.test.ts`

**Interface:** Extend `PATCH /api/admin/tickets/:ticket` with `{ submission: Record<string, string | boolean | string[]> }`. Invalid input returns `{ error: "validation failed", fields: Record<string, string> }`.

- [ ] Write failing API tests for valid Source URL/custom values, invalid Source URL, rejected unknown keys, and unchanged attachments.
- [ ] Load fields with `fieldsFor(ticket.form_id)` and validate editable values with `validateFields`.
- [ ] Write built-in values to ticket columns and merge allowed custom values into `custom_values_json`.
- [ ] Preserve existing non-submission PATCH behavior.
- [ ] Run the focused test and commit `feat: validate ticket submission edits`.

### Task 3: Replace the ticket editor and workflow controls

**Files:** `apps/web/src/pages/tickets.ts`, `apps/web/src/ui.ts`, `apps/web/src/pages/tickets-get-no-mutation.test.ts`, `tests/e2e/planning.spec.ts`

**Interface:** Replace `data-approve-planning` with `data-start-planning`. Render `Start planning` for an eligible ticket with no plan, `Review plan` for a current reviewable plan, and `Start execution` plus `Update plan` for an approved plan. Failed execution shows `Retry execution` plus `Update plan`. In-progress states show no workflow action.

- [ ] Write failing tests for the action matrix and source-form field rendering.
- [ ] Render the admin editor with `formControls` and saved column/custom values.
- [ ] Serialize checkboxes as booleans and multi-selects as arrays in `{ submission }`.
- [ ] Bind Start planning to the existing planning flow; use links for Review plan and Update plan.
- [ ] Keep Preview prompt and other non-workflow actions unchanged.
- [ ] Update the existing planning journey and commit `feat: simplify ticket planning actions`.

### Task 4: Full verification

- [ ] Run `pnpm verify`.
- [ ] Run `pnpm exec playwright test tests/e2e/planning.spec.ts`.
- [ ] Verify Source URL editing and approved-plan actions manually.

## Assumptions

- All fields means current editable source-form fields, including custom and submitter fields.
- Attachments remain read-only.
- Update plan opens the current plan review page, which uses the existing revision dialog.
- Source URL remains ticket metadata; it does not change planning prompt contents or plan-staleness rules.
