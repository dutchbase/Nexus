-- End-to-end fixture data for Nexus.
-- A mock dataset (4 projects, 14 tickets, 13 skills, 7 PRs, 8 runs, 8 jobs,
-- 4 forms) INCLUDING the four intentional unhappy paths: customer-portal is
-- a dirty repository, DCC-144 has a failed validation, delivery ND-8841
-- failed with a 504, and RUN-0898 timed out.
--
-- Every organization, repository, and user name below is fictional — this
-- file is tracked in a repository prepared for public release, so keep it
-- that way when adding rows.
--
-- CONTRACT this file assumes about the migrations in packages/database:
--   * every table/column name matches PRD §26 verbatim (snake_case, as given)
--   * every `id` column is `uuid` (or `text` holding a UUID-shaped literal)
--   * every `*_at` / `*_created`/`*_updated` timestamp column is `timestamptz`
--   * every `*_json` column is `jsonb`
--   * boolean flags (`enabled`, `is_active`, `required`, `draft`, `merged`,
--     `is_draft`, `allow_ticket_override`, `required` on project_skills) are
--     `boolean`
--   * status/enum-like columns are free `text` holding the exact strings
--     from PRD §17.1 (ticket status) or the literal values used below
--
-- Idempotent: safe to re-run after `TRUNCATE ... CASCADE` (see
-- tests/e2e/run-e2e.sh, which loads this into a fresh ephemeral database).

BEGIN;

-- ============================================================ users
-- Deliberately NOT seeded here. A hand-written password_hash literal can't be
-- verified as a real Argon2id hash without running the app's own hasher, and
-- a login test against a fake hash proves nothing. The admin user is created
-- by run-e2e.sh invoking the real `scripts/create-admin.ts` (PRD §10)
-- non-interactively with E2E_ADMIN_USER / E2E_ADMIN_PASSWORD BEFORE this file
-- is loaded — that exercises the real Argon2id path end-to-end and is what
-- SEC-10 actually asserts.

-- ============================================================ projects
INSERT INTO projects (id, slug, name, description, enabled, repository_path, github_owner, github_repository, default_branch, config_json, config_version, health_status, last_validated_at, created_at, updated_at) VALUES
('00000000-0000-0000-0000-000000000001','va-jobs-platform','VA Jobs Platform','Main Virtual Assistant jobs platform',true,'__REPO_PATH_VA_JOBS_PLATFORM__','example-org','va-jobs-platform','main',
  '{"ai":{"default_model":"sonnet","default_reasoning_level":"high","planning":{"model":"opus","reasoning_level":"high"}},"skills":{"automatic":["ponytail","project-conventions","secure-development","testing-standards"]}}'::jsonb,
  1,'healthy',now() - interval '2 minutes',now(),now()),
('00000000-0000-0000-0000-000000000002','corporate-site','Corporate Site','Public marketing website and vacancy pages',true,'__REPO_PATH_CORPORATE_SITE__','example-org','corporate-site','main',
  '{"ai":{"default_model":"sonnet","default_reasoning_level":"medium","planning":{"model":"sonnet","reasoning_level":"high"}},"skills":{"automatic":["ponytail","seo","secure-development"]}}'::jsonb,
  1,'healthy',now() - interval '11 minutes',now(),now()),
('00000000-0000-0000-0000-000000000003','customer-portal','Customer Portal','Authenticated client dashboard and billing views',true,'__REPO_PATH_CUSTOMER_PORTAL__','example-org','customer-portal','main',
  '{"ai":{"default_model":"opus","default_reasoning_level":"high","planning":{"model":"opus","reasoning_level":"xhigh"}},"skills":{"automatic":["ponytail","secure-development","testing-standards","accessibility"]}}'::jsonb,
  1,'repository_dirty',now() - interval '38 minutes',now(),now()),
('00000000-0000-0000-0000-000000000004','billing-api','Billing API','Invoicing, subscriptions and SEPA collection service',true,'__REPO_PATH_BILLING_API__','example-org','billing-api','main',
  '{"ai":{"default_model":"sonnet","default_reasoning_level":"high","planning":{"model":"opus","reasoning_level":"high"}},"skills":{"automatic":["ponytail","secure-development","api-conventions","testing-standards"]}}'::jsonb,
  1,'healthy',now() - interval '4 minutes',now(),now())
ON CONFLICT (id) DO NOTHING;

