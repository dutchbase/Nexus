DROP TRIGGER IF EXISTS projects_create_prompt_files ON projects;
DROP FUNCTION IF EXISTS create_project_prompt_files();
UPDATE prompt_files SET active_version_id=NULL WHERE scope='project';
DELETE FROM prompt_versions v USING prompt_files f WHERE v.prompt_file_id=f.id AND f.scope='project';
DELETE FROM prompt_files WHERE scope='project';
