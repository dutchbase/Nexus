import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Manifest = {
  superpowers: {
    repository: string;
    tag: string;
    vendor_path?: string;
    source: { type: string; license: string };
    skills: Record<string, string[]>;
  };
};

type CatalogSkill = {
  slug: string;
  name: string;
  description: string | null;
  phases: string[];
  inspiration_only: boolean;
  version: string;
  content_hash: string;
  files: { path: string; content_hash: string }[];
};

export type SuperpowersCatalog = {
  catalog_hash: string;
  source: { repository: string; tag: string; license: string };
  skills: CatalogSkill[];
};

const digest = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(message: string): never { throw new Error(`invalid Superpowers import: ${message}`); }

function allowedSkills(manifest: Manifest) {
  const skills = new Map<string, { phases: string[]; inspiration_only: boolean }>();
  for (const [phase, names] of Object.entries(manifest.superpowers.skills ?? {})) {
    if (!Array.isArray(names)) fail(`skills.${phase} must be an array`);
    for (const slug of names) {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) fail(`invalid skill slug ${JSON.stringify(slug)}`);
      const current = skills.get(slug) ?? { phases: [], inspiration_only: false };
      if (phase === "inspiration_only") current.inspiration_only = true;
      else current.phases.push(phase);
      skills.set(slug, current);
    }
  }
  return [...skills.entries()].map(([slug, values]) => ({ slug, phases: values.phases.sort(), inspiration_only: values.inspiration_only })).sort((a, b) => a.slug.localeCompare(b.slug));
}

async function validate(manifest: Manifest, checkout: string) {
  const source = manifest?.superpowers?.source;
  if (manifest?.superpowers?.repository !== "obra/superpowers") fail("repository must be obra/superpowers");
  if (!/^v\d+\.\d+\.\d+$/.test(manifest?.superpowers?.tag ?? "")) fail("tag must be a release tag");
  if (source?.type !== "git" || source.license !== "MIT") fail("source must be the MIT git release");
  const packageJson = JSON.parse(await readFile(path.join(checkout, "package.json"), "utf8"));
  if (packageJson.version !== manifest.superpowers.tag.slice(1)) fail("checkout version does not match manifest tag");
  if (packageJson.license !== "MIT") fail("checkout package license is not MIT");
  if (!/^MIT License\b/m.test(await readFile(path.join(checkout, "LICENSE"), "utf8"))) fail("checkout LICENSE is not MIT");
}

function frontMatter(content: string, field: string) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const value = match?.[1].match(new RegExp(`^${field}:\\s*["']?([^\\r\\n"']+)["']?\\s*$`, "m"))?.[1]?.trim();
  return value || null;
}

async function readFiles(directory: string, relative = ""): Promise<{ path: string; content_hash: string }[]> {
  const files: { path: string; content_hash: string }[] = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const next = path.join(directory, entry.name);
    const name = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await readFiles(next, name));
    else if (entry.isFile()) files.push({ path: name, content_hash: digest(await readFile(next)) });
  }
  return files;
}

async function copyTree(source: string, destination: string) {
  await mkdir(destination, { recursive: true });
  for (const entry of (await readdir(source, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) await copyTree(path.join(source, entry.name), path.join(destination, entry.name));
    else if (entry.isFile()) await writeFile(path.join(destination, entry.name), await readFile(path.join(source, entry.name)));
  }
}

export async function importSuperpowers({ manifest, checkout, destination }: { manifest: Manifest; checkout: string; destination: string }): Promise<SuperpowersCatalog> {
  await validate(manifest, checkout);
  const selected = allowedSkills(manifest);
  const staging = `${destination}.next`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  const skills: CatalogSkill[] = [];
  for (const selection of selected) {
    const source = path.join(checkout, "skills", selection.slug);
    const sourceInfo = await lstat(source).catch(() => null);
    if (!sourceInfo?.isDirectory() || sourceInfo.isSymbolicLink()) fail(`missing allowed skill ${selection.slug}`);
    const skillFile = path.join(source, "SKILL.md");
    const content = await readFile(skillFile, "utf8");
    if (frontMatter(content, "name") !== selection.slug) fail(`manifest name does not match ${selection.slug}`);
    await copyTree(source, path.join(staging, selection.slug));
    const files = await readFiles(source);
    skills.push({
      slug: selection.slug,
      name: frontMatter(content, "name")!,
      description: frontMatter(content, "description"),
      phases: selection.phases,
      inspiration_only: selection.inspiration_only,
      version: manifest.superpowers.tag,
      content_hash: digest(JSON.stringify(files)),
      files,
    });
  }
  const source = { repository: manifest.superpowers.repository, tag: manifest.superpowers.tag, license: manifest.superpowers.source.license };
  const catalog: SuperpowersCatalog = { catalog_hash: digest(JSON.stringify({ source, skills })), source, skills };
  await writeFile(path.join(staging, "catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`);
  await mkdir(path.dirname(destination), { recursive: true });
  await rm(destination, { recursive: true, force: true });
  await rename(staging, destination);
  return catalog;
}

function argument(flag: string) {
  const index = process.argv.indexOf(flag);
  return index < 0 ? undefined : process.argv[index + 1];
}

async function main() {
  const checkout = argument("--checkout");
  if (!checkout) throw new Error("usage: tsx scripts/update-superpowers.ts --checkout <tagged-checkout>");
  const manifest = JSON.parse(await readFile(path.join(root, "config", "agent-content.json"), "utf8"));
  const vendorPath = manifest.superpowers.vendor_path ?? "skills/vendor/superpowers";
  if (path.isAbsolute(vendorPath) || vendorPath.split(/[\\/]/).includes("..")) throw new Error("invalid vendor path");
  const destination = path.resolve(root, vendorPath);
  const catalog = await importSuperpowers({ manifest, checkout: path.resolve(checkout), destination });
  console.log(`imported ${catalog.skills.length} Superpowers skills (${catalog.catalog_hash})`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
