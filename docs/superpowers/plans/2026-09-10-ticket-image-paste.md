# Ticket image paste Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Public and authenticated ticket forms can immediately upload images through a Paste button or file picker, and safely retain/edit their attachments.

**Architecture:** Extend the existing `image_upload` control and artifact pipeline. Authenticated upload claims bind to a current user and project; one reusable browser controller manages paste, picker, previews and retry across forms.

**Tech Stack:** Existing TypeScript HTML renderer, browser Clipboard API, multipart uploads, PostgreSQL artifacts, Vitest and Playwright.

**Spec:** `docs/superpowers/specs/2026-09-10-project-ticket-portal-design.md`. Dependency: finish `2026-09-10-project-ticket-access.md` first.

## Global Constraints

- Node.js >=22; pnpm 11.17.0; PostgreSQL 16; TypeScript; existing Node HTTP server and HTML renderer.
- Prefix shell commands with `rtk`; use `rtk proxy` for commands without a suitable filter.
- Preserve existing opaque sessions, Argon2 password hashing, CSRF checks, upload signature checks, artifact integrity and worker lease checks.
- Only admins may access `/admin` and `/api/admin/*`, except the existing public login and explicitly shared session/logout aliases.
- Reporter mutations never enqueue planning/execution jobs or mutate operational workflow state.
- New database tests run against disposable databases, one database per test file; never point reset-based tests at an existing environment.
- No production migration, deployment, account creation or Jam credential configuration is part of this planning task.

---

## File map

| Files | Responsibility |
| --- | --- |
| `packages/database/migrations/065_authenticated_upload_scope.sql` | User/project ownership and authenticated upload budget |
| `apps/web/src/ticket-uploads.ts` | Image validation, artifact storage, upload ownership and attachment claims |
| `apps/web/src/image-upload-control.ts` | Reusable browser initialization and markup generation |
| `apps/worker/src/ticket-upload-maintenance.ts`, `worker.ts`, `packages/database/src/artifacts.ts` | Bounded cleanup of new never-claimed uploads using controlled artifact paths |
| `apps/web/src/server.ts` | Public/authenticated upload routes, existing public intake claims, validation |
| `apps/web/src/ticket-submissions.ts`, `ticket-api.ts`, `packages/domain/src/ticket-access.ts` | Attach/detach image IDs inside authorized submission transactions and shared safe attachment types |
| `apps/web/src/ui.ts`, `reporter-ui.ts`, `pages/forms.ts`, `pages/shared.ts`, `pages/tickets.ts` | Builder, preview, public/create/edit controls and admin image rendering |
| `packages/domain/src/planning-inputs.ts`, `apps/web/src/approval-inputs.test.ts` | Preserve image evidence in planning and approval checks |
| `apps/web/src/ticket-uploads.db.test.ts`, `image-upload-control.test.ts`, `tests/e2e/ticket-image-paste.spec.ts` | Claims, failures, actual browser paste and cross-project access |

The existing upload handler in `server.ts` validates magic bytes and publishes staged artifacts. Extract that behavior with focused tests; do not write a second artifact store or rename persisted `image_upload` types. Use the existing `/attachments/:id` membership reader from the access plan.

## Task 1: Scope uploads and attachment edits to authenticated users/projects

**Files:** Create migration 065, `ticket-uploads.ts`, `ticket-uploads.db.test.ts`, `apps/worker/src/ticket-upload-maintenance.ts`, `apps/worker/src/ticket-upload-maintenance.db.test.ts`; modify `server.ts`, `ticket-submissions.ts`, `ticket-api.ts`, `apps/worker/src/worker.ts`, `apps/worker/src/security-maintenance.ts`, `packages/database/src/artifacts.ts` and its package export.

**Interfaces:**

```ts
import type { TicketActor } from "../../../packages/domain/src/ticket-access.ts";
import type { QueryClient } from "../../../packages/domain/src/planning-inputs.ts";
export type AttachmentSelection = Record<string, string[]>;
export type TicketAttachment = { id:string; upload_id:string; field_key:string;
  original_name:string|null; media_type:string; size_bytes:number; url:string };
export type UploadScope = { kind:"public"; formId:string } |
  { kind:"authenticated"; actor:TicketActor; projectId:string };
// ticket-uploads.ts exports:
// storeTicketUpload(request:IncomingMessage,scope:UploadScope):Promise<{upload_id:string}>
// setTicketAttachments(client:QueryClient,actor:TicketActor,ticket:any,
//   selection:AttachmentSelection,validFieldKeys:string[]):Promise<void>
// attachmentsForActor(client:QueryClient,actor:TicketActor,ref:string):Promise<TicketAttachment[]>
```

