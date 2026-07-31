import { pool } from "../packages/database/src/index.ts";
import { validateProject } from "../packages/project-config/src/index.ts";

const projects = (await pool.query("SELECT id, slug, repository_path, agent_start_path, default_branch FROM projects WHERE enabled = true")).rows;
let invalid = 0;
for (const project of projects) {
  const result = await validateProject({
    repositoryPath: project.repository_path,
    defaultBranch: project.default_branch,
    requireRemote: true,
    agentStartPath: project.agent_start_path,
  });
  const health = result.valid ? "healthy" : result.changedFiles.length ? "repository_dirty" : "invalid";
  await pool.query("UPDATE projects SET health_status = $2, last_validated_at = now(), updated_at = now() WHERE id = $1", [project.id, health]);
  if (!result.valid) {
    invalid++;
    console.log(`${project.slug}: ${health} (${result.errors.join("; ")})`);
  }
}
await pool.end();
console.log(`validated ${projects.length} projects; ${invalid} invalid or blocked`);