-- ============================================================ forms
INSERT INTO forms (id, name, slug, title, description, status, fixed_project_id, settings_json, published_at, created_at, updated_at) VALUES
('00000000-0000-0000-0005-000000000001','Website feedback','website-feedback','Feedback over de website','Public site feedback form','published',NULL,'{"selectable_projects":4,"fields":9}'::jsonb, now() - interval '2 days', now(), now()),
('00000000-0000-0000-0005-000000000002','Internal bug report','internal-bug','Interne bugmelding','Internal bug intake','published',NULL,'{"selectable_projects":4,"fields":12}'::jsonb, now() - interval '5 days', now(), now()),
('00000000-0000-0000-0005-000000000003','UI and UX feedback','ui-ux-feedback','Wat kan er beter?','UX feedback form','published','00000000-0000-0000-0000-000000000002','{"fields":7}'::jsonb, now() - interval '7 days', now(), now()),
('00000000-0000-0000-0005-000000000004','Customer portal feedback','portal-feedback','Portal feedback','Draft portal feedback form','draft','00000000-0000-0000-0000-000000000003','{"fields":8}'::jsonb, NULL, now() - interval '3 hours', now())
ON CONFLICT (id) DO NOTHING;

-- ============================================================ skills
INSERT INTO skills (id, slug, name, description, category, source_type, filesystem_path, enabled, risk_level, version, content_hash, configuration_json, created_at, updated_at) VALUES
('00000000-0000-0000-0001-000000000001','ponytail','Ponytail','Minimal-code implementation discipline: solve the problem with the least new surface area.','Architecture','workspace_global','skills/global/ponytail/SKILL.md',true,'low','2.4.0','9f3ac1','{}'::jsonb,now(),now()),
('00000000-0000-0000-0001-000000000002','project-conventions','Project conventions','Repository layout, naming, module boundaries and import rules for this project.','Architecture','project_local','skills/projects/va-jobs-platform/project-conventions/SKILL.md',true,'low','1.8.2','c02be7','{}'::jsonb,now(),now()),
('00000000-0000-0000-0001-000000000003','secure-development','Secure development','Input validation, authz checks, secret handling and dependency hygiene.','Security','workspace_global','skills/global/secure-development/SKILL.md',true,'low','3.1.0','71dd90','{}'::jsonb,now(),now()),
('00000000-0000-0000-0001-000000000004','testing-standards','Testing standards','Unit, integration and regression test expectations per change type.','Testing','workspace_global','skills/global/testing-standards/SKILL.md',true,'low','2.0.1','4ae112','{}'::jsonb,now(),now()),
('00000000-0000-0000-0001-000000000005','frontend-design','Frontend design','Design-system usage, component composition, responsive and state coverage.','Frontend','workspace_global','skills/global/frontend-design/SKILL.md',true,'low','1.5.0','8bc3f4','{}'::jsonb,now(),now()),
('00000000-0000-0000-0001-000000000006','database-migration','Database migration','Reversible migrations, backfill strategy and zero-downtime deploy rules.','Database','project_local','skills/projects/billing-api/database-migration/SKILL.md',true,'high','1.2.3','d5e6a0','{}'::jsonb,now(),now()),
('00000000-0000-0000-0001-000000000007','performance-review','Performance review','Query plans, N+1 detection, bundle budgets and caching strategy.','Performance','workspace_global','skills/global/performance-review/SKILL.md',true,'medium','1.0.4','2f88bd','{}'::jsonb,now(),now()),
('00000000-0000-0000-0001-000000000008','accessibility','Accessibility','WCAG 2.2 AA checks: contrast, focus order, labels, keyboard paths.','Accessibility','workspace_global','skills/global/accessibility/SKILL.md',true,'low','2.2.0','6c41ea','{}'::jsonb,now(),now()),
('00000000-0000-0000-0001-000000000009','playwright-e2e','Playwright E2E','End-to-end coverage for the project happy paths and regression scenarios.','Testing','project_local','skills/projects/va-jobs-platform/playwright-e2e/SKILL.md',true,'medium','1.7.1','ba9037','{}'::jsonb,now(),now()),
('00000000-0000-0000-0001-000000000010','seo','SEO','Metadata, structured data, canonical rules and crawl budget considerations.','SEO','workspace_global','skills/global/seo/SKILL.md',true,'low','1.1.0','3ed57c','{}'::jsonb,now(),now()),
('00000000-0000-0000-0001-000000000011','code-review','Code review','Self-review checklist run before the work is considered complete.','Architecture','workspace_global','skills/global/code-review/SKILL.md',true,'low','1.4.0','af2210','{}'::jsonb,now(),now()),
('00000000-0000-0000-0001-000000000012','api-conventions','API conventions','Route shape, error envelope, pagination and versioning rules.','Backend','project_local','skills/projects/billing-api/api-conventions/SKILL.md',true,'low','2.6.0','55b7c9','{}'::jsonb,now(),now()),
('00000000-0000-0000-0001-000000000013','deployment-rules','Deployment rules','Release windows, migration ordering and rollback preparation.','DevOps','workspace_global','skills/global/deployment-rules/SKILL.md',false,'high','1.0.0','e10bb3','{}'::jsonb,now(),now())
ON CONFLICT (id) DO NOTHING;

