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
  if (!result.ok) {
    invalid++;
    await pool.query(
      "UPDATE projects SET health_status = 'inspection_error', health_error = $2, health_detail_json = NULL, last_validated_at = now(), updated_at = now() WHERE id = $1",
      [project.id, `${result.errorCode}: ${result.message}`],
    );
    console.log(`${project.slug}: inspection_error (${result.errorCode}: ${result.message})`);
    continue;
  }
  const summary = result.changedFileDetail.reduce<Record<string, number>>((acc, entry) => {
    acc[entry.status] = (acc[entry.status] ?? 0) + 1;
    return acc;
  }, {});
  const health = result.valid ? "healthy" : result.changedFileDetail.length ? "repository_dirty" : "invalid";
  await pool.query(
    "UPDATE projects SET health_status = $2, health_error = NULL, health_detail_json = $3::jsonb, last_validated_at = now(), updated_at = now() WHERE id = $1",
    [project.id, health, health === "repository_dirty" ? JSON.stringify({ summary, files: result.changedFileDetail }) : null],
  );
  if (!result.valid) {
    invalid++;
    console.log(`${project.slug}: ${health} (${result.errors.join("; ")})`);
  }
}
await pool.end();
console.log(`validated ${projects.length} projects; ${invalid} invalid or blocked`);
