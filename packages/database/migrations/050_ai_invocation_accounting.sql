CREATE TABLE ai_model_prices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('anthropic','deepseek')),
  CHECK ((model IN ('fable','opus','sonnet','haiku') AND provider='anthropic') OR
         (model IN ('deepseek-v4-flash','deepseek-v4-pro') AND provider='deepseek')),
  effective_from timestamptz NOT NULL,
  input_usd_per_million numeric(20,8) NOT NULL CHECK (input_usd_per_million >= 0),
  output_usd_per_million numeric(20,8) NOT NULL CHECK (output_usd_per_million >= 0),
  cache_write_usd_per_million numeric(20,8) NOT NULL CHECK (cache_write_usd_per_million >= 0),
  cache_read_usd_per_million numeric(20,8) NOT NULL CHECK (cache_read_usd_per_million >= 0),
  source_url text NOT NULL CHECK (source_url ~ '^https://'),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (model, effective_from)
);
CREATE INDEX ai_model_prices_effective_lookup_idx ON ai_model_prices (model, effective_from DESC);
CREATE FUNCTION reject_ai_model_price_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'AI model prices are append-only'; END;
$$;
CREATE TRIGGER ai_model_prices_append_only BEFORE UPDATE OR DELETE ON ai_model_prices
FOR EACH ROW EXECUTE FUNCTION reject_ai_model_price_mutation();

ALTER TABLE agent_runs
  ADD COLUMN provider text CHECK (provider IS NULL OR provider IN ('anthropic','deepseek')),
  ADD COLUMN pull_request_id uuid REFERENCES pull_requests(id) ON DELETE SET NULL,
  ADD COLUMN task_prompt text,
  ADD COLUMN ai_usage_status text CHECK (ai_usage_status IS NULL OR ai_usage_status IN ('pending','captured','unavailable')),
  ADD COLUMN input_tokens bigint CHECK (input_tokens IS NULL OR input_tokens >= 0),
  ADD COLUMN output_tokens bigint CHECK (output_tokens IS NULL OR output_tokens >= 0),
  ADD COLUMN reasoning_tokens bigint CHECK (reasoning_tokens IS NULL OR reasoning_tokens >= 0),
  ADD COLUMN cache_read_tokens bigint CHECK (cache_read_tokens IS NULL OR cache_read_tokens >= 0),
  ADD COLUMN cache_write_tokens bigint CHECK (cache_write_tokens IS NULL OR cache_write_tokens >= 0),
  ADD COLUMN total_tokens bigint CHECK (total_tokens IS NULL OR total_tokens >= 0),
  ADD COLUMN raw_usage_json jsonb,
  ADD COLUMN ai_model_price_id uuid REFERENCES ai_model_prices(id) ON DELETE RESTRICT,
  ADD COLUMN estimated_cost_usd numeric(20,10) CHECK (estimated_cost_usd IS NULL OR estimated_cost_usd >= 0),
  ADD CONSTRAINT agent_runs_ai_accounting_check CHECK (
    ai_usage_status IS NULL OR
    (ai_usage_status IN ('pending','unavailable') AND input_tokens IS NULL AND output_tokens IS NULL AND reasoning_tokens IS NULL AND cache_read_tokens IS NULL AND cache_write_tokens IS NULL AND total_tokens IS NULL AND raw_usage_json IS NULL AND ai_model_price_id IS NULL AND estimated_cost_usd IS NULL) OR
    (ai_usage_status='captured' AND input_tokens IS NOT NULL AND output_tokens IS NOT NULL AND reasoning_tokens IS NOT NULL AND cache_read_tokens IS NOT NULL AND cache_write_tokens IS NOT NULL AND total_tokens=input_tokens+output_tokens+cache_read_tokens+cache_write_tokens AND reasoning_tokens<=output_tokens)
  );

INSERT INTO ai_model_prices (model,provider,effective_from,input_usd_per_million,output_usd_per_million,cache_write_usd_per_million,cache_read_usd_per_million,source_url) VALUES
  ('fable','anthropic','2026-08-08T00:00:00Z',10,50,12.5,1,'https://platform.claude.com/docs/en/about-claude/pricing'),
  ('opus','anthropic','2026-08-08T00:00:00Z',5,25,6.25,0.5,'https://platform.claude.com/docs/en/about-claude/pricing'),
  ('sonnet','anthropic','2026-08-08T00:00:00Z',3,15,3.75,0.3,'https://platform.claude.com/docs/en/about-claude/pricing'),
  ('haiku','anthropic','2026-08-08T00:00:00Z',1,5,1.25,0.1,'https://platform.claude.com/docs/en/about-claude/pricing'),
  ('deepseek-v4-flash','deepseek','2026-08-08T00:00:00Z',0.14,0.28,0,0.0028,'https://api-docs.deepseek.com/quick_start/models'),
  ('deepseek-v4-pro','deepseek','2026-08-08T00:00:00Z',0.435,0.87,0,0.003625,'https://api-docs.deepseek.com/quick_start/models');
