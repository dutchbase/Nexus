import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "../packages/database/src/index.ts";
import { loadProjectConfig, normalizeAgentStartPath, validateAgentStartPath, validateDeploymentConfig } from "../packages/project-config/src/index.ts";

function value(flag: string) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

export function normalizeProjectImport(slug: string, defaults: Record<string, any>, project: Record<string, any>) {
  const data: Record<string, any> = { ...defaults, ...project, ai: { ...(defaults.ai ?? {}), ...(project.ai ?? {}) } };
  const configJson = structuredClone(data);
  for (const key of ["name", "description", "paths", "github", "default_branch", "enabled", "agent_start_path"]) delete configJson[key];
  return {
    name: data.name || slug, description: data.description || null,
    repositoryPath: data.paths?.repository || null,
    githubOwner: data.github?.owner || null, githubRepository: data.github?.repository || null,
    defaultBranch: data.default_branch || "main", enabled: data.enabled ?? true,
    agentStartPath: normalizeAgentStartPath(data.agent_start_path), configJson,
  };
}

export async function importProjects(config: { defaults?: Record<string, any>; projects: Record<string, Record<string, any>> }, client: { query(sql: string, values?: unknown[]): Promise<any> } = pool) {
  let imported = 0;
  let skipped = 0;

  for (const [slug, projectData] of Object.entries(config.projects || {})) {
    const data = normalizeProjectImport(slug, config.defaults ?? {}, projectData);

    if (!data.repositoryPath) {
      console.warn(`⚠️  ${slug}: missing paths.repository, skipping`);
      skipped++;
      continue;
    }

    const errors = [
      ...(typeof data.enabled === "boolean" ? [] : ["enabled must be a boolean"]),
      ...await validateAgentStartPath(data.agentStartPath),
      ...validateDeploymentConfig(data.configJson.deployment),
    ];
    if (errors.length) throw new Error(`${slug}: ${errors.join("; ")}`);

    await client.query(
      `INSERT INTO projects (slug,name,description,repository_path,github_owner,github_repository,default_branch,enabled,agent_start_path,config_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (slug) DO UPDATE SET
         name=EXCLUDED.name,description=EXCLUDED.description,repository_path=EXCLUDED.repository_path,
         github_owner=EXCLUDED.github_owner,github_repository=EXCLUDED.github_repository,
         default_branch=EXCLUDED.default_branch,enabled=EXCLUDED.enabled,
         agent_start_path=EXCLUDED.agent_start_path,config_json=EXCLUDED.config_json,updated_at=now()`,
      [slug, data.name, data.description, data.repositoryPath, data.githubOwner, data.githubRepository,
        data.defaultBranch, data.enabled, data.agentStartPath, JSON.stringify(data.configJson)],
    );
    imported++;
  }
  return { imported, skipped };
}

async function main() {
  const { config } = await loadProjectConfig(value("--file"));
  const { imported, skipped } = await importProjects(config);
  console.log(`✓ imported ${imported} project(s)` + (skipped ? `; skipped ${skipped}` : ""));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`✗ import failed: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 1;
  }).finally(() => pool.end());
}