-- ============================================================ project_skills (automatic skills per project)
INSERT INTO project_skills (id, project_id, skill_id, attachment_type, required, allow_ticket_override, created_at) VALUES
(gen_random_uuid(),'00000000-0000-0000-0000-000000000001','00000000-0000-0000-0001-000000000001','automatic',true,false,now()),
(gen_random_uuid(),'00000000-0000-0000-0000-000000000001','00000000-0000-0000-0001-000000000002','automatic',true,false,now()),
(gen_random_uuid(),'00000000-0000-0000-0000-000000000001','00000000-0000-0000-0001-000000000003','automatic',true,false,now()),
(gen_random_uuid(),'00000000-0000-0000-0000-000000000001','00000000-0000-0000-0001-000000000004','automatic',true,false,now()),
(gen_random_uuid(),'00000000-0000-0000-0000-000000000002','00000000-0000-0000-0001-000000000001','automatic',true,false,now()),
(gen_random_uuid(),'00000000-0000-0000-0000-000000000002','00000000-0000-0000-0001-000000000010','automatic',true,false,now()),
(gen_random_uuid(),'00000000-0000-0000-0000-000000000002','00000000-0000-0000-0001-000000000003','automatic',true,false,now()),
(gen_random_uuid(),'00000000-0000-0000-0000-000000000003','00000000-0000-0000-0001-000000000001','automatic',true,false,now()),
(gen_random_uuid(),'00000000-0000-0000-0000-000000000003','00000000-0000-0000-0001-000000000003','automatic',true,false,now()),
(gen_random_uuid(),'00000000-0000-0000-0000-000000000003','00000000-0000-0000-0001-000000000004','automatic',true,false,now()),
(gen_random_uuid(),'00000000-0000-0000-0000-000000000003','00000000-0000-0000-0001-000000000008','automatic',true,false,now()),
(gen_random_uuid(),'00000000-0000-0000-0000-000000000004','00000000-0000-0000-0001-000000000001','automatic',true,false,now()),
(gen_random_uuid(),'00000000-0000-0000-0000-000000000004','00000000-0000-0000-0001-000000000003','automatic',true,false,now()),
(gen_random_uuid(),'00000000-0000-0000-0000-000000000004','00000000-0000-0000-0001-000000000012','automatic',true,false,now()),
(gen_random_uuid(),'00000000-0000-0000-0000-000000000004','00000000-0000-0000-0001-000000000004','automatic',true,false,now());

