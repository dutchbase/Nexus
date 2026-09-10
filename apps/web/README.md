# Web service

The web process owns HTTP authentication and database-backed admin APIs. It
does not receive Claude credentials, GitHub write credentials, repository
shell access, or permission to start worker processes.

Login returns the CSRF token as `csrfToken` in the JSON response and sets an
opaque `dcc_session` HttpOnly cookie with `SameSite=Lax` (and `Secure` in
production). Mutating requests must send that token in the `X-CSRF-Token`
header. `/api/session` and `/api/logout` are shared by administrators and
reporters; `/api/admin/*` and `/admin/*` require an administrator session.
Sessions are stored server-side, expire after eight hours, and can be
invalidated by logout.

Administrators create reporters and manage their project memberships at
`/admin/users`. They can also reset passwords and deactivate or reactivate an
account. Membership changes are checked on every request, so removing a
project immediately blocks its ticket and attachment APIs even when the
reporter still has the page open.

Reporters use `/tickets`. They may list and create tickets only in assigned
projects and edit the submission fields of any ticket they can see. They may
delete only tickets they created. A reporter deletion removes the ticket from
reporter views but keeps the admin record and all operational history, marked
`Deleted by submitter`; it does not cancel or restart planning or execution.
