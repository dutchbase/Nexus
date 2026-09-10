# Project ticket access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admins can create and assign reporters who can read/create/edit project tickets and delete their own from reporter views.

**Architecture:** Retain Nexus sessions and add a strict admin role boundary. Add dedicated reporter queries, ticket mutation services and server-rendered pages; reuse existing admin operations without exposing their responses to reporters.

**Tech Stack:** Node HTTP server, TypeScript, PostgreSQL, Argon2 helper, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-10-project-ticket-portal-design.md` (read all decisions and permissions first).

## Global Constraints

- Node.js >=22; pnpm 11.17.0; PostgreSQL 16; TypeScript; existing Node HTTP server and HTML renderer.
- Prefix shell commands with `rtk`; use `rtk proxy` for commands without a suitable filter.
- Preserve existing opaque sessions, Argon2 password hashing, CSRF checks, upload signature checks, artifact integrity and worker lease checks.
- Only admins may access `/admin` and `/api/admin/*`, except the existing public login and explicitly shared session/logout aliases.
- Reporter mutations never enqueue planning/execution jobs or mutate operational workflow state.
- New database tests run against disposable databases, one database per test file; never point reset-based tests at an existing environment.
- No production migration, deployment, account creation or Jam credential configuration is part of this planning task.

---

## File map and delivery boundary

| Files | Responsibility |
| --- | --- |
| `packages/database/migrations/064_project_reporters.sql` | Roles, membership, creator, submission revisions, reporter deletion |
| `packages/domain/src/ticket-access.ts` | Current actor/project/ticket authorization and safe projections |
| `apps/web/src/session.ts` | Shared session lookup, CSRF, recognized-role and admin guards |
| `apps/web/src/reporter-users.ts` | Admin reporter account and membership transactions |
| `apps/web/src/ticket-submissions.ts` | Authorized submission CRUD, ownership, validation and revision conflicts |
| `apps/web/src/ticket-api.ts` | Thin authenticated ticket/project HTTP handlers |
| `apps/web/src/pages/users.ts`, `apps/web/src/pages/reporter-tickets.ts` | Admin account UI; reporter list/detail/create/edit UI |
| `apps/web/src/reporter-ui.ts` | Reporter shell and browser events without admin navigation/data |
| `apps/web/src/server.ts`, `ui.ts`, `pages/shared.ts` | Routing, login redirect, reusable form controls and submission timestamps |
| `tests/helpers/ticket-http.ts` | Route request/session fixtures used only by tests |
| `packages/database/scripts/create-admin.ts`, `scripts/create-admin.ts`, existing user-inserting test fixtures | Explicit role on intended admin inserts |
| New colocated `*.test.ts`, `*.db.test.ts` and `tests/e2e/reporter-tickets.spec.ts` | Permission, transaction and browser checks |

The current highest migration is 063. Recheck filenames before implementation; if newer migrations have landed, renumber these new migrations and the next two plans together. Never edit an applied migration. Do not restructure unrelated parts of the large HTTP/UI files.

This increment is usable without clipboard or Jam integration. The subsequent plans add evidence fields to the transaction and form boundaries defined here.

## Task 1: Persist reporters, project membership and ticket ownership

**Files:** Create `packages/database/migrations/064_project_reporters.sql`, `packages/database/src/project-reporters.db.test.ts`; modify intended admin inserts found in the two admin scripts and test fixtures.

**Interfaces:** Consumes `users`, `projects`, `tickets`; produces `project_memberships(user_id,project_id)`, creator and submission metadata columns listed below. Existing users keep their roles and credentials.

- [ ] **Step 1: Add a database migration test using the existing `DCC_TEST_DATABASE_URL`/`migrate()` pattern.** Test preserved admin rows, a reporter by default, unique membership, rejected unknown roles, null legacy creators and initialized submission timestamps. The core assertions are:

```ts
import { expect, test } from "vitest";
import { pool } from "@dcc/database";

test("new accounts default to reporter and ticket ownership stays nullable", async () => {
  const user = (await pool.query(
    "INSERT INTO users(username,password_hash) VALUES ('reporter-default','test-hash') RETURNING role",
  )).rows[0];
  expect(user.role).toBe("reporter");
  const columns = (await pool.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name='tickets'",
  )).rows.map(r => r.column_name);
  expect(columns).toEqual(expect.arrayContaining([
    "created_by_user_id", "submission_revision", "submission_updated_at",
    "submitter_deleted_at", "submitter_deleted_by",
  ]));
  await expect(pool.query(
    "INSERT INTO users(username,password_hash,role) VALUES ('bad-role','hash','owner')",
  )).rejects.toMatchObject({ code: "23514" });
});
```

Wrap these tests in the repository's conditional database `describe` and migrate only the disposable test DB. Add an upgrade test that seeds an explicit admin and a legacy ticket before applying 064, then confirms both survive unchanged.

- [ ] **Step 2: Run the failing migration tests.** `rtk proxy pnpm exec vitest run packages/database/src/project-reporters.db.test.ts`. Supply a disposable `DCC_TEST_DATABASE_URL`; a skipped suite is not evidence. Expected failure: default remains admin or new columns absent.
- [ ] **Step 3: Add the migration.** First abort with a clear migration error if existing roles differ from `admin`/`reporter`; do not promote or discard unknown users. Apply:

```sql
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin','reporter'));
ALTER TABLE users ALTER COLUMN role SET DEFAULT 'reporter';
CREATE TABLE project_memberships (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, project_id)
);
CREATE INDEX project_memberships_project_idx ON project_memberships(project_id,user_id);
ALTER TABLE tickets
  ADD COLUMN created_by_user_id uuid REFERENCES users(id),
  ADD COLUMN submission_revision integer NOT NULL DEFAULT 1,
  ADD COLUMN submission_updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN submitter_deleted_at timestamptz,
  ADD COLUMN submitter_deleted_by uuid REFERENCES users(id);
UPDATE tickets SET submission_updated_at=created_at;
ALTER TABLE tickets ADD CONSTRAINT submitter_deletion_pair CHECK
  ((submitter_deleted_at IS NULL) = (submitter_deleted_by IS NULL));
CREATE INDEX tickets_reporter_list_idx ON tickets(project_id,submission_updated_at DESC,id)
  WHERE submitter_deleted_at IS NULL;
```

- [ ] **Step 4: Make every intentional admin insert explicit.** Run `rtk proxy rg -n 'INSERT INTO users' packages scripts apps tests`. For each admin fixture and CLI insert include `role` and `'admin'`; leave only intentional default-role tests implicit. Test `pnpm admin:create` still creates an admin through the existing script tests. Never backfill creator from submitter email.
- [ ] **Step 5: Run the migration test and admin/password tests; commit the schema and explicit-role changes.** `rtk proxy pnpm exec vitest run packages/database/src/project-reporters.db.test.ts packages/database/src/password.test.ts` then `rtk git add` the changed files and `rtk git commit -m "feat: add reporter identities and project membership"`.

## Task 2: Enforce session roles before any admin read or action

**Files:** Create `apps/web/src/session.ts`, `apps/web/src/role-boundary.db.test.ts`, `tests/helpers/ticket-http.ts`; modify `server.ts`, `ui.ts`, `apps/web/README.md`, existing tests passing fabricated admin sessions.

**Interfaces:** `Session = { id:string; user_id:string; username:string; role:'admin'|'reporter'; csrf_token_hash:string }`; export `sessionFor(request):Promise<Session|null>`, `requireSession(request,response):Promise<Session|null>`, `requireAdmin(request,response):Promise<Session|null>`, `assertAdmin(session):void`. `requireSession` applies CSRF to all unsafe methods and rejects unknown roles. Shared `/api/session` and `/api/logout` work for both roles.

- [ ] **Step 1: Add a real-session route helper, then a failing admin-isolation test.** The helper must invoke `route`, not bypass authentication with a mocked `adminApi` call:

```ts
// tests/helpers/ticket-http.ts
import { Readable } from "node:stream";
import { createHash, randomBytes } from "node:crypto";
import type { QueryClient } from "../../packages/domain/src/planning-inputs.ts";

export async function createTestSession(db: QueryClient, userId: string) {
  const token = randomBytes(32).toString("hex");
  const csrf = randomBytes(32).toString("hex");
  const hash = (s: string) => createHash("sha256").update(s).digest("hex");
  await db.query(`INSERT INTO admin_sessions(user_id,token_hash,csrf_token_hash,expires_at)
    VALUES($1,$2,$3,now()+interval '1 hour')`, [userId,hash(token),hash(csrf)]);
  return { cookie: `dcc_session=${token}`, csrf };
}
export async function callRoute(path: string, input: {
  method?: string; body?: unknown; cookie?: string; csrf?: string;
} = {}) {
  const { route } = await import("../../apps/web/src/server.ts");
  const request = Object.assign(Readable.from(input.body === undefined ? [] :
    [Buffer.from(JSON.stringify(input.body))]), {
    url: path, method: input.method ?? "GET",
    headers: { host: "test", "content-type": "application/json",
      ...(input.cookie ? { cookie: input.cookie } : {}),
      ...(input.csrf ? { "x-csrf-token": input.csrf } : {}) },
    socket: { remoteAddress: "192.0.2.12" },
  });
  let status = 0, headers: Record<string, any> = {}, text = "";
  const response = {
    writeHead(code: number, values: Record<string, any>) { status=code; headers=values; },
    end(value?: unknown) { text += value == null ? "" : String(value); },
  };
  await route(request as any, response as any);
  return { status, headers, text,
    body: String(headers["content-type"] ?? "").includes("application/json") ? JSON.parse(text) : null };
}
```

Set `NODE_ENV=test`, `DCC_PROCESS_ROLE=web` and the disposable DB URL before importing the server. In the test's migrated DB insert `('boundary-reporter','test-hash','reporter')`, create its session with this helper, and run:

```ts
for (const path of ["/api/admin/tickets", "/api/admin/projects", "/api/admin/jobs",
  "/api/admin/audit", "/api/admin/pull-requests", "/api/admin/prompts"]) {
  const result = await callRoute(path, reporterSession);
  expect(result.status).toBe(403);
}
const html = await callRoute("/admin", reporterSession);
expect(html.status).toBe(403);
expect(html.text).not.toContain("Running agents");
```

- [ ] **Step 2: Run `rtk proxy pnpm exec vitest run apps/web/src/role-boundary.db.test.ts`.** Expected failure: existing admin routes accept the reporter.
- [ ] **Step 3: Move session lookup and CSRF into `session.ts`; add fail-closed role guards.** Keep existing cookie/hash logic, active-user join, timeout and CSRF comparison. The critical checks are:

```ts
export function assertAdmin(session: Session) {
  if (session.role !== "admin")
    throw Object.assign(new Error("administrator access required"), { status: 403 });
}
// In requireAdmin, after requireSession has handled authentication and CSRF:
if (session.role !== "admin") {
  json(response, 403, { error: "administrator access required" });
  return null;
}
// In adminHtml, immediately after session lookup and before attachments/counts:
if (session.role !== "admin") return html(response, 403, "<h1>Forbidden</h1>", {}, nonce);
```

Avoid a circular import for `json`: extract the tiny response helper into `apps/web/src/http-response.ts` if needed, or write the guard's response directly. Add `assertAdmin` at `adminApi` entry; update direct unit-test fixtures to carry `role:'admin'`. Let the outer HTTP error envelope handle thrown access errors.
- [ ] **Step 4: Route shared session/logout before the admin-only guard.** Keep `/api/admin/login` public; dispatch old admin session/logout aliases through the shared handler. Login audit actor type reflects the actual role. Set login browser redirect to `result.user.role === 'admin' ? '/admin' : '/tickets'`; add recognized-role checking before issuing a session. No unauthenticated signup endpoint.
- [ ] **Step 5: Expand the denial matrix and run it.** Include GET/HEAD admin HTML, attachment/download, run events/logs, prompt preview, plan reads, AI usage, notifications, settings, queue, health/operation pages; POST plan/start/revise/approve/execute/cancel/retry/merge/deploy; PATCH nested ticket fields. Assert zero new jobs/runs and unchanged tickets. Verify missing session is 401, missing/bad CSRF is 403, disabled session is rejected immediately, and admins retain access. Update existing login and attachment tests as needed, then commit with `feat: enforce admin and reporter session boundaries`.

## Task 3: Admin can create and manage reporter accounts and assignments

**Files:** Create `apps/web/src/reporter-users.ts`, `apps/web/src/reporter-users.db.test.ts`, `apps/web/src/pages/users.ts`; modify `server.ts`, `ui.ts`, admin navigation.

**Interfaces:**

```ts
type ReporterInput = { username: string; password: string; project_ids: string[] };
type ReporterUpdate = { is_active?: boolean; project_ids?: string[] };
type ReporterView = { id: string; username: string; is_active: boolean;
  role: "reporter"; project_ids: string[]; created_at: string; last_login_at: string | null };
// reporter-users.ts exports (Session comes from Task 2):
// createReporter(session:Session,input:ReporterInput):Promise<ReporterView>
// updateReporter(session:Session,id:string,input:ReporterUpdate):Promise<ReporterView>
// resetReporterPassword(session:Session,id:string,password:string):Promise<void>
// listReporters(session:Session):Promise<ReporterView[]>
```

- [ ] **Step 1: Add the failing account transaction test.** In a migrated DB seed an explicit admin and two projects with valid repository paths (no worker startup). Use the HTTP helper and assert:

```ts
const created = await callRoute("/api/admin/users", { ...adminSession, method: "POST",
  body: { username: "client-one", password: "a-long-test-password", project_ids: [projectA.id] } });
expect(created.status).toBe(201);
expect(created.body.user).toMatchObject({ username: "client-one", role: "reporter", project_ids: [projectA.id] });
expect(JSON.stringify(created.body)).not.toMatch(/password|hash/);
const stored = (await pool.query("SELECT * FROM users WHERE id=$1", [created.body.user.id])).rows[0];
expect(await verifyPassword(stored.password_hash, "a-long-test-password")).toBe(true);
```

Add cases for duplicate username (409), unknown project (422 with no user created), duplicate assignments (deduplicated), role injection (422), non-admin access (403), resetting an admin through this API (404), and deactivation invalidating all reporter sessions.
- [ ] **Step 2: Run `rtk proxy pnpm exec vitest run apps/web/src/reporter-users.db.test.ts`.** Expected failure: missing endpoint/module.
- [ ] **Step 3: Implement transactions and input allowlists.** Use `hashPassword`/`validatePassword` from the existing password module; impose 12-character minimum in the new account UI/API, preserve the existing byte/character safety rules. Username is trimmed, case-sensitive, 3–80 ASCII letters/digits/`._-`; match login's current case-sensitive behavior. Password never enters audit before/after or request logging. Lock the target `users` row `FOR UPDATE` before assignment replacement or state changes; create memberships with parameterized SQL:

```sql
INSERT INTO project_memberships(user_id,project_id)
SELECT $1::uuid, id FROM projects WHERE id=ANY($2::uuid[])
ON CONFLICT DO NOTHING;
```

Validate all requested project IDs before writes; replace memberships atomically. On password reset or deactivate, invalidate sessions in the same transaction. Audit username/active state/project IDs only. Allow an empty membership list and show its meaning clearly in the UI. No admin role assignment or self-disable through reporter endpoints.
- [ ] **Step 4: Add `/admin/users` with a Users navigation link.** Render username, active state, assigned project chips and Add user/Edit projects/Reset password/Deactivate controls. Creation form fields use `autocomplete='new-password'`, project checkboxes, inline errors and a disabled pending submit. The POST shape is exactly `ReporterInput`; send CSRF from the existing shared client convention. Keep credentials out of table HTML after save. Reset asks admin for the new password and clears it on success. Include this markup in the add dialog:

```html
<label class="field"><span>Username</span><input name="username" required minlength="3" maxlength="80" autocomplete="off"></label>
<label class="field"><span>Initial password</span><input name="password" type="password" required minlength="12" autocomplete="new-password"></label>
<fieldset><legend>Projects</legend>${projects.map(p => '<label><input type="checkbox" name="project_ids" value="'+escapeHtml(p.id)+'">'+escapeHtml(p.name)+'</label>').join('')}</fieldset>
<p role="alert" data-user-error></p>
<button type="submit">Add user</button>
```

Render each checkbox with `projects.map(p => '<label><input type="checkbox" name="project_ids" value="'+escapeHtml(p.id)+'">'+escapeHtml(p.name)+'</label>').join('')`; do not embed JSON containing secrets.
- [ ] **Step 5: Run account tests plus a rendered-page test for labels/errors and commit.** `rtk proxy pnpm exec vitest run apps/web/src/reporter-users.db.test.ts` then `rtk git commit -m "feat: manage reporter users and project assignments"` after staging exact changed paths.

## Task 4: Authorized submission queries, updates and own-ticket deletion

**Files:** Create `packages/domain/src/ticket-access.ts`, `packages/domain/src/ticket-access.test.ts`, `apps/web/src/ticket-submissions.ts`, `apps/web/src/ticket-api.ts`, `apps/web/src/ticket-submissions.db.test.ts`; modify `server.ts` admin/public creation and admin patch transactions.

**Interfaces:**

```ts
export type TicketActor = { userId: string; role: "admin" | "reporter" };
export type SubmissionFields = {
  title: string; description: string; category?: string | null; priority?: string | null;
  source_url?: string | null; environment?: string | null; expected_behavior?: string | null;
  actual_behavior?: string | null; reproduction_steps?: string | null;
  submission?: Record<string, string | boolean | string[]>;
};
export type ReporterTicket = {
  id: string; ticket_number: string; project_id: string; project_name: string;
  title: string; description: string | null; category: string | null; priority: string | null;
  source_url: string | null; environment: string | null; expected_behavior: string | null;
  actual_behavior: string | null; reproduction_steps: string | null;
  submission: Record<string, string | boolean | string[]>;
  submission_revision: number; submission_updated_at: string; created_at: string;
  can_delete: boolean;
};
// ticket-access.ts exports:
// lockTicketActor(client:QueryClient, actor:TicketActor):Promise<void>
// requireProjectAccess(client:QueryClient, actor:TicketActor, projectId:string):Promise<void>
// ticketForActor(client:QueryClient, actor:TicketActor, ref:string, lock?:boolean):Promise<any|null>
// reporterTicket(row:any, actor:TicketActor, fields:any[]):ReporterTicket
// ticket-submissions.ts exports:
// listSubmissionProjects(actor:TicketActor):Promise<{id:string;name:string;slug:string;enabled:boolean}[]>
// listSubmissions(actor:TicketActor, filter:{project_id?:string;search?:string;offset?:number}):Promise<ReporterTicket[]>
// getSubmission(actor:TicketActor, ref:string):Promise<ReporterTicket|null>
// createSubmission(actor:TicketActor, input:SubmissionFields & {project_id:string}):Promise<ReporterTicket>
// updateSubmission(actor:TicketActor, ref:string, input:Partial<SubmissionFields> & {submission_revision:number}):Promise<ReporterTicket>
// deleteOwnSubmission(actor:TicketActor, ref:string):Promise<void>
```

- [ ] **Step 1: Add a failing real-DB CRUD/access test.** Seed reporter A and B on project A, reporter C on project B, a legacy ticket and tickets owned by A/B. Verify A sees/edits B's ticket but cannot delete it, cannot read B-project tickets, and cannot delete a legacy unowned ticket. Core request assertions:

```ts
const created = await callRoute("/api/tickets", { ...reporterSession, method: "POST",
  body: { project_id: projectA.id, title: "Broken save", description: "Save leaves an empty page" } });
expect(created.status).toBe(201);
expect(created.body.ticket.can_delete).toBe(true);
expect(created.body.ticket).not.toHaveProperty("status");
const forged = await callRoute(`/api/tickets/${created.body.ticket.id}`, {
  ...reporterSession, method: "PATCH", body: {
    submission_revision: 1, submission: { project_id: projectB.id }, status: "Execution Queued",
  },
});
expect(forged.status).toBe(422);
const removed = await callRoute(`/api/tickets/${created.body.ticket.id}`, {
  ...reporterSession, method: "DELETE",
});
expect(removed.status).toBe(204);
expect((await callRoute(`/api/tickets/${created.body.ticket.id}`, reporterSession)).status).toBe(404);
expect((await pool.query("SELECT status,submitter_deleted_at FROM tickets WHERE id=$1",
  [created.body.ticket.id])).rows[0]).toMatchObject({ status: "Submitted", submitter_deleted_at: expect.anything() });
```

- [ ] **Step 2: Run `rtk proxy pnpm exec vitest run apps/web/src/ticket-submissions.db.test.ts`.** Expected missing route/service failure.
- [ ] **Step 3: Implement SQL-scoped access and explicit projection.** Lock actor before ticket in every mutation and membership edit. `lockTicketActor` must re-read active state and role from DB rather than trust client input. A member detail query uses parenthesized ID alternatives:

```sql
SELECT t.*,p.name AS project_name FROM tickets t JOIN projects p ON p.id=t.project_id
WHERE (t.id::text=$1 OR t.ticket_number=$1)
AND t.submitter_deleted_at IS NULL
AND EXISTS(SELECT 1 FROM project_memberships m WHERE m.project_id=t.project_id AND m.user_id=$2)
FOR UPDATE OF t;
```

Omit `FOR UPDATE` for reads. Admin service queries can bypass membership but responses still use the safe projection. List filters are additional `AND` conditions; search must never introduce an unparenthesized `OR`. Clamp offset to nonnegative integer and limit to 50; order by `submission_updated_at DESC,id DESC`. Read disabled assigned projects/tickets but disallow new tickets in them. Project filtering must use membership even when no filter is supplied.

Create the `ReporterTicket` object property by property. Define `can_delete` as current reporter plus exact creator ID equality; do not return creator IDs. Validate custom fields against the ticket's source form and a reserved-key denylist, and allow only declared submission value types. Use the standard-field definitions when `form_id` is null. Preserve required fields/options/max lengths from source forms; title/description cannot be empty. Accept only the existing configured priority options (do not rewrite legacy values on unrelated edits).
- [ ] **Step 4: Implement transactional CRUD and stable submission revisions.** Creation includes `created_by_user_id=actor.userId`, status `Submitted` for reporters/`Triage` for admin, history and audit atomically. Keep `enqueueNotification` consistent with existing admin-configured behavior but never enqueue operational work. Update uses a field allowlist, `submission_revision` optimistic concurrency, actor/ticket locks and safe audit metadata. Reject an old revision with 409 and preserve input in the browser. An actual submission change increments revision and timestamp plus existing `updated_at`; no-op edit does not.

```sql
UPDATE tickets SET title=$2, description=$3,
  submission_revision=submission_revision+1,submission_updated_at=now(),updated_at=now()
WHERE id=$1 AND submission_revision=$4 RETURNING *;
```

Extend the SET list from validated content only. Existing admin `PATCH` paths, including nested `submission`, must increment these new columns when submission content/project changes, but not for status/AI-only changes. Keep migration 006's `tickets_stale_approved_plan` trigger: it marks edited approved content stale without changing ticket workflow status. For submission fields absent from that trigger (such as source URL), explicitly call `SELECT mark_ticket_plan_potentially_stale($1)` in the edit transaction and include the field in `approvalInputsFor`'s material ticket object. Stamp creator in current admin ticket creation; public anonymous creation leaves it null. Public intake remains an anonymous path even if a reporter is logged in; the portal uses authenticated creation.

Deletion locks actor/ticket, checks current membership and ownership, and sets only `submitter_deleted_at/by` plus an audit event. Do not alter `status`, `updated_at`, jobs, plan approval or active runs. Repeat DELETE by the same still-authorized owner is 204. Other-owner deletion is 403; inaccessible/unknown ID is 404. Admin ticket detail displays the deletion marker.
- [ ] **Step 5: Verify races and forged writes, then commit.** Add two-connection tests for assignment revocation versus PATCH, revision conflicts between reporters, and admin project reassignment versus reporter edit. Verify role/status/project/creator/AI injection in top-level and nested fields is rejected without partial writes. Delete a ticket in `Executing` and assert run/job/approval state is identical. Confirm worker-only updates neither move reporter list order nor change reporter revision. Run access/unit/DB tests and commit `feat: add project-scoped ticket submission operations`.

## Task 5: Ship the ticket-only reporter interface

**Files:** Create `apps/web/src/pages/reporter-tickets.ts`, `apps/web/src/reporter-ui.ts`, `apps/web/src/reporter-pages.test.ts`; modify `server.ts`, `ui.ts` form controls and admin deletion marker in `pages/tickets.ts`.

**Interfaces:** `reporterPage(title:string,body:string,username:string,nonce:string):string`; `reporterTicketsPage.render(url:URL,session:Session):Promise<{status:number;title:string;body:string}|null>`. All data comes from Task 4 services. Form rendering accepts a new `reporter` mode with submission values and without hidden/static/project-change/admin controls.

- [ ] **Step 1: Add the failing page test.** Render a reporter list/detail with a sentinel operational field in the mocked storage row and assert it never appears in HTML or script data:

```ts
expect(rendered).toContain('href="/tickets"');
expect(rendered).toContain("Broken save");
expect(rendered).not.toContain("private-execution-log-marker");
expect(rendered).not.toMatch(/href="\/admin|data-start-planning|data-run-stream/);
expect(rendered).toContain('name="submission_revision"');
```

Use escaped malicious title/description in another case. Admin pages are tested separately; do not reuse admin page construction to generate reporter HTML.
- [ ] **Step 2: Run `rtk proxy pnpm exec vitest run apps/web/src/reporter-pages.test.ts`.** Expected missing page module/rendering.
- [ ] **Step 3: Add `/tickets` and `/tickets/:ref` GET routes and `/api/projects`, `/api/tickets` handlers before admin routing.** Require a recognized session; for HTML unauthenticated users redirect to login. Build only Tickets/Log out navigation. Read no global counts. Ticket list includes project filter/search/create and ticket number/title/project/submission update date; no status board. Empty membership copy: "No projects assigned. Ask your Nexus administrator for access."

Creation includes enabled assigned project choices, title/description and standard submission fields. Detail shows original submission, edit controls, existing accessible image links and Delete only when `can_delete`. After delete navigate to `/tickets`; a confirmation dialog says "Delete this ticket from the ticket portal?" and explains admin record retention. Escape all values, including custom field labels, and pass the CSP nonce to script generation.
- [ ] **Step 4: Connect browser operations with CSRF and revision handling.** The edit payload is:

```js
const payload = {
  submission_revision: Number(form.elements.submission_revision.value),
  title: form.elements.title.value,
  description: form.elements.description.value,
};
const response = await fetch('/api/tickets/' + encodeURIComponent(form.dataset.ticketId), {
  method: 'PATCH', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
  body: JSON.stringify(payload),
});
if (response.status === 409) {
  error.textContent = 'This ticket changed. Reload it before saving; your edits are still here.';
  return;
}
```

Serialize the remaining allowed fields from the rendered field schema, not arbitrary DOM names. Preserve form values on any failed save; prevent double submissions. On 401 go to login; 403/404 show access loss and stop retries. Link existing attached images through the scoped `/attachments/:id` reader introduced with the same membership query now; keep the old admin reader strictly admin-only. That reader must reject submitter-deleted tickets before reading artifact bytes, preserving `readUploadArtifact` integrity behavior.
- [ ] **Step 5: Run page/unit checks and commit.** Include source-form required-field editing, empty project list, disabled project, no Delete for another submitter, mobile layout and keyboard dialog focus. Commit `feat: add reporter ticket portal`.

## Task 6: Verify the complete account and ticket journey

**Files:** Create `tests/e2e/reporter-tickets.spec.ts`; modify `tests/e2e/fixtures/seed.ts` only if additional deterministic project fixtures are required, and document reporter operations in `README.md` and `apps/web/README.md`.

**Interfaces:** Uses existing isolated `tests/e2e/run-e2e.sh`, admin login credentials and the HTTP contracts above. No real accounts, provider calls or deployments.

- [ ] **Step 1: Add a failing Playwright journey through visible controls.** Log in as the harness admin; add two reporters and assign only one fixture project to each. Open a separate browser context for each reporter, sign in, and assert their `/tickets` project choices. Use this test sequence:

```ts
await reporterPage.getByRole('button', { name: 'New ticket' }).click();
await reporterPage.getByLabel('Title', { exact: true }).fill('Reporter save bug');
await reporterPage.getByLabel('Description', { exact: true }).fill('Save opens a blank page.');
await reporterPage.getByRole('button', { name: 'Submit ticket' }).click();
await expect(reporterPage.getByRole('heading', { name: 'Reporter save bug' })).toBeVisible();
await expect(reporterPage.getByRole('link', { name: 'Runs', exact: true })).toHaveCount(0);
const forbidden = await reporterPage.request.get('/api/admin/jobs');
expect(forbidden.status()).toBe(403);
```

Declare the `reporterPage` from the separate logged-in browser context in test setup; create accounts using the new Users UI rather than direct DB inserts. Continue with edit, another project access denial, own deletion, an admin-visible retained record, logout/login and removal of a project assignment while the reporter tab stays open. Probe the revoked detail/attachment API and assert 404. A separate disabled-account test asserts 401.
- [ ] **Step 2: Run the focused journey.** `rtk proxy bash tests/e2e/run-e2e.sh reporter-tickets.spec.ts`. Expected initial failures identify incomplete wiring; fix only the affected integration seams.
- [ ] **Step 3: Verify regression boundaries.** Run `rtk proxy pnpm verify`; run each new DB-gated suite in its own disposable database using the same per-file isolation as `.github/workflows/ci.yml`; run `rtk proxy bash tests/e2e/run-e2e.sh reporter-tickets.spec.ts auth.spec.ts ticket-lifecycle.spec.ts public-intake.spec.ts planning.spec.ts execution.spec.ts`. Do not count skipped DB suites as passes. Check that `adminApi` unit fixtures have explicit roles and that existing public intake still works.
- [ ] **Step 4: Document and commit the tested increment.** Explain account setup, membership removal, editing-all/own-deletion policy and admin record retention. Record commands and actual results in the PR. Run `rtk git diff --check`, stage exact changed files, and commit `test: verify reporter access and ticket lifecycle`.

## Acceptance checklist

- [ ] Admin can create, reset, deactivate and assign reporters in the UI; no admin privilege is granted implicitly.
- [ ] Every admin page/API family denies reporters before accessing operational data.
- [ ] Lists, search, direct IDs, ticket numbers and image reads are scoped to current membership.
- [ ] Reporters can create/edit project tickets, edit others' tickets, and delete only their own visible tickets.
- [ ] Delete retains admin history and does not alter planning/execution, including active work.
- [ ] Revocation, deactivation, nested field injection and concurrent edits have real-DB coverage.
- [ ] Reporter HTML/JSON contain no workflow state, logs, snapshots, admin notes, private email or repository configuration.
- [ ] Existing admin workflows and anonymous public intake pass their regression journeys.

Next: `2026-09-10-ticket-image-paste.md`.
