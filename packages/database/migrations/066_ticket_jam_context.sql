ALTER TABLE tickets ADD COLUMN jam_url text;

CREATE TABLE ticket_jam_contexts (
  ticket_id uuid PRIMARY KEY REFERENCES tickets(id) ON DELETE CASCADE,
  source_url text NOT NULL,
  generation uuid NOT NULL DEFAULT gen_random_uuid(),
  state text NOT NULL CHECK (state IN ('queued','fetching','ready','partial','failed','not_configured')),
  data_json jsonb,
  content_hash text,
  error_code text CHECK (error_code IS NULL OR error_code IN ('not_configured','access_denied','not_found','rate_limited','timeout','unavailable','unsupported_schema','invalid_response')),
  fetched_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
