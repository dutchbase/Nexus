ALTER TABLE uploads ADD COLUMN form_id uuid REFERENCES forms(id) ON DELETE CASCADE;
CREATE INDEX uploads_form_idx ON uploads (form_id);
