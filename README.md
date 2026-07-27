# Development Control Center

Phase 1 provides the web/worker process boundary, PostgreSQL migrations,
admin authentication, project configuration and validation, audit events,
health checks, and a transactional database job queue.

Set `DATABASE_URL`, run `pnpm --filter database migrate`, create an admin
with `pnpm admin:create -- --username NAME --password VALUE
--non-interactive`, then start both services with `pnpm dev`.