-- ============================================================ tickets
-- project_id lookups: va-jobs-platform=...001, corporate-site=...002, customer-portal=...003, billing-api=...004
INSERT INTO tickets (id, ticket_number, form_id, project_id, title, description, category, priority, status, submitter_name, submitter_email, source_url, environment, expected_behavior, actual_behavior, reproduction_steps, custom_values_json, ai_configuration_mode, default_model, default_reasoning_level, planning_model, planning_reasoning_level, execution_model, execution_reasoning_level, repair_model, repair_reasoning_level, approved_plan_version_id, created_at, updated_at) VALUES
('00000000-0000-0000-0000-000000000148','DCC-148','00000000-0000-0000-0005-000000000001','00000000-0000-0000-0000-000000000001','Mobile navigation overlaps page content','On narrow viewports the sidebar overlaps the hero.','UI','high','Submitted','anoniem',NULL,'https://vajobs.example.com/','iOS Safari 17','Nav should not overlap content','Nav overlaps content below 400px width','1. Open on iPhone SE\n2. Scroll to hero','{}'::jsonb,'basic','sonnet','high',NULL,NULL,NULL,NULL,NULL,NULL,NULL, now() - interval '6 minutes', now() - interval '6 minutes'),
('00000000-0000-0000-0000-000000000147','DCC-147','00000000-0000-0000-0005-000000000002','00000000-0000-0000-0000-000000000001','Add CSV export to the candidate list','Recruiters want a CSV export button.','Feature','medium','Triage','alice',NULL,NULL,NULL,'CSV downloads all visible candidates','No export option exists',NULL,'{}'::jsonb,'basic','sonnet','high',NULL,NULL,NULL,NULL,NULL,NULL,NULL, now() - interval '41 minutes', now() - interval '9 minutes'),
('00000000-0000-0000-0000-000000000146','DCC-146','00000000-0000-0000-0005-000000000002','00000000-0000-0000-0000-000000000004','Invoice PDF totals rounded incorrectly','Totals off by a cent on multi-line invoices.','Bug','critical','Executing','finance',NULL,NULL,'Production','Totals match line-item sum','Totals rounded per line then summed',NULL,'{}'::jsonb,'basic','sonnet','high',NULL,NULL,NULL,NULL,NULL,NULL,NULL, now() - interval '3 hours', now() - interval '2 minutes'),
('00000000-0000-0000-0000-000000000145','DCC-145','00000000-0000-0000-0005-000000000001','00000000-0000-0000-0000-000000000002','Cookie banner blocks the primary CTA on iOS Safari','Banner overlays the CTA button on iOS Safari.','Bug','high','Plan Ready for Review','l.dewit',NULL,NULL,'iOS Safari','Banner should not overlap CTA','Banner overlaps CTA on iOS Safari only',NULL,'{}'::jsonb,'basic','opus','high',NULL,NULL,NULL,NULL,NULL,NULL,NULL, now() - interval '5 hours', now() - interval '26 minutes'),
('00000000-0000-0000-0000-000000000144','DCC-144','00000000-0000-0000-0005-000000000004','00000000-0000-0000-0000-000000000003','Password reset e-mail never arrives','Customers report the reset e-mail never sends.','Bug','critical','Validation Failed','support',NULL,NULL,'Production','Reset e-mail arrives within 1 minute','No e-mail is ever sent',NULL,'{}'::jsonb,'basic','opus','xhigh',NULL,NULL,NULL,NULL,NULL,NULL,NULL, now() - interval '8 hours', now() - interval '34 minutes'),
('00000000-0000-0000-0000-000000000143','DCC-143','00000000-0000-0000-0005-000000000003','00000000-0000-0000-0000-000000000001','Improve the empty state for saved searches','Empty state is a blank page.','UX','low','Needs Information','k.vermeer',NULL,NULL,NULL,'Helpful empty state with CTA','Blank page',NULL,'{}'::jsonb,'basic','sonnet','medium',NULL,NULL,NULL,NULL,NULL,NULL,NULL, now() - interval '1 day', now() - interval '5 hours'),
('00000000-0000-0000-0000-000000000142','DCC-142','00000000-0000-0000-0005-000000000001','00000000-0000-0000-0000-000000000001','Search filters reset when navigating back','Filters clear when using browser back.','Bug','high','Plan Ready for Review','t.van.damme',NULL,NULL,NULL,'Filters persist on back navigation','Filters reset to default',NULL,'{}'::jsonb,'basic','opus','high',NULL,NULL,NULL,NULL,NULL,NULL,NULL, now() - interval '1 day', now() - interval '18 minutes'),
('00000000-0000-0000-0000-000000000141','DCC-141','00000000-0000-0000-0005-000000000002','00000000-0000-0000-0000-000000000004','Add SEPA direct debit as a payment option','Customers want SEPA mandate support.','Feature','medium','Plan Approved','finance',NULL,NULL,NULL,'SEPA available at checkout','Only card payments supported',NULL,'{}'::jsonb,'basic','opus','high',NULL,NULL,NULL,NULL,NULL,NULL,NULL, now() - interval '2 days', now() - interval '1 hour'),
('00000000-0000-0000-0000-000000000140','DCC-140','00000000-0000-0000-0005-000000000003','00000000-0000-0000-0000-000000000002','Contrast too low on secondary buttons','Fails WCAG AA contrast.','Accessibility','medium','PR Ready for Review','a.jansen',NULL,NULL,NULL,'Contrast passes WCAG AA','Contrast ratio 3.1:1',NULL,'{}'::jsonb,'basic','sonnet','high',NULL,NULL,NULL,NULL,NULL,NULL,NULL, now() - interval '2 days', now() - interval '3 hours'),
('00000000-0000-0000-0000-000000000139','DCC-139','00000000-0000-0000-0005-000000000004','00000000-0000-0000-0000-000000000003','Session expires after five minutes of inactivity','Session TTL too short for the portal.','Bug','critical','PR Changes Requested','support',NULL,NULL,'Production','Session lasts 30 minutes idle','Session expires after 5 minutes',NULL,'{}'::jsonb,'basic','opus','high',NULL,NULL,NULL,NULL,NULL,NULL,NULL, now() - interval '3 days', now() - interval '6 hours'),
('00000000-0000-0000-0000-000000000138','DCC-138','00000000-0000-0000-0005-000000000002','00000000-0000-0000-0000-000000000001','Job alert e-mails contain broken vacancy links','Links 404.','Bug','high','Merged','alice',NULL,NULL,NULL,'Links resolve to the vacancy','Links 404',NULL,'{}'::jsonb,'basic','sonnet','high',NULL,NULL,NULL,NULL,NULL,NULL,NULL, now() - interval '4 days', now() - interval '1 day'),
('00000000-0000-0000-0000-000000000137','DCC-137','00000000-0000-0000-0005-000000000004','00000000-0000-0000-0000-000000000003','Portal logs me out at random','Unreproducible.','Bug','low','Rejected','anoniem',NULL,NULL,NULL,'No random logout','Logs out randomly',NULL,'{}'::jsonb,'basic','sonnet','medium',NULL,NULL,NULL,NULL,NULL,NULL,NULL, now() - interval '4 days', now() - interval '4 days'),
('00000000-0000-0000-0000-000000000136','DCC-136','00000000-0000-0000-0005-000000000001','00000000-0000-0000-0000-000000000002','Add structured data to vacancy detail pages','SEO improvement.','SEO','medium','Completed','bob',NULL,NULL,NULL,'JobPosting structured data present','No structured data',NULL,'{}'::jsonb,'basic','sonnet','high',NULL,NULL,NULL,NULL,NULL,NULL,NULL, now() - interval '6 days', now() - interval '2 days'),
('00000000-0000-0000-0000-000000000135','DCC-135','00000000-0000-0000-0005-000000000002','00000000-0000-0000-0000-000000000001','Slow query on the applications overview','N+1 query pattern.','Performance','high','Planning','ops',NULL,NULL,'Production','Page loads under 500ms','Page takes 4s+',NULL,'{}'::jsonb,'basic','opus','xhigh',NULL,NULL,NULL,NULL,NULL,NULL,NULL, now() - interval '6 days', now() - interval '1 minute')
ON CONFLICT (id) DO NOTHING;

