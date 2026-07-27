import { randomUUID } from "node:crypto";
import { pool } from "@dcc/database";
import { claimJob, completeJob, failJob } from "@dcc/domain";
import { validateProject } from "@dcc/project-config";

const workerId = `worker-${randomUUID()}`;
let stopping = false;

process.on("SIGTERM", () => { stopping = true; });
process.on("SIGINT", () => { stopping = true; });

while (!stopping) {
  const job = await claimJob(workerId, ["project.validate"]);
  if (!job) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    continue;
  }
  try {
    const project = (await pool.query("SELECT * FROM projects WHERE id = $1", [job.payload_json.project_id])).rows[0];
    if (!project) throw new Error("project not found");
    const result = await validateProject({
      repositoryPath: project.repository_path,
      defaultBranch: project.default_branch,
      requireRemote: true,
    });
    await pool.query(
      `UPDATE projects SET health_status = $2, last_validated_at = now(), updated_at = now() WHERE id = $1`,
      [project.id, result.valid ? "healthy" : result.changedFiles.length ? "repository_dirty" : "invalid"],
    );
    if (!result.valid) throw new Error(result.errors.join("; "));
    await completeJob(job.id, workerId);
  } catch (error) {
    await failJob(job.id, workerId, error);
  }
}

await pool.end();
