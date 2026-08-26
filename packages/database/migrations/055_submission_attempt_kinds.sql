ALTER TABLE public_submission_attempts ADD COLUMN kind text NOT NULL DEFAULT 'submission';

CREATE INDEX IF NOT EXISTS public_submission_attempts_kind_idx
  ON public_submission_attempts (form_id, ip_address, created_at DESC)
  WHERE kind = 'upload';