-- ============================================================ pull_requests
INSERT INTO pull_requests (id, project_id, ticket_id, execution_attempt_id, provider, repository, number, url, title, author, state, review_state, check_state, is_draft, head_branch, base_branch, head_sha, merge_commit_sha, created_at_provider, updated_at_provider, merged_at, closed_at, last_synced_at, created_at, updated_at) VALUES
(gen_random_uuid(),'00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000140',NULL,'github','example-org/corporate-site',218,'http://127.0.0.1:8991/example-org/corporate-site/pull/218','Raise secondary button contrast to WCAG AA','dcc-worker','open','review_required','success',true,'feedback/DCC-140-button-contrast','main','a1b2c3d',NULL, now() - interval '3 hours', now() - interval '2 hours', NULL, NULL, now(), now(), now()),
(gen_random_uuid(),'00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000139',NULL,'github','example-org/customer-portal',177,'http://127.0.0.1:8991/example-org/customer-portal/pull/177','Extend session lifetime and add sliding refresh','dcc-worker','open','changes_requested','failure',false,'feedback/DCC-139-session-lifetime','main','b2c3d4e',NULL, now() - interval '6 hours', now() - interval '1 hour', NULL, NULL, now(), now(), now()),
(gen_random_uuid(),'00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000138',NULL,'github','example-org/va-jobs-platform',642,'http://127.0.0.1:8991/example-org/va-jobs-platform/pull/642','Fix vacancy link generation in alert e-mails','dcc-worker','closed','approved','success',false,'feedback/DCC-138-alert-links','main','c3d4e5f','d4e5f6a', now() - interval '1 day', now() - interval '22 hours', now() - interval '22 hours', now() - interval '22 hours', now(), now(), now()),
(gen_random_uuid(),'00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000136',NULL,'github','example-org/corporate-site',211,'http://127.0.0.1:8991/example-org/corporate-site/pull/211','Add JobPosting structured data to vacancy pages','dcc-worker','closed','approved','success',false,'feedback/DCC-136-structured-data','main','e5f6a7b','f6a7b8c', now() - interval '2 days', now() - interval '2 days', now() - interval '2 days', now() - interval '2 days', now(), now(), now()),
(gen_random_uuid(),'00000000-0000-0000-0000-000000000001',NULL,NULL,'github','example-org/va-jobs-platform',640,'http://127.0.0.1:8991/example-org/va-jobs-platform/pull/640','Bump pnpm lockfile and drop unused deps','alice','open','review_required','pending',false,'chore/deps-july','main','a7b8c9d',NULL, now() - interval '9 hours', now() - interval '4 hours', NULL, NULL, now(), now(), now()),
(gen_random_uuid(),'00000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000141',NULL,'github','example-org/billing-api',96,'http://127.0.0.1:8991/example-org/billing-api/pull/96','Introduce SEPA mandate table and provider port','dcc-worker','open','draft','pending',true,'feedback/DCC-141-sepa-mandate','main','b8c9d0e',NULL, now() - interval '1 hour', now() - interval '26 minutes', NULL, NULL, now(), now(), now()),
(gen_random_uuid(),'00000000-0000-0000-0000-000000000003',NULL,NULL,'github','example-org/customer-portal',174,'http://127.0.0.1:8991/example-org/customer-portal/pull/174','Revert billing widget experiment','bob','closed',NULL,NULL,false,'revert/billing-widget','main','c9d0e1f',NULL, now() - interval '5 days', now() - interval '4 days', NULL, now() - interval '4 days', now(), now(), now())
ON CONFLICT DO NOTHING;

