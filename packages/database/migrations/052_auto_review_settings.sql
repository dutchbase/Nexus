ALTER TABLE ai_review_settings
  ADD COLUMN auto_review_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN auto_merge_on_approve boolean NOT NULL DEFAULT false;
