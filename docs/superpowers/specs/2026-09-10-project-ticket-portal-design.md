# Project ticket portal and submission evidence

Date: 2026-09-10. Status: proposed design accompanying the requested implementation plans; application changes have not been made.

## Requested behavior

An administrator can create Nexus users and assign each user to one or more projects. These users can sign in, see tickets in their assigned projects, create tickets, edit tickets, and delete their own tickets. They cannot initiate or inspect planning, execution, or other operations. Ticket forms support an image copied to the clipboard through a Paste button, and a Jam link whose technical details Nexus imports automatically.

## Decisions used by the plans

These are explicit defaults for review, not claims of separate user approval:

- A `reporter` can edit submission content on **any** ticket in an assigned project. Only `created_by_user_id` determines who may delete a ticket; names and email addresses do not establish ownership.
- Keep the existing username/password login. Admin enters a username, initial password, and project assignments. No email invitation service is needed for this version. Admin can reset a reporter's password and deactivate/reactivate their account.
- Reporter navigation contains Tickets and Log out. Project names appear in ticket filters and creation controls. No dashboard, project configuration, notes, status history, plans, runs, logs, approvals, PRs, deployments, jobs, notifications, prompts, skills, or AI accounting are exposed.
- Do not expose workflow statuses or workflow update timestamps. Reporter sorting and conflict detection use a separate submission revision and submission update timestamp.
- A reporter's Delete removes the ticket and its attachments from all reporter views. The admin retains the record, marked "Deleted by submitter", and its operational history. Delete does not cancel, queue, or restart work. This avoids granting workflow control through deletion, including when a ticket is already executing.
- Reporters can edit submission content during any workflow state. Edits cannot rewrite approved execution snapshots. Existing approval checks must detect changed ticket evidence before a new execution begins; an already running execution continues with its captured input.
- Admin creation remains `Triage`; reporter and public creation use `Submitted`. None starts planning or execution.
- Reporter creation uses the existing standard ticket fields, without requiring a published public form. Existing source forms still determine custom fields when editing form submissions.
- Use the existing `image_upload` field type, presented in the builder as "Image upload / paste". Every such field gains Paste and Choose files. Add a distinct `jam_link` field type with reserved key `jam_url`; allow at most one per form.
- Add optional Screenshots and Jam link to standard authenticated creation/edit forms. Existing persisted public forms gain these capabilities when the admin adds these field types; do not silently modify their published fields.
- Import Jam context after a ticket save. Saving succeeds during an outage or when the Jam is inaccessible. Reporters see the source link and a simple import outcome. Extracted details are admin-only ticket evidence and available to admin-initiated planning. This prevents the worker's Jam account from becoming a private-data lookup service for reporters or anonymous submitters.

## Existing code that determines the design

| Area | Current implementation | Consequence |
| --- | --- | --- |
| HTTP and authentication | `apps/web/src/server.ts`: `sessionFor`, `requireAdmin`, `adminHtml`, `adminApi`, `route` | `requireAdmin` checks a session and CSRF but never checks `role`; `adminHtml` similarly assumes any session is admin. Both boundaries must change before reporter accounts are enabled. |
| Identity | `001_foundation.sql`: `users`, `admin_sessions` | Reuse hashed passwords, active-user checks, expiring opaque sessions, cookies and CSRF. The historical table name can remain. |
| Ticket ownership | `tickets` has submitter name/email but no authenticated creator | Add a nullable creator FK. Leave legacy/public ownership null; do not infer from email or audit heuristics. |
| Tickets | Admin list/detail APIs select full rows and return history, notes and notification deliveries | Give reporters dedicated queries and response projections. Hiding existing tabs would still leak data. |
| UI | Server-rendered TypeScript HTML and nonce-protected JavaScript in `ui.ts` | Add a small reporter shell and pages, sharing form/evidence controls. No framework migration. |
| Uploads | Public-form multipart endpoint, PNG/JPEG signatures, 5 MiB, staged/finalized artifacts, one-hour claim window, five files per field | Reuse artifact machinery. Add authenticated ownership/project scope and immediate upload UI; preserve public form scope and quotas. |
| Forms | Builder in `pages/forms.ts`; controls in `ui.ts`; validation in `server.ts`; defaults in `pages/shared.ts` | Update each boundary, including builder preview, create, edit and public intake. |
| Jobs | Database jobs, worker capability list, lease/claim dispatcher, retries | Add one bounded `ticket.jam_enrich` handler. Never let it fall through to the execution handler. |
| Evidence | `planning-inputs.ts`, `prompts.ts`, `approvalInputsFor` in `server.ts`, worker image evidence | Imported context must enter both planning and approval snapshots, with freshness checks. |
| Tests | Vitest; database suites gated by `DCC_TEST_DATABASE_URL`; isolated Playwright runner | Test access through real HTTP routes, database membership joins, uploads and browser journeys. CI already discovers database suites automatically. |

## Alternatives considered

