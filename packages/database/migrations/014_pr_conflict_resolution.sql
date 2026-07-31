CREATE TABLE pr_conflict_resolutions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pull_request_id uuid NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'resolved', 'error')),
  summary text,
  model text NOT NULL,
  reasoning_level text NOT NULL,
  agent_run_id uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
  resolved_sha text,
  error_message text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX pr_conflict_resolutions_pull_request_id_idx ON pr_conflict_resolutions (pull_request_id, created_at DESC);

DO $$
DECLARE
  prompt_file_id uuid;
  prompt_version_id uuid;
  prompt_content text := $md$# PR Conflict Resolution Agent

You are resolving a Git merge conflict in a pull request.

## Pull Request

- Project: {{project.name}}
- Title: {{pr.title}}
- Branch: {{pr.head_branch}} -> {{pr.base_branch}}

## Conflicted files

{{conflicted_files}}

## Your task

The files above contain unresolved Git conflict markers (`<<<<<<<`,
`=======`, `>>>>>>>`) from merging {{pr.base_branch}} into
{{pr.head_branch}}. Edit each file in the working directory to resolve
every conflict: keep the correct combination of both sides' intent,
remove all conflict marker lines, and leave the file in a working state.
Do not run any git commands — only edit the conflicted files. Do not
touch any file that is not listed above.
$md$;
BEGIN
  INSERT INTO prompt_files (scope, prompt_type, file_path)
    VALUES ('global', 'pr-conflict-resolution', 'prompts/global/pr-conflict-resolution.md')
    RETURNING id INTO prompt_file_id;
  INSERT INTO prompt_versions (prompt_file_id, version, content, content_hash)
    VALUES (prompt_file_id, 1, prompt_content, encode(digest(prompt_content, 'sha256'), 'hex'))
    RETURNING id INTO prompt_version_id;
  UPDATE prompt_files SET active_version_id = prompt_version_id WHERE id = prompt_file_id;
END $$;
