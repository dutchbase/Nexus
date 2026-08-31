import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inTransaction, pool } from "../packages/database/src/index.ts";
import { allowedSkills, vendorDestination, type SuperpowersCatalog, type SuperpowersManifest } from "./update-superpowers.ts";

type QueryClient = { query(sql: string, values?: unknown[]): Promise<{ rows: any[] }> };
export type AgentContentCatalog = SuperpowersCatalog & { vendor_path: string; prompt_hashes: Record<string, string>; prompt_sources: Record<string, string> };
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
  const review_rubric = {
    path: manifest.superpowers?.review_rubric ?? "skills/requesting-code-review/code-reviewer.md",
    content_hash: prompt_hashes["code-reviewer"] ?? "",
  };
  return { catalog_hash: digest(JSON.stringify({ source, skills, prompt_hashes })), source, review_rubric, skills, vendor_path: manifest.superpowers?.vendor_path ?? "skills/vendor/superpowers", prompt_hashes, prompt_sources };
}

export function verifyImportedCatalog(manifest: SuperpowersManifest, catalog: SuperpowersCatalog) {
  const source = { repository: manifest.superpowers.repository, tag: manifest.superpowers.tag, license: manifest.superpowers.source.license };
  if (JSON.stringify(catalog.source) !== JSON.stringify(source)) throw new Error("invalid agent content catalog source");
  if (catalog.catalog_hash !== digest(JSON.stringify({ source: catalog.source, review_rubric: catalog.review_rubric, skills: catalog.skills }))) throw new Error("invalid agent content catalog hash");
  if (catalog.review_rubric?.path !== manifest.superpowers.review_rubric) throw new Error("invalid agent content review rubric");
  const expected = allowedSkills(manifest).map((skill) => ({ ...skill, version: manifest.superpowers.tag }));
  const actual = catalog.skills.map((skill) => ({ slug: skill.slug, phases: skill.phases, inspiration_only: skill.inspiration_only, version: skill.version }));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("invalid agent content catalog skills");
}

export async function readImportedAgentContentCatalog({ root: contentRoot = root, manifest }: { root?: string; manifest: SuperpowersManifest }) {
  const { destination } = vendorDestination(manifest, contentRoot);
  const imported = JSON.parse(await readFile(path.join(destination, "catalog.json"), "utf8")) as SuperpowersCatalog;
  verifyImportedCatalog(manifest, imported);
  const rubric = await readFile(path.join(contentRoot, "prompts", "global", "code-reviewer.md"), "utf8");
  if (digest(rubric) !== imported.review_rubric.content_hash) throw new Error("invalid agent content review rubric hash");
  return buildAgentContentCatalog({ root: contentRoot, manifest, skills: imported.skills });
}

export async function syncAgentContent(client: QueryClient, catalog: AgentContentCatalog) {
  const syncRow = await client.query("SELECT sync FROM agent_content WHERE id=true FOR UPDATE");
  const previous = syncRow.rows[0]?.sync ?? {};
  let promptsUpdated = 0;
  let promptsPreserved = 0;
  let manualOverridesPreserved = 0;
  for (const skill of catalog.skills) {
    await client.query(
      `INSERT INTO skills (slug,name,description,category,source_type,filesystem_path,enabled,version,content_hash,configuration_json)
       VALUES ($1,$2,$3,'superpowers','vendored',$4,true,$5,$6,$7::jsonb)
       ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description,category=EXCLUDED.category,source_type=EXCLUDED.source_type,filesystem_path=EXCLUDED.filesystem_path,enabled=true,version=EXCLUDED.version,content_hash=EXCLUDED.content_hash,configuration_json=EXCLUDED.configuration_json,updated_at=now()`,
      [skill.slug, skill.name, skill.description, `${catalog.vendor_path}/${skill.slug}/SKILL.md`, skill.version, skill.content_hash,
        JSON.stringify({ phases: skill.phases, required_phases: skill.phases, allowed_phases: skill.phases, inspiration_only: skill.inspiration_only })],
    );
  }
  await client.query(
    "UPDATE skills SET enabled=false,updated_at=now() WHERE source_type='vendored' AND category='superpowers' AND NOT (slug = ANY($1::text[]))",
    [catalog.skills.map((skill) => skill.slug)],
  );
  for (const [promptType, sourceHash] of Object.entries(catalog.prompt_hashes)) {
    if (previous.prompt_hashes?.[promptType] === sourceHash) { promptsPreserved++; continue; }
    const file = (await client.query(
      // active_created_by is set only when the active version was published through the
      // admin UI (see apps/web/src/server.ts's prompt-version routes, which always pass
      // created_by). A system-synced version (this same loop's own INSERT below) never
      // sets it. Once a human has customized a prompt, this sync must never touch it
      // again — a routine vendored-content sync silently overwriting a live admin edit
      // is exactly the bug this guard exists to prevent (docs/superpowers/plans, AI PR
      // review max-turns investigation).
      `SELECT pf.id,pv.content_hash active_content_hash,pv.created_by active_created_by FROM prompt_files pf LEFT JOIN prompt_versions pv ON pv.id=pf.active_version_id WHERE pf.scope='global' AND pf.prompt_type=$1 FOR UPDATE OF pf`, [promptType],
    )).rows[0];
    if (file?.active_content_hash === sourceHash) { promptsPreserved++; continue; }
    if (file?.active_created_by) { promptsPreserved++; manualOverridesPreserved++; continue; }
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
  return { promptsUpdated, promptsPreserved, manualOverridesPreserved, skillsSynced: catalog.skills.length };
}

async function main() {
  const manifest = JSON.parse(await readFile(path.join(root, "config", "agent-content.json"), "utf8"));
  const catalog = await readImportedAgentContentCatalog({ manifest });
  const result = await inTransaction((client) => syncAgentContent(client, catalog));
  console.log(`synced ${result.skillsSynced} skills and ${result.promptsUpdated} prompts (${result.manualOverridesPreserved} manual prompt customizations left untouched)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }).finally(() => pool.end());
}
