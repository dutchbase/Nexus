-- Phase 11: Allow upserting GitHub PRs discovered outside the platform, one row per (project, number).
CREATE UNIQUE INDEX pull_requests_project_number_unique ON pull_requests (project_id, number);