-- ============================================================ agent_runs
INSERT INTO agent_runs (id, ticket_id, project_id, run_type, status, claude_session_id, model, reasoning_level, working_directory, prompt_snapshot_id, skill_snapshot_id, started_at, finished_at, exit_code, error_code, error_message, metadata_json) VALUES
('00000000-0000-0000-0003-000000000913','00000000-0000-0000-0000-000000000135','00000000-0000-0000-0000-000000000001','planning','running','sess-0913','opus','xhigh','__REPO_PATH_VA_JOBS_PLATFORM__',NULL,NULL, now() - interval '1 minute', NULL, NULL, NULL, NULL, '{"turn":6,"max_turns":40}'::jsonb),
('00000000-0000-0000-0003-000000000912','00000000-0000-0000-0000-000000000146','00000000-0000-0000-0000-000000000004','execution','running','sess-0912','sonnet','high','data/worktrees/billing-api/DCC-146/1',NULL,NULL, now() - interval '14 minutes', NULL, NULL, NULL, NULL, '{"turn":61,"max_turns":150}'::jsonb),
('00000000-0000-0000-0003-000000000911','00000000-0000-0000-0000-000000000142','00000000-0000-0000-0000-000000000001','plan_revision','completed','sess-0911','opus','high','__REPO_PATH_VA_JOBS_PLATFORM__',NULL,NULL, now() - interval '18 minutes', now() - interval '14 minutes', 0, NULL, NULL, '{"turn":22,"max_turns":40}'::jsonb),
('00000000-0000-0000-0003-000000000910','00000000-0000-0000-0000-000000000145','00000000-0000-0000-0000-000000000002','planning','completed','sess-0910','opus','high','__REPO_PATH_CORPORATE_SITE__',NULL,NULL, now() - interval '26 minutes', now() - interval '23 minutes', 0, NULL, NULL, '{"turn":17,"max_turns":40}'::jsonb),
('00000000-0000-0000-0003-000000000907','00000000-0000-0000-0000-000000000144','00000000-0000-0000-0000-000000000003','execution','failed','sess-0907','opus','xhigh','data/worktrees/customer-portal/DCC-144/2',NULL,NULL, now() - interval '34 minutes', now() - interval '12 minutes', 0,'validation_failed','typecheck failed: 3 errors in session.server.ts', '{"turn":88,"max_turns":150}'::jsonb),
('00000000-0000-0000-0003-000000000905','00000000-0000-0000-0000-000000000141','00000000-0000-0000-0000-000000000004','planning','completed','sess-0905','opus','high','__REPO_PATH_BILLING_API__',NULL,NULL, now() - interval '1 hour', now() - interval '54 minutes', 0, NULL, NULL, '{"turn":29,"max_turns":40}'::jsonb),
('00000000-0000-0000-0003-000000000901','00000000-0000-0000-0000-000000000140','00000000-0000-0000-0000-000000000002','execution','completed','sess-0901','sonnet','high','data/worktrees/corporate-site/DCC-140/1',NULL,NULL, now() - interval '3 hours', now() - interval '2 hours 49 minutes', 0, NULL, NULL, '{"turn":44,"max_turns":150}'::jsonb),
('00000000-0000-0000-0003-000000000898','00000000-0000-0000-0000-000000000143','00000000-0000-0000-0000-000000000001','planning','timed_out','sess-0898','sonnet','medium','__REPO_PATH_VA_JOBS_PLATFORM__',NULL,NULL, now() - interval '5 hours', now() - interval '4 hours 15 minutes', NULL,'timeout','planning hit 40 turns', '{"turn":40,"max_turns":40}'::jsonb)
ON CONFLICT (id) DO NOTHING;

