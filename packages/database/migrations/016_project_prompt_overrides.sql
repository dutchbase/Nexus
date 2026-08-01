DROP TRIGGER IF EXISTS projects_create_prompt_files ON projects;
DROP FUNCTION IF EXISTS create_project_prompt_files();
DELETE FROM prompt_files WHERE scope='project';
