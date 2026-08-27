ALTER TABLE projects
  ADD COLUMN health_detail_json jsonb,
  ADD COLUMN health_error text;
