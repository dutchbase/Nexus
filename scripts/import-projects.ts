import { pool } from "../packages/database/src/index.ts";
import { loadProjectConfig } from "../packages/project-config/src/index.ts";

function value(flag: string) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const filePath = value("--file");
try {
  const { config } = await loadProjectConfig(filePath);

  let imported = 0;
  let skipped = 0;

  for (const [slug, projectData] of Object.entries(config.projects || {})) {
    const data = projectData as Record<string, any>;

    // Extract known columns
    const name = data.name || slug;
    const description = data.description || null;
    const repositoryPath = data.paths?.repository || null;
    const githubOwner = data.github?.owner || null;
    const githubRepository = data.github?.repository || null;
    const defaultBranch = data.default_branch || "main";

    if (!repositoryPath) {
      console.warn(`⚠️  ${slug}: missing paths.repository, skipping`);
      skipped++;
      continue;
    }

    // Build config_json: all keys except known columns
    const configJson = JSON.parse(JSON.stringify(data));
    delete configJson.name;
    delete configJson.description;
    delete configJson.paths;
    delete configJson.github;
    delete configJson.default_branch;

    // Upsert into projects table
    await pool.query(
      `INSERT INTO projects (slug, name, description, repository_path, github_owner, github_repository, default_branch, config_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (slug) DO UPDATE SET
         name = $2,
         description = $3,
         repository_path = $4,
         github_owner = $5,
         github_repository = $6,
         default_branch = $7,
         config_json = $8,
         updated_at = now()`,
      [slug, name, description, repositoryPath, githubOwner, githubRepository, defaultBranch, JSON.stringify(configJson)],
    );
    imported++;
  }

  console.log(`✓ imported ${imported} project(s)` + (skipped ? `; skipped ${skipped}` : ""));
} catch (error) {
  console.error(
    `✗ import failed: ${error instanceof Error ? error.message : "unknown error"}`,
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
