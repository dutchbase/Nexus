import type pg from "pg";
import { validateProject } from "@dcc/project-config";

type Database = Pick<pg.Pool, "query">;
type ProjectValidateJob = {
  id: string;
  payload_json: Record<string, unknown>;
};

// Extracted from the worker's main poll loop (project.validate job type) so
// the persistence behavior — categorized dirty-file detail vs. a distinct
// inspection-error state — can be unit tested directly against a fake db,
// mirroring the runProviderJob pattern in provider-jobs.ts.
export async function runProjectValidateJob(
  job: ProjectValidateJob,
  db: Database,
  assertOwned: () => Promise<void> = async () => {},
): Promise<void> {
  const project = (await db.query("SELECT * FROM projects WHERE id=$1", [job.payload_json.project_id])).rows[0];
  if (!project) throw new Error("project not found");

  const result = await validateProject({
    repositoryPath: project.repository_path, defaultBranch: project.default_branch, requireRemote: true, agentStartPath: project.agent_start_path,
  });

  await assertOwned();

  if (!result.ok) {
    await db.query(
      `UPDATE projects SET health_status='inspection_error',health_error=$2,health_detail_json=NULL,last_validated_at=now(),updated_at=now() WHERE id=$1`,
      [project.id, `${result.errorCode}: ${result.message}`],
    );
    throw new Error(`repository inspection failed: ${result.errorCode}: ${result.message}`);
  }

  const summary = result.changedFileDetail.reduce<Record<string, number>>((acc, entry) => {
    acc[entry.status] = (acc[entry.status] ?? 0) + 1;
    return acc;
  }, {});
  const healthStatus = result.valid ? "healthy" : result.changedFileDetail.length ? "repository_dirty" : "invalid";
  await db.query(
    `UPDATE projects SET health_status=$2,health_error=NULL,health_detail_json=$3::jsonb,last_validated_at=now(),updated_at=now() WHERE id=$1`,
    [project.id, healthStatus, healthStatus === "repository_dirty" ? JSON.stringify({ summary, files: result.changedFileDetail }) : null],
  );
  if (!result.valid) throw new Error(result.errors.join("; "));
}