-- ============================================================ jobs
INSERT INTO jobs (id, type, status, priority, payload_json, idempotency_key, attempt, max_attempts, available_at, claimed_at, claimed_by, completed_at, error_json, created_at, updated_at) VALUES
('00000000-0000-0000-0004-000000040219','execution.run','running','high','{"ticket":"DCC-146"}'::jsonb,'idem-40219',1,3, now() - interval '14 minutes', now() - interval '14 minutes','worker-01',NULL,NULL, now() - interval '14 minutes', now()),
('00000000-0000-0000-0004-000000040220','planning.generate','running','normal','{"ticket":"DCC-135"}'::jsonb,'idem-40220',1,3, now() - interval '1 minute', now() - interval '1 minute','worker-01',NULL,NULL, now() - interval '1 minute', now()),
('00000000-0000-0000-0004-000000040221','execution.prepare','queued','normal','{"ticket":"DCC-141"}'::jsonb,'idem-40221',0,3, now() + interval '2 minutes', NULL, NULL, NULL, NULL, now(), now()),
('00000000-0000-0000-0004-000000040222','github.sync_all_prs','queued','low','{}'::jsonb,'idem-40222',0,5, now() + interval '4 minutes', NULL, NULL, NULL, NULL, now(), now()),
('00000000-0000-0000-0004-000000040218','notification.send','failed','normal','{"ticket":"DCC-145","event":"plan.ready_for_review"}'::jsonb,'idem-40218',3,5, now() + interval '8 minutes', now() - interval '26 minutes','worker-01', now() - interval '26 minutes', '{"message":"Gateway timeout after 10s","code":504}'::jsonb, now() - interval '30 minutes', now()),
('00000000-0000-0000-0004-000000040217','execution.validate','failed','high','{"ticket":"DCC-144"}'::jsonb,'idem-40217',2,2, NULL, now() - interval '34 minutes','worker-01', now() - interval '34 minutes', '{"message":"typecheck failed: 3 errors in session.server.ts"}'::jsonb, now() - interval '40 minutes', now()),
('00000000-0000-0000-0004-000000040216','github.create_pr','completed','normal','{"ticket":"DCC-140"}'::jsonb,'idem-40216',1,3, NULL, now() - interval '3 hours','worker-01', now() - interval '3 hours', NULL, now() - interval '3 hours 5 minutes', now()),
('00000000-0000-0000-0004-000000040215','cleanup.worktree','completed','low','{"ticket":"DCC-138"}'::jsonb,'idem-40215',1,3, NULL, now() - interval '22 hours','worker-01', now() - interval '22 hours', NULL, now() - interval '22 hours 5 minutes', now())
ON CONFLICT (id) DO NOTHING;

-- ============================================================ notification_providers
INSERT INTO notification_providers (id, name, type, enabled, configuration_encrypted_json, created_at, updated_at) VALUES
('00000000-0000-0000-0006-000000000001','WhatsApp server','whatsapp',false,'{"base_url":null,"endpoint":null}'::jsonb, now(), now()),
('00000000-0000-0000-0006-000000000002','Generic webhook','webhook',true,'{"endpoint":"http://127.0.0.1:8992/notify"}'::jsonb, now(), now())
ON CONFLICT (id) DO NOTHING;