Define `TicketAttachment` alongside `ReporterTicket` in `packages/domain/src/ticket-access.ts`; the web upload module imports that type. Extend `ReporterTicket` with `attachments:TicketAttachment[]`. Extend create/update inputs with optional `attachment_upload_ids:AttachmentSelection`; omission on edit preserves existing attachments, while a provided field's empty array removes that field's attachments. New standard image key is `screenshots`; source forms accept only declared image keys. No client-provided storage paths.

- [ ] **Step 1: Write failing upload-claim DB tests.** Seed two assigned users and two projects, finalized PNG artifacts and unclaimed attachments. Call `setTicketAttachments` inside `inTransaction` after `lockTicketActor` and `ticketForActor(...,true)` and assert:

```ts
await expect(inTransaction(async client => {
  await lockTicketActor(client, reporter);
  const ticket = await ticketForActor(client, reporter, ticketId, true);
  await setTicketAttachments(client, reporter, ticket,
    { screenshots: [otherUsersUploadId] }, ["screenshots"]);
})).rejects.toMatchObject({ status: 422 });
expect((await pool.query("SELECT ticket_id FROM attachments WHERE upload_id=$1",
  [otherUsersUploadId])).rows[0].ticket_id).toBeNull();
```

Declare `reporter`, `ticketId` and upload IDs in the migrated test fixture. Cover same-owner wrong project, public upload used in authenticated flow, unpublished/wrong public form, expired/staged/abandoned upload, duplicate ID across fields, six images, non-image bytes and an existing attachment belonging to another ticket. Existing images on this ticket may be retained by any currently assigned editor even when another reporter uploaded them.
- [ ] **Step 2: Run `rtk proxy pnpm exec vitest run apps/web/src/ticket-uploads.db.test.ts`.** Expected missing helper/ownership behavior.
- [ ] **Step 3: Add migration 065 and extract storage behavior.** Add:

```sql
ALTER TABLE uploads ADD COLUMN owner_user_id uuid REFERENCES users(id),
  ADD COLUMN project_id uuid REFERENCES projects(id),
  ADD COLUMN claim_expires_at timestamptz;
CREATE INDEX uploads_claim_expiry_idx ON uploads(claim_expires_at)
  WHERE claim_expires_at IS NOT NULL;
ALTER TABLE uploads ADD CONSTRAINT upload_authenticated_scope CHECK
  ((owner_user_id IS NULL AND project_id IS NULL) OR
   (owner_user_id IS NOT NULL AND project_id IS NOT NULL AND form_id IS NULL));
CREATE INDEX uploads_owner_project_idx ON uploads(owner_user_id,project_id,created_at);
CREATE TABLE authenticated_upload_attempts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX authenticated_upload_attempts_user_time_idx
  ON authenticated_upload_attempts(user_id,created_at);
```

The old public rows can have null `form_id` after historical form deletion; preserve them, but never permit them to be newly claimed. For authenticated POST, check session/CSRF/current membership/enabled project before consuming the body or staging bytes; recheck while registering the upload. Under the actor lock allow 30 attempts per user/hour, record accepted budget reservations, return 429 with Retry-After when exhausted. Expire quota rows after 24 hours using `apps/worker/src/security-maintenance.ts` and its existing test. Public endpoints retain their existing per-form/IP upload budget.

Reuse `bodyBuffer` with 5 MiB plus multipart framing allowance, existing PNG/JPEG signature checks, normalized filenames and staged/finalized artifact updates. Keep error statuses 400 invalid multipart, 413 oversized, 415 unsupported bytes, and clean up failed staged artifacts. Return `{upload_id}` without paths or a public attachment-download URL.
- [ ] **Step 4: Implement atomic claims and detach without destroying historical evidence.** Lock selected attachment rows and verify each requested ID is either already attached to this ticket or an unclaimed finalized upload owned by this actor/project and younger than one hour. Public intake requires `owner_user_id IS NULL`, matching `form_id`, finalized state and unclaimed age. Select existing ticket attachments first and exclude them from unclaimed checks. Check all fields/IDs before any detach or claim. The new-claim predicate is:

```sql
SELECT a.id,a.upload_id FROM attachments a
JOIN uploads u ON u.id=a.upload_id JOIN artifacts ar ON ar.upload_id=u.id
WHERE a.upload_id=ANY($1::uuid[]) AND a.ticket_id IS NULL
  AND u.owner_user_id=$2 AND u.project_id=$3 AND u.form_id IS NULL
  AND u.created_at>now()-interval '1 hour' AND ar.status='finalized'
FOR UPDATE OF a;
```

Claim each ID once and verify affected row counts. New public/authenticated upload registration sets `claim_expires_at=now()+interval '1 hour'`; successful claim clears it inside the same transaction. Lock attachment, upload and artifact in that order, including public claims. Check both age and nonexpired claim deadline for new rows; preserve the old age-based rule for legacy public rows with a null deadline. For removals delete only the attachment relation; do not immediately delete upload/artifact bytes. Previously claimed uploads keep a null deadline even after detaching. Reporter deletion forbids reads even though admin artifact retention remains intact. On admin project reassignment, reads use current ticket membership; unclaimed uploads retain their original project and cannot cross over.

Add `expireUnclaimedUploads(client:QueryClient,roots:{primary:string;legacy:string}):Promise<number>` in the worker maintenance module, invoked once per minute and limited to 100 records per pass. Select only uploads with a nonnull deadline older than 23 hours and no attached-ticket relation; use the same attachment→upload→artifact lock order as claims. Recheck under lock, mark their artifact abandoned, commit, then remove bytes through `removeArtifactFile(root:string,relativePath:string):Promise<void>`, a new exported wrapper around the existing `artifactPath` plus private `removeArtifact` controlled-path implementation. Never use raw database paths with `rm`. Retain DB rows. On file deletion success clear the deadline; on failure leave it for a later pass, including already-abandoned records. A failed DB commit must not delete bytes. Legacy/null-deadline, claimed, snapshot-retained, and submitter-deleted-ticket uploads are excluded. Add DB/file tests for cleanup/claim races, unsafe paths, retries after interruption and these retention exclusions.
- [ ] **Step 5: Integrate attachment selection into create/PATCH and approval staleness.** All validation, ticket writes, claims, detach, revision increments and audit commit together. Attachment-only changes count as submission edits. For a changed attachment set, call `SELECT mark_ticket_plan_potentially_stale($1)` inside the transaction; migration 006's ticket-row trigger does not cover attachments. Update existing admin edit flow to use the same claims service and require only allowed field keys. `ticketImageEvidence` continues to resolve attached finalized images; compare approval inputs before/after image edits and assert execution refuses stale approvals. A running execution keeps its captured image artifacts. Verify anonymous retry still reuses upload IDs without a second claim.
- [ ] **Step 6: Run DB tests and existing upload regressions, then commit.** `rtk proxy pnpm exec vitest run apps/web/src/ticket-uploads.db.test.ts apps/web/src/public-intake-upload.test.ts apps/web/src/public-intake-upload.db.test.ts apps/web/src/attachment-download-auth.test.ts apps/web/src/approval-inputs.test.ts`. Run DB files separately when supplying a disposable DB. Commit `feat: scope ticket uploads and attachment edits`.

## Task 2: Add immediate Paste/picker upload controls to every ticket form

**Files:** Create `image-upload-control.ts`, `image-upload-control.test.ts`; modify `ui.ts`, `reporter-ui.ts`, `pages/forms.ts`, `pages/shared.ts`, `pages/tickets.ts`, and builder preview tests.

**Interfaces:**

```ts
type ImageControlOptions = {
  fieldKey:string; label:string; required:boolean; uploadUrl:string;
  existing:TicketAttachment[];
};
// image-upload-control.ts exports:
// imageUploadControl(options:ImageControlOptions):string
// imageUploadScript():string -- same browser script for every renderer
// Browser controller exposed as window.nexusImages:
// { pending(form:HTMLFormElement):boolean;
//   invalid(form:HTMLFormElement):boolean;
//   selections(form:HTMLFormElement):Record<string,string[]> }
```

