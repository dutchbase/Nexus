ALTER TABLE pr_ai_reviews
  ADD COLUMN publication_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  ADD COLUMN raw_output text,
  ADD COLUMN parsed_verdict text CHECK (parsed_verdict IN ('approved', 'rejected')),
  ADD COLUMN reviewed_head_sha text,
  ADD COLUMN reviewed_base_branch text,
  ADD COLUMN reviewed_base_sha text,
  ADD COLUMN publication_status text NOT NULL DEFAULT 'pending' CHECK (publication_status IN ('pending', 'published')),
  ADD COLUMN publication_attempt_count integer NOT NULL DEFAULT 0 CHECK (publication_attempt_count >= 0),
  ADD COLUMN github_comment_id bigint,
  ADD COLUMN error_code text,
  ADD COLUMN last_publication_error text;

UPDATE pr_ai_reviews
SET publication_status='published',publication_attempt_count=1
WHERE github_comment_url IS NOT NULL;