-- ============================================================ notification_deliveries
-- Successful deliveries use status 'sent': migration 046 tightened the
-- notification_deliveries status constraint and dropped 'delivered'.
INSERT INTO notification_deliveries (id, provider_id, event_type, ticket_id, project_id, run_id, pull_request_id, idempotency_key, payload_json, status, attempt_count, response_status, error_message, sent_at, created_at, updated_at) VALUES
('00000000-0000-0000-0006-000000008841','00000000-0000-0000-0006-000000000001','plan.ready_for_review','00000000-0000-0000-0000-000000000145','00000000-0000-0000-0000-000000000002',NULL,NULL,'idem-nd-8841','{"ticket":"DCC-145"}'::jsonb,'failed',3,504,'Gateway timeout after 10s', now() - interval '26 minutes', now() - interval '30 minutes', now()),
('00000000-0000-0000-0006-000000008840','00000000-0000-0000-0006-000000000002','ticket.created','00000000-0000-0000-0000-000000000148','00000000-0000-0000-0000-000000000001',NULL,NULL,'idem-nd-8840','{"ticket":"DCC-148"}'::jsonb,'sent',1,200,NULL, now() - interval '6 minutes', now() - interval '6 minutes', now()),
('00000000-0000-0000-0006-000000008839','00000000-0000-0000-0006-000000000002','execution.started','00000000-0000-0000-0000-000000000146','00000000-0000-0000-0000-000000000004',NULL,NULL,'idem-nd-8839','{"ticket":"DCC-146"}'::jsonb,'sent',1,200,NULL, now() - interval '14 minutes', now() - interval '14 minutes', now()),
('00000000-0000-0000-0006-000000008838','00000000-0000-0000-0006-000000000002','validation.failed','00000000-0000-0000-0000-000000000144','00000000-0000-0000-0000-000000000003',NULL,NULL,'idem-nd-8838','{"ticket":"DCC-144"}'::jsonb,'sent',2,200,NULL, now() - interval '34 minutes', now() - interval '40 minutes', now()),
('00000000-0000-0000-0006-000000008837','00000000-0000-0000-0006-000000000002','pr.ready_for_review','00000000-0000-0000-0000-000000000140','00000000-0000-0000-0000-000000000002',NULL,NULL,'idem-nd-8837','{"ticket":"DCC-140"}'::jsonb,'sent',1,200,NULL, now() - interval '3 hours', now() - interval '3 hours', now()),
('00000000-0000-0000-0006-000000008836','00000000-0000-0000-0006-000000000002','pr.changes_requested','00000000-0000-0000-0000-000000000139','00000000-0000-0000-0000-000000000003',NULL,NULL,'idem-nd-8836','{"ticket":"DCC-139"}'::jsonb,'sent',1,200,NULL, now() - interval '1 hour', now() - interval '1 hour', now())
ON CONFLICT (id) DO NOTHING;

-- ============================================================ audit_events
INSERT INTO audit_events (id, actor_type, actor_id, action, entity_type, entity_id, before_json, after_json, metadata_json, ip_address, created_at) VALUES
('00000000-0000-0000-0007-000000000001','system',NULL,'run.timed_out','agent_run','00000000-0000-0000-0003-000000000898',NULL,'{"status":"timed_out"}'::jsonb,'{"turns":"40/40"}'::jsonb,'127.0.0.1', now() - interval '5 hours'),
('00000000-0000-0000-0007-000000000002','system',NULL,'project.repository_dirty','project','00000000-0000-0000-0000-000000000003',NULL,'{"health_status":"repository_dirty"}'::jsonb,'{"uncommitted_files":3}'::jsonb,'127.0.0.1', now() - interval '38 minutes'),
('00000000-0000-0000-0007-000000000003','system',NULL,'validation.typecheck_failed','execution_attempt','00000000-0000-0000-0003-000000000907',NULL,'{"errors":3}'::jsonb,'{"file":"session.server.ts"}'::jsonb,'127.0.0.1', now() - interval '34 minutes'),
('00000000-0000-0000-0007-000000000004','system',NULL,'notification.delivery_timeout','notification_delivery','00000000-0000-0000-0006-000000008841',NULL,'{"status":"failed"}'::jsonb,'{"code":504}'::jsonb,'127.0.0.1', now() - interval '26 minutes'),
('00000000-0000-0000-0007-000000000005','admin',NULL,'login','user','00000000-0000-0000-0000-000000000000',NULL,'{"success":true}'::jsonb,'{}'::jsonb,'127.0.0.1', now() - interval '2 hours'),
('00000000-0000-0000-0007-000000000006','admin',NULL,'ticket.approve_planning','ticket','00000000-0000-0000-0000-000000000135','{"status":"Triage"}'::jsonb,'{"status":"Approved for Planning"}'::jsonb,'{}'::jsonb,'127.0.0.1', now() - interval '2 minutes'),
('00000000-0000-0000-0007-000000000007','admin',NULL,'plan.approve','plan_version','00000000-0000-0000-0000-000000000141',NULL,'{"status":"approved"}'::jsonb,'{}'::jsonb,'127.0.0.1', now() - interval '1 hour'),
('00000000-0000-0000-0007-000000000008','worker',NULL,'pr.create','pull_request',NULL,NULL,'{"number":218}'::jsonb,'{}'::jsonb,'127.0.0.1', now() - interval '3 hours'),
('00000000-0000-0000-0007-000000000009','admin',NULL,'ticket.reject','ticket','00000000-0000-0000-0000-000000000137','{"status":"Triage"}'::jsonb,'{"status":"Rejected"}'::jsonb,'{}'::jsonb,'127.0.0.1', now() - interval '4 days'),
('00000000-0000-0000-0007-000000000010','system',NULL,'worktree.cleanup','execution_attempt',NULL,NULL,'{}'::jsonb,'{"ticket":"DCC-138"}'::jsonb,'127.0.0.1', now() - interval '22 hours')
ON CONFLICT (id) DO NOTHING;

COMMIT;