1. **Dedicated reporter routes with shared form and evidence helpers (chosen).** The admin surface remains behind a single strict role boundary; reporter responses are small and explicit. This requires a new page module but makes accidental operational data exposure much less likely.
2. Add role branches throughout every existing admin page and endpoint. Fewer initial routes, but current ticket detail queries assemble extensive operational data and the admin shell loads global counts. Maintaining an exhaustive denylist would be fragile.
3. Separate portal application and authentication service. Strong isolation, but duplicate deployment, sessions and forms are unnecessary for this repository.

For Jam, use the supported remote MCP interface through its official client library. HTML scraping would depend on the viewer's internal implementation. Calling an AI agent to fetch each link would add cost and workflow privileges to simple ingestion.

## Permissions

| Operation | Admin | Active reporter assigned to project | Other reporter / anonymous |
| --- | --- | --- | --- |
| Create/reset/deactivate reporters; edit assignments | Yes | No | No |
| List project identities | All | Assigned projects only, id/name/slug | No |
| Read tickets and attached images | All | Visible tickets in assigned projects | No |
| Create ticket | Existing admin behavior | Enabled assigned project | Public forms retain their existing anonymous submission flow |
| Edit submission content | Yes | Any visible assigned-project ticket | No |
| Change project after creation | Admin only | No, including nested form values | No |
| Delete from reporter views | Existing admin policies; no new admin deletion scope | Own visible ticket, while still assigned | No |
| Read source Jam link/import outcome | Yes | Visible assigned-project ticket | No |
| Read imported Jam details | Yes | No | No |
| Operate or inspect planning/execution and other admin features | Yes | No | No |

Membership and active-account state are checked on each request. Mutation transactions lock the actor's user row before checking memberships; assignment/deactivation transactions take the same lock. A request that commits before revocation can finish; one ordered after revocation cannot mutate the project. An open browser tab grants no continuing access.

Unauthenticated JSON requests receive 401; a reporter using an admin endpoint receives 403 before operational reads; inaccessible ticket/project/attachment identifiers return 404. Mutations require the current session's CSRF token. Unknown roles are denied. Direct admin helper entrypoints also enforce the admin role so internal callers cannot bypass the HTTP dispatcher.

## Data and API boundaries

- Migration `064_project_reporters.sql`: constrain roles to `admin` and `reporter`, change the default to `reporter`, add `project_memberships(user_id, project_id)`, `tickets.created_by_user_id`, `submission_revision`, `submission_updated_at`, `submitter_deleted_at` and `submitter_deleted_by`. Update all intended admin seed/CLI inserts to set `role='admin'` explicitly.
- Migration `065_authenticated_upload_scope.sql`: add nullable `uploads.owner_user_id`, `project_id` and `claim_expires_at`; public uploads retain `form_id`. Authenticated uploads always bind to a current user/project; claims lock attachments and recheck scope. New uploads have a one-hour claim window; claiming clears `claim_expires_at`. A bounded cleanup pass removes never-claimed uploads after a further 23-hour grace period. Legacy and previously claimed artifacts retain their existing lifetime.
- Migration `066_ticket_jam_context.sql`: add nullable `tickets.jam_url`; add one `ticket_jam_contexts` row per ticket with `generation` UUID, state, source URL, data, content hash, safe error code and fetch timestamp. Generations prevent old jobs from overwriting a replaced/cleared link.
- `/api/session`, `/api/logout`: any recognized active role; retain the old admin aliases for existing clients. Existing login returns its current user object; the browser chooses `/admin` or `/tickets` from the role.
- `/api/admin/users` GET/POST; `/api/admin/users/:id` PATCH for reporter account state/project IDs; `/api/admin/users/:id/password` POST. These operations target reporters only in this release.
- `/api/projects` GET returns reporter-safe project choices. `/api/tickets` GET/POST, `/api/tickets/:ref` GET/PATCH/DELETE serve authenticated submission operations with explicit projections. Admin can use these shared submission operations too, with global project access.
- `/api/projects/:id/uploads` POST stages an authenticated upload; `/attachments/:id` GET serves only accessible attached evidence. Existing `/admin/attachments/:id` remains admin-only.
- `/api/admin/tickets/:ref/jam/retry` POST retries a failed/current import without starting planning. Reporter/public saves automatically queue imports; reporters cannot invoke generic jobs or retry endpoints.

Reporter write fields are title, description, category, priority, source URL, environment, expected/actual behavior, reproduction steps, Jam URL, and declared submission custom fields. Create also accepts `project_id`. Attachment arrays use a separate `attachment_upload_ids` map of field key to upload IDs. Updates require `submission_revision`. Creator IDs, role, status, project reassignment, AI fields, notes, plan fields, arbitrary JSON and imported Jam data are rejected, including inside `submission`.

Response projections omit submitter email, operational fields and arbitrary ticket-row properties. Custom fields are included only when declared by a source form and not reserved, hidden or static. Reporter project queries never select repository paths or configuration JSON. Admin is free to see all original submission fields.

## Clipboard behavior