- [ ] **Step 1: Write the failing controller test around a clicked Paste and mocked clipboard/upload.** Use a browser test for DOM integration and a small pure test for MIME selection/limits. Define `clipboardImageType(types:readonly string[]):'image/png'|'image/jpeg'|null` in the control module and test:

```ts
expect(clipboardImageType(["text/html", "image/png", "image/jpeg"])).toBe("image/png");
expect(clipboardImageType(["text/plain"])).toBeNull();
expect(clipboardImageType(["image/svg+xml"])).toBeNull();
```

Verify preview markup has labeled Paste/Choose files, per-image Remove, `aria-live='polite'`, a field-specific error and a button type that cannot submit the form.
- [ ] **Step 2: Run `rtk proxy pnpm exec vitest run apps/web/src/image-upload-control.test.ts`.** Expected missing control/type helper.
- [ ] **Step 3: Implement paste directly within the click gesture.** Use:

```js
pasteButton.addEventListener('click', async () => {
  if (!window.isSecureContext || !navigator.clipboard?.read) {
    fieldError.textContent = 'Clipboard access is unavailable. Choose an image file instead.';
    return;
  }
  try {
    const items = await navigator.clipboard.read();
    let found = false;
    for (const item of items) {
      const type = ['image/png', 'image/jpeg'].find(type => item.types.includes(type));
      if (!type) continue;
      found = true;
      const blob = await item.getType(type);
      await addImage(new File([blob], 'screenshot.' + (type === 'image/png' ? 'png' : 'jpg'), { type }));
    }
    if (!found) fieldError.textContent = 'No image found on your clipboard.';
  } catch {
    fieldError.textContent = 'Could not read your clipboard. Allow access or choose an image file.';
  }
});
```

Inside each initialized control, define `addImage(file:File):Promise<void>`: validate count/bytes/type, create a state entry with UUID, file and local preview; use `FileReader.readAsDataURL` for CSP-compatible previews; upload multipart through `fetch(uploadUrl,{method:'POST',body:formData,headers:csrfHeaders})`; change entry from `uploading` to `ready` with the returned UUID or `failed` with safe text. Attach CSRF only to authenticated endpoints. Define `removeImage(entryId:string):void` to discard the entry from selection and ignore/abort a pending response; define `retryImage(entryId:string):Promise<void>` to repeat only failed uploads. Picker `change` calls the same `addImage` and resets its input to allow choosing the same file again.

Keep existing/ready IDs, pending count and failure state per field; enforce count including existing images. Never set the native file input as required: validation is based on ready+existing image IDs, since paste does not populate that input. Preserve required schema rules through `nexusImages.invalid(form)` and server validation. Put rejected MIME/size text on the image field; do not send SVG or clipboard HTML to the server.
- [ ] **Step 4: Reuse the control across builder previews and all create/edit surfaces.** The builder label changes to "Image upload / paste" while persisted type remains `image_upload`. Preview renders disabled network controls; it must not upload against a fabricated form. Add `screenshots` to standard authenticated form definitions and preserve source-form image fields. `formControls` currently drops images in admin edit mode: replace that omission with image control rendering when an upload context is present. Omit static/hidden fields in authenticated mode and keep public honeypot behavior.

Each actual form provides the correct public-form or authenticated-project upload URL. Disable image controls until a project is chosen. If project selection changes after images were uploaded, clear those unclaimed image selections with an explanatory message; IDs cannot be reused for another project. Existing admin project moves and attachment edits must happen coherently through the service rather than silently adopting staged uploads from the old project.
- [ ] **Step 5: Replace the current submit-time upload loop.** Use `nexusImages.pending(form)` to disable submission while uploading and `invalid(form)` to reject failed/required-missing image fields. Public submission spreads image IDs into existing image field keys; authenticated submission sends `attachment_upload_ids`. Retain IDs and text after 400/422/network errors. Do not upload files again on Save retry. Initial admin ticket creation currently has separate browser handlers, including the PR follow-up creation dialog: wire image controls wherever standard ticket submission fields are offered, without adding them to planning/execution approval forms.
- [ ] **Step 6: Run controller/form rendering tests and commit.** Include `forms-preview.test.ts`, `forms` boundary tests, `ticket-submission-form.test.ts`, `ticket-submission-edit.test.ts`, and `image-upload-control.test.ts`. Commit `feat: paste clipboard images into ticket forms`.

