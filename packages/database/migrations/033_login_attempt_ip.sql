ALTER TABLE login_attempts ADD COLUMN ip_address text;
UPDATE login_attempts SET ip_address = 'unknown' WHERE ip_address IS NULL;
ALTER TABLE login_attempts ALTER COLUMN ip_address SET NOT NULL;
CREATE INDEX login_attempts_ip_time_idx ON login_attempts (ip_address, attempted_at DESC);
