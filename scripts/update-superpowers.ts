import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type SuperpowersManifest = {
  superpowers: {
    repository: string;
    tag: string;
    vendor_path?: string;
    review_rubric: string;
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
  review_rubric: { path: string; content_hash: string };
  skills: CatalogSkill[];
};

const digest = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(message: string): never { throw new Error(`invalid Superpowers import: ${message}`); }

function strictlyWithin(parent: string, target: string) {
  const relative = path.relative(parent, target);
  return relative !== "" && relative !== "." && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

export function vendorDestination(manifest: SuperpowersManifest, repositoryRoot = root) {
  const vendorPath = manifest.superpowers.vendor_path;
  if (typeof vendorPath !== "string" || !vendorPath.trim() || vendorPath === ".") fail("vendor path must name a directory below skills/vendor");
  const vendorRoot = path.resolve(repositoryRoot, "skills", "vendor");
  const destination = path.resolve(repositoryRoot, vendorPath);
  if (!strictlyWithin(vendorRoot, destination)) fail("vendor path must be below the vendor root");
  return { destination, vendorRoot };
}

export function allowedSkills(manifest: SuperpowersManifest) {
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

async function validate(manifest: SuperpowersManifest, checkout: string) {
  const source = manifest?.superpowers?.source;
  if (manifest?.superpowers?.repository !== "obra/superpowers") fail("repository must be obra/superpowers");
  if (!/^v\d+\.\d+\.\d+$/.test(manifest?.superpowers?.tag ?? "")) fail("tag must be a release tag");
  if (source?.type !== "git" || source.license !== "MIT") fail("source must be the MIT git release");
  if (typeof manifest.superpowers.review_rubric !== "string" || !manifest.superpowers.review_rubric.trim()) fail("review rubric path is required");
  if (!/^MIT License\b/m.test(await readFile(path.join(checkout, "LICENSE"), "utf8"))) fail("checkout LICENSE is not MIT");
  try {
    const head = execFileSync("git", ["-C", checkout, "rev-parse", "--verify", "HEAD"], { encoding: "utf8" }).trim();
    const tag = execFileSync("git", ["-C", checkout, "rev-parse", "--verify", `refs/tags/${manifest.superpowers.tag}^{commit}`], { encoding: "utf8" }).trim();
    if (head !== tag) fail("checkout HEAD is not the pinned tag");
  } catch (error) {
    if (error instanceof Error && error.message.includes("pinned tag")) throw error;
    fail("checkout HEAD is not the pinned tag");
  }
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

export async function importSuperpowers({ manifest, checkout, destination, repositoryRoot }: { manifest: SuperpowersManifest; checkout: string; destination: string; repositoryRoot: string }): Promise<SuperpowersCatalog> {
  const vendorRoot = path.resolve(repositoryRoot, "skills", "vendor");
  if (!strictlyWithin(vendorRoot, path.resolve(destination))) fail("destination must be below the vendor root");
  await validate(manifest, checkout);
  const rubricSource = path.resolve(checkout, manifest.superpowers.review_rubric);
  const rubricInfo = strictlyWithin(path.resolve(checkout), rubricSource) ? await lstat(rubricSource).catch(() => null) : null;
  if (!rubricInfo?.isFile() || rubricInfo.isSymbolicLink()) fail("missing configured review rubric");
  const rubric = await readFile(rubricSource);
  const review_rubric = { path: manifest.superpowers.review_rubric, content_hash: digest(rubric) };
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
  const catalog: SuperpowersCatalog = {
    catalog_hash: digest(JSON.stringify({ source, review_rubric, skills })), source, review_rubric, skills,
  };
  await writeFile(path.join(staging, "catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`);
  const rubricDestination = path.join(repositoryRoot, "prompts", "global", "code-reviewer.md");
  await mkdir(path.dirname(rubricDestination), { recursive: true });
  await writeFile(rubricDestination, rubric);
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
  const { destination } = vendorDestination(manifest);
  const catalog = await importSuperpowers({ manifest, checkout: path.resolve(checkout), destination, repositoryRoot: root });
  console.log(`imported ${catalog.skills.length} Superpowers skills (${catalog.catalog_hash})`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