## Task 3: Verify clipboard behavior and evidence lifecycle in browsers

**Files:** Create `tests/e2e/ticket-image-paste.spec.ts`; extend `tests/e2e/public-intake.spec.ts` with a public-field case; add `apps/web/src/attachment-approval.db.test.ts` for evidence retention/staleness if existing approval tests do not exercise real artifact claims.

**Interfaces:** Existing isolated runner and the access plan's admin-created reporter journey. Clipboard API reference: [MDN read()](https://developer.mozilla.org/en-US/docs/Web/API/Clipboard/read).

- [ ] **Step 1: Create a failing browser test using an actual clipboard item.** In the isolated Chromium context grant `clipboard-read` and `clipboard-write`, generate a PNG blob from a canvas, write it to the clipboard, then click the rendered Paste button:

```ts
await context.grantPermissions(['clipboard-read', 'clipboard-write']);
await page.evaluate(async () => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 4;
  const blob = await new Promise<Blob>(resolve => canvas.toBlob(value => resolve(value!), 'image/png'));
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
});
const upload = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/uploads'));
await page.getByRole('button', { name: 'Paste', exact: true }).click();
expect((await upload).status()).toBe(201);
await expect(page.getByRole('img', { name: 'Screenshot preview' })).toBeVisible();
```

The test establishes its `context`/`page` from the normal Playwright fixtures, creates a reporter via the admin API/UI and signs it in before these lines. Run on localhost, which is a browser secure context. Use a stubbed clipboard rejection for denied/unsupported cases so those tests do not depend on OS prompts.
- [ ] **Step 2: Run `rtk proxy bash tests/e2e/run-e2e.sh ticket-image-paste.spec.ts`.** Before integration it should fail on Paste or missing immediate upload. Verify the image uploads before clicking Submit.
- [ ] **Step 3: Cover validation/retry and project isolation.** Count upload POSTs: after a required-title error, correcting the form must submit without a duplicate upload. Include failed upload retry, remove while uploading, mixed picker+paste count of six, oversized file, clipboard text-only, permission denial, public-form attachments disabled, existing required image retained on edit, and clearing a required image. A second reporter on another project must receive 404 for the final attachment URL and 403 for `/admin/attachments/...`; same-project authorized editor can retain/remove it. Revocation after upload but before submit returns 404 and leaves an unclaimed upload for cleanup.
- [ ] **Step 4: Verify approval and cleanup behavior.** In the disposable DB, attach image A, capture an approval input, replace it with image B and assert input hashes differ and new execution rejects stale approval. Assert the old approved artifact still resolves for a run that already captured it; an unclaimed upload becomes unclaimable after one hour and is removed by upload maintenance after 24 hours. A GET must not finalize or mutate an artifact.
- [ ] **Step 5: Run checks, document browser fallback and commit.** `rtk proxy pnpm verify`; database-gated upload/approval tests each in their own DB; `rtk proxy bash tests/e2e/run-e2e.sh ticket-image-paste.spec.ts reporter-tickets.spec.ts public-intake.spec.ts`. Run `rtk git diff --check`; commit `test: verify clipboard ticket evidence and access isolation`.

## Acceptance checklist

- [ ] Existing `image_upload` forms now offer Paste and Choose files, including builder preview.
- [ ] Paste uploads on the click and shows progress/preview without waiting for ticket submission.
- [ ] Admin, reporter and anonymous public form flows save and retain image IDs correctly.
- [ ] PNG/JPEG byte checks, five images and 5 MiB limits are enforced server-side.
- [ ] Permission denial and unsupported browsers show usable fallback; clipboard text is never fetched as an image URL.
- [ ] Ownership/project/form scope, artifact state, claim age and ticket membership are enforced on writes and reads.
- [ ] Attachment edits invalidate future approval input without breaking captured execution evidence.

Next: `2026-09-10-ticket-jam-import.md`.
