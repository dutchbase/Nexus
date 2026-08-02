import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inTransaction, pool } from "../packages/database/src/index.ts";
import type { SuperpowersCatalog } from "./update-superpowers.ts";

type QueryClient = { query(sql: string, values?: unknown[]): Promise<{ rows: any[] }> };
export type AgentContentCatalog = SuperpowersCatalog & { prompt_hashes: Record<string, string>; prompt_sources: Record<string, string> };
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function buildAgentContentCatalog({ root: contentRoot = root, manifest, skills }: { root?: string; manifest: any; skills: SuperpowersCatalog["skills"] }): Promise<AgentContentCatalog> {
  const promptDirectory = path.join(contentRoot, "prompts", "global");
  const prompt_hashes: Record<string, string> = {};
  const prompt_sources: Record<string, string> = {};
  for (const entry of (await readdir(promptDirectory, { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.endsWith(".md")).sort((a, b) => a.name.localeCompare(b.name))) {
    const promptType = entry.name.slice(0, -3);
    prompt_sources[promptType] = await readFile(path.join(promptDirectory, entry.name), "utf8");
    prompt_hashes[promptType] = digest(prompt_sources[promptType]);
  }
  const source = { repository: manifest.superpowers?.repository ?? "obra/superpowers", tag: manifest.superpowers?.tag, license: manifest.superpowers?.source?.license ?? "MIT" };
  return { catalog_hash: digest(JSON.stringify({ source, skills, prompt_hashes })), source, skills, prompt_hashes, prompt_sources };
}

export async function syncAgentContent(client: QueryClient, catalog: AgentContentCatalog) {
  const syncRow = await client.query("SELECT sync FROM agent_content WHERE id=true FOR UPDATE");
  const previous = syncRow.rows[0]?.sync ?? {};
  let promptsUpdated = 0;
  let promptsPreserved = 0;
  for (const skill of catalog.skills) {
    await client.query(
      `INSERT INTO skills (slug,name,description,category,source_type,filesystem_path,enabled,version,content_hash,configuration_json)
       VALUES ($1,$2,$3,'superpowers','vendored',$4,true,$5,$6,$7::jsonb)
       ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description,category=EXCLUDED.category,source_type=EXCLUDED.source_type,filesystem_path=EXCLUDED.filesystem_path,enabled=true,version=EXCLUDED.version,content_hash=EXCLUDED.content_hash,configuration_json=EXCLUDED.configuration_json,updated_at=now()`,
      [skill.slug, skill.name, skill.description, `skills/vendor/superpowers/${skill.slug}/SKILL.md`, skill.version, skill.content_hash, JSON.stringify({ phases: skill.phases, inspiration_only: skill.inspiration_only })],
    );
  }
  for (const [promptType, sourceHash] of Object.entries(catalog.prompt_hashes)) {
    if (previous.prompt_hashes?.[promptType] === sourceHash) { promptsPreserved++; continue; }
    const file = (await client.query(
      `SELECT pf.id,pv.content_hash active_content_hash FROM prompt_files pf LEFT JOIN prompt_versions pv ON pv.id=pf.active_version_id WHERE pf.scope='global' AND pf.prompt_type=$1 FOR UPDATE`, [promptType],
    )).rows[0];
    if (file?.active_content_hash === sourceHash) { promptsPreserved++; continue; }
    const promptFile = file ?? (await client.query(
      "INSERT INTO prompt_files (scope,prompt_type,file_path) VALUES ('global',$1,$2) RETURNING id", [promptType, `prompts/global/${promptType}.md`],
    )).rows[0];
    const content = catalog.prompt_sources[promptType];
    const version = (await client.query("SELECT COALESCE(max(version),0)+1 AS version FROM prompt_versions WHERE prompt_file_id=$1", [promptFile.id])).rows[0].version;
    const created = (await client.query(
      "INSERT INTO prompt_versions (prompt_file_id,version,content,content_hash) VALUES ($1,$2,$3,$4) RETURNING id", [promptFile.id, version, content, sourceHash],
    )).rows[0];
    await client.query("UPDATE prompt_files SET active_version_id=$2,updated_at=now() WHERE id=$1", [promptFile.id, created.id]);
    promptsUpdated++;
  }
  await client.query(
    "INSERT INTO agent_content (id,sync) VALUES (true,$1::jsonb) ON CONFLICT (id) DO UPDATE SET sync=EXCLUDED.sync,updated_at=now()",
    [JSON.stringify({ catalog_hash: catalog.catalog_hash, prompt_hashes: catalog.prompt_hashes })],
  );
  return { promptsUpdated, promptsPreserved, skillsSynced: catalog.skills.length };
}

async function main() {
  const manifest = JSON.parse(await readFile(path.join(root, "config", "agent-content.json"), "utf8"));
  const imported = JSON.parse(await readFile(path.join(root, "skills", "vendor", "superpowers", "catalog.json"), "utf8"));
  const catalog = await buildAgentContentCatalog({ manifest, skills: imported.skills });
  const result = await inTransaction((client) => syncAgentContent(client, catalog));
  console.log(`synced ${result.skillsSynced} skills and ${result.promptsUpdated} prompts`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }).finally(() => pool.end());
}
