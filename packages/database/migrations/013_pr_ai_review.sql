CREATE TABLE pr_ai_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pull_request_id uuid NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
  mode text NOT NULL CHECK (mode IN ('review_only', 'review_and_merge')),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'approved', 'rejected', 'error')),
  summary text,
  model text NOT NULL,
  reasoning_level text NOT NULL,
  agent_run_id uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
  github_comment_url text,
  error_message text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX pr_ai_reviews_pull_request_id_idx ON pr_ai_reviews (pull_request_id, created_at DESC);

CREATE TABLE ai_review_settings (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  default_model text NOT NULL DEFAULT 'sonnet',
  default_reasoning_level text NOT NULL DEFAULT 'high',
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL
);

INSERT INTO ai_review_settings (id) VALUES (1);

DO $$
DECLARE
  prompt_file_id uuid;
  prompt_version_id uuid;
  prompt_content text := $md$# PR Review Agent

You are reviewing a pull request to decide if it is safe to merge.

## Pull Request

- Project: {{project.name}}
- Title: {{pr.title}}
- Author: {{pr.author}}
- Branch: {{pr.head_branch}} -> {{pr.base_branch}}

## Description

{{pr.body}}

## Diff

```diff
{{pr.diff}}
```

## Your task

Assess whether this change is safe to merge. Consider correctness, obvious
bugs, security issues (secrets, injection, unsafe eval), and whether the
diff matches its stated description. You are reviewing a diff only — you do
not have access to the rest of the repository.

End your response with a single fenced JSON block, exactly one, in this
shape:

```json
{"verdict": "approved", "summary": "One or two sentences."}
```

`verdict` must be exactly `"approved"` or `"rejected"`. If rejected,
`summary` must state the concrete reason.
$md$;
BEGIN
  INSERT INTO prompt_files (scope, prompt_type, file_path)
    VALUES ('global', 'pr-review', 'prompts/global/pr-review.md')
    RETURNING id INTO prompt_file_id;
  INSERT INTO prompt_versions (prompt_file_id, version, content, content_hash)
    VALUES (prompt_file_id, 1, prompt_content, encode(digest(prompt_content, 'sha256'), 'hex'))
    RETURNING id INTO prompt_version_id;
  UPDATE prompt_files SET active_version_id = prompt_version_id WHERE id = prompt_file_id;
END $$;
