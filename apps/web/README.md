# Web service

The web process owns HTTP authentication and database-backed admin APIs. It
does not receive Claude credentials, GitHub write credentials, repository
shell access, or permission to start worker processes.

Login returns the CSRF token as `csrfToken` in the JSON response and sets an
opaque `dcc_session` HttpOnly cookie with `SameSite=Lax` (and `Secure` in
production). Mutating `/api/admin/*` requests must send that token in the
`X-CSRF-Token` header. Sessions are stored server-side, expire after eight
hours, and can be invalidated by logout.
