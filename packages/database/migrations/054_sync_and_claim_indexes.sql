CREATE INDEX pull_requests_open_sync_idx
  ON pull_requests (last_synced_at)
  WHERE provider = 'github' AND state = 'open';

CREATE INDEX jobs_queued_type_idx
  ON jobs (type)
  WHERE status = 'queued';
