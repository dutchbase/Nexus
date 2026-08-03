CREATE TABLE backup_recovery_verifications (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  backup_path text NOT NULL,
  manifest_sha256 text CHECK (manifest_sha256 IS NULL OR manifest_sha256 ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('passed','failed')),
  failure_step text,
  verified_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX backup_recovery_verifications_latest_idx ON backup_recovery_verifications (verified_at DESC);
