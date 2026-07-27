-- Phase 9: central pull-request dashboard metadata and internal review state.
ALTER TABLE pull_requests
  ADD COLUMN additions integer,
  ADD COLUMN deletions integer,
  ADD COLUMN changed_files integer,
  ADD COLUMN requested_reviewers jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN merge_conflicts boolean,
  ADD COLUMN internal_review_state text,
  ADD COLUMN internal_notes text;