The browser calls `navigator.clipboard.read()` directly from the Paste click and selects PNG/JPEG image representations. It must not read on page load, focus or polling. A copied text URL is not treated as an image. Browser permissions and a secure context are required; the UI gives a short message when unsupported, denied or empty, and keeps Choose files available. [Clipboard API](https://developer.mozilla.org/en-US/docs/Web/API/Clipboard/read)

Both picker and paste use the same upload state: upload immediately, disable submission while uploads are pending, preview locally with a data URL permitted by the existing CSP, retain successful IDs across validation/retry, show per-file failure/retry/remove, and enforce five images per field and 5 MiB per image on the server. Removing an unclaimed preview leaves cleanup to the new upload-specific maintenance pass; the existing artifact reconciler does not expire finalized uploads. Removing an attached image is an authorized ticket edit; it does not delete bytes that are referenced by an approval snapshot.

## Jam import behavior

The documented MCP endpoint is `https://mcp.jam.dev/mcp`. Read tools include `getDetails`, `getConsoleLogs`, `getNetworkRequests`, `getUserEvents` and `getMetadata`; transcript support depends on the capture. Treat absent sections as absent. The integration uses fixed read tools and does not ask an LLM to decide which tools to call. [Jam MCP](https://jam.dev/docs/jam-mcp)

Configure one worker-only `DCC_JAM_TOKEN` for the Nexus operator's Jam workspace with `mcp:read`. PATs have expiry dates and preserve the account's Jam access, so inaccessible/private links may fail. Do not send the token to the web process, browser, agent child environment, audit events or job payloads. Do not fetch user-supplied URLs; validate `https://jam.dev/c/<id>` with no credentials or nondefault port, extract the ID, and call the fixed MCP endpoint. [Jam access tokens](https://jam.dev/docs/personal-access-tokens)

The provider adapter discovers and validates tool argument schemas using `tools/list`; the public documentation does not specify complete input/output schemas. Tests use a captured, sanitized contract fixture plus a mock transport; authenticated live verification is a release prerequisite, not something this planning session claims to have performed.

Persist available device/browser/OS/page context, console errors, network method/path/status/timing, reproduction events and useful metadata after redaction. Drop credentials, cookies, authorization headers, query/fragment values, request/response bodies and typed input values. Escape content in HTML; mark imported content as untrusted evidence in prompts. Store at most 256 KiB normalized evidence and include at most 32 KiB in a prompt, with explicit truncation/partial markers.

Use a 30-second overall import deadline, 10 seconds per tool call, at most five pages per paginated tool and 500 entries per section. Retry transient network/429/5xx failures through the existing queue with three total attempts; respect bounded Retry-After. Permanent access/not-found/schema errors record a safe outcome and finish without retry loops. One failed optional tool produces partial evidence. Final publish rechecks job lease, current generation, current URL and reporter-deletion marker in a transaction; stale jobs finish without publishing.

Saving, changing or clearing the link invalidates the old generation immediately. New ticket and job creation commit together. A repeated save of the same URL must not enqueue duplicates. Import never creates an agent run or changes ticket workflow status. Source changes and normalized evidence changes become material approval inputs; execution receives the approved snapshot. Reporter-visible timestamps change only for submission edits, not background ingestion or workflow activity.

The existing `mark_ticket_plan_potentially_stale(uuid)` function is the freshness mechanism for approved plans. Submission/evidence changes may update this derived flag; they cannot change ticket workflow status or grant reporters approval/execution actions. Deletion only changes portal visibility and does not invalidate a captured operational input.

## Global constraints

- Node.js >=22; pnpm 11.17.0; PostgreSQL 16; TypeScript; existing Node HTTP server and HTML renderer.
- Prefix shell commands with `rtk`; use `rtk proxy` for commands without a suitable filter.
- Preserve existing opaque sessions, Argon2 password hashing, CSRF checks, upload signature checks, artifact integrity and worker lease checks.
- Only admins may access `/admin` and `/api/admin/*`, except the existing public login and explicitly shared session/logout aliases.
- Reporter mutations never enqueue planning/execution jobs or mutate operational workflow state.
- New database tests run against disposable databases, one database per test file; never point reset-based tests at an existing environment.
- No production migration, deployment, account creation or Jam credential configuration is part of this planning task.

## Delivery order and acceptance

1. [User access plan](../plans/2026-09-10-project-ticket-access.md): complete working user administration and ticket-only portal, with revocation and ownership tests.
2. [Image plan](../plans/2026-09-10-ticket-image-paste.md): add clipboard/picker evidence to public and authenticated create/edit forms, with scope and retry tests.
3. [Jam plan](../plans/2026-09-10-ticket-jam-import.md): validate links, queue/import evidence and include it in approval snapshots, with failure and replacement races tested.

The image plan depends on the access plan's authenticated ticket service. The Jam plan builds on its transaction boundaries and the image plan's evidence editing/approval checks. Each increment must pass its own tests before the next. The two account roles must be verified against every admin route family, and a complete browser journey must prove admin creates user → assigns project → user signs in → creates/edits/deletes tickets → assignment revoked → access denied.
