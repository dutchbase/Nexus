import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolved relative to this module's own file, not process.cwd() — the
// worker runs with cwd=apps/worker (via `pnpm --filter worker dev`), so a
// cwd-relative default would look for skills/data under apps/worker/
// instead of the actual repo root.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export type SkillPhase = "planning" | "execution" | "repair";
export type ResolutionSource = "global_mandatory" | "project_automatic" | "ticket_selected" | "phase_required";

export type RegisteredSkill = {
  id: string;
  slug: string;
  name: string;
  source_type?: string | null;
  filesystem_path: string | null;
  enabled: boolean;
  version: string | null;
  configuration_json?: Record<string, unknown> | null;
};

export type SkillCandidate = {
  skill: RegisteredSkill | null;
  skillId: string;
  slug?: string;
  source: ResolutionSource;
};

export type ResolvedSkill = RegisteredSkill & {
  resolution_sources: ResolutionSource[];
};

export type SnapshottedFile = {
  path: string;
  content_base64: string;
  content_hash: string;
};

export type SnapshottedSkill = {
  skill_id: string;
  slug: string;
  version: string | null;
  filesystem_path: string;
  resolution_sources: ResolutionSource[];
  // `phase` is retained for snapshots created before phase sets existed.
  phase: SkillPhase;
  phases?: SkillPhase[];
  plugin_name?: string | null;
  invocation_name?: string | null;
  configuration_json?: Record<string, unknown> | null;
  files: SnapshottedFile[];
  content_hash: string;
};

export class SkillResolutionError extends Error {
  status = 422;
  code = "invalid_skill";
  constructor(public skill: string, reason: "missing" | "disabled" | "incompatible") {
    super(`Skill "${skill}" is ${reason} and blocks this run`);
  }
}

function isEligible(skill: RegisteredSkill, projectId: string, phase: SkillPhase) {
  const configuration = skill.configuration_json ?? {};
  const projects = Array.isArray(configuration.compatible_projects) ? configuration.compatible_projects : [];
  const phases = Array.isArray(configuration.allowed_phases) ? configuration.allowed_phases : [];
  return (!projects.length || projects.includes(projectId)) && (!phases.length || phases.includes(phase));
}

export function resolveSkills(candidates: SkillCandidate[], projectId: string, phase: SkillPhase): ResolvedSkill[] {
  const resolved = new Map<string, ResolvedSkill>();
  for (const candidate of candidates) {
    const label = candidate.slug ?? candidate.skill?.slug ?? candidate.skillId;
    if (!candidate.skill) throw new SkillResolutionError(label, "missing");
    if (!candidate.skill.enabled) throw new SkillResolutionError(label, "disabled");
    if (!isEligible(candidate.skill, projectId, phase)) throw new SkillResolutionError(label, "incompatible");
    const existing = resolved.get(candidate.skill.id);
    if (existing) {
      if (!existing.resolution_sources.includes(candidate.source)) existing.resolution_sources.push(candidate.source);
    } else {
      resolved.set(candidate.skill.id, { ...candidate.skill, resolution_sources: [candidate.source] });
    }
  }
  return [...resolved.values()];
}

function withinRoot(root: string, target: string) {
  const relative = path.relative(root, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function filesUnderSkill(skillPath: string, skillsRoot: string) {
  const absoluteFile = path.isAbsolute(skillPath) ? path.normalize(skillPath) : path.resolve(skillsRoot, skillPath);
  if (!path.isAbsolute(skillPath) && !withinRoot(path.resolve(skillsRoot), absoluteFile)) {
    throw new SkillResolutionError(skillPath, "missing");
  }
  const root = path.dirname(absoluteFile);
  const files: SnapshottedFile[] = [];
  async function visit(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(absolute);
      if (entry.isFile()) {
        const bytes = await readFile(absolute);
        files.push({
          path: path.relative(root, absolute).split(path.sep).join("/"),
          content_base64: bytes.toString("base64"),
          content_hash: createHash("sha256").update(bytes).digest("hex"),
        });
      }
    }
  }
  await visit(root);
  files.sort((left, right) => left.path.localeCompare(right.path));
  if (!files.some((file) => file.path === "SKILL.md")) throw new SkillResolutionError(skillPath, "missing");
  return files;
}

const allPhases: SkillPhase[] = ["planning", "execution", "repair"];

function configuredPhases(configuration: Record<string, unknown> | null | undefined) {
  if (!Array.isArray(configuration?.phases)) return allPhases;
  return configuration.phases.filter((phase): phase is SkillPhase => allPhases.includes(phase as SkillPhase));
}

function snapshotMetadata(skill: ResolvedSkill) {
  const configuration_json = skill.configuration_json ?? {};
  const plugin_name = typeof configuration_json.plugin_name === "string"
    ? configuration_json.plugin_name
    : skill.source_type === "vendored" ? "superpowers" : null;
  const invocation_name = typeof configuration_json.invocation_name === "string"
    ? configuration_json.invocation_name
    : plugin_name ? `${plugin_name}:${skill.slug}` : skill.slug;
  return { phases: configuredPhases(configuration_json), plugin_name, invocation_name, configuration_json };
}

export function skillsForPhase(skills: SnapshottedSkill[], phase: SkillPhase) {
  return skills.filter((skill) => !Array.isArray(skill.phases) || skill.phases.includes(phase));
}

export async function snapshotSkillSet(
  skills: ResolvedSkill[],
  phases: SkillPhase[],
  skillsRoot = process.env.DCC_SKILLS_ROOT ?? REPO_ROOT,
) {
  const requestedPhases = new Set(phases);
  const snapshots: SnapshottedSkill[] = [];
  for (const skill of skills) {
    if (!skill.filesystem_path) throw new SkillResolutionError(skill.slug, "missing");
    const metadata = snapshotMetadata(skill);
    if (!metadata.phases.some((phase) => requestedPhases.has(phase))) continue;
    const files = await filesUnderSkill(skill.filesystem_path, skillsRoot);
    snapshots.push({
      skill_id: skill.id,
      slug: skill.slug,
      version: skill.version,
      filesystem_path: skill.filesystem_path,
      resolution_sources: skill.resolution_sources,
      phase: phases[0] ?? "planning",
      ...metadata,
      files,
      content_hash: createHash("sha256").update(JSON.stringify(files)).digest("hex"),
    });
  }
  const contentHash = createHash("sha256").update(JSON.stringify(snapshots)).digest("hex");
  return { skills: snapshots, contentHash };
}

export async function snapshotSkills(
  skills: ResolvedSkill[],
  phase: SkillPhase,
  skillsRoot = process.env.DCC_SKILLS_ROOT ?? REPO_ROOT,
) {
  return snapshotSkillSet(skills, [phase], skillsRoot);
}

export async function materializeSkillBundle(
  runId: string,
  skills: SnapshottedSkill[],
  dataRoot = process.env.DCC_DATA_ROOT ?? REPO_ROOT,
) {
  if (!/^[0-9a-f-]{36}$/i.test(runId)) throw new Error("invalid run id");
  const bundle = path.resolve(dataRoot, "data", "skill-bundles", runId);
  const pluginDirectories = new Map<string, string>();
  for (const skill of skills) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.slug)) throw new Error(`invalid skill slug: ${skill.slug}`);
    const pluginName = skill.plugin_name;
    if (pluginName !== null && pluginName !== undefined && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(pluginName)) {
      throw new Error(`invalid plugin name: ${pluginName}`);
    }
    const skillRoot = pluginName
      ? path.resolve(bundle, "plugins", pluginName, "skills", skill.slug)
      : path.resolve(bundle, ".claude", "skills", skill.slug);
    if (pluginName && !pluginDirectories.has(pluginName)) {
      const pluginDirectory = path.resolve(bundle, "plugins", pluginName);
      await mkdir(path.join(pluginDirectory, ".claude-plugin"), { recursive: true });
      await writeFile(path.join(pluginDirectory, ".claude-plugin", "plugin.json"), `${JSON.stringify({ name: pluginName }, null, 2)}\n`, { flag: "wx" });
      pluginDirectories.set(pluginName, pluginDirectory);
    }
    for (const file of skill.files) {
      const destination = path.resolve(skillRoot, file.path);
      if (!withinRoot(skillRoot, destination)) throw new Error(`invalid snapshot path: ${file.path}`);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, Buffer.from(file.content_base64, "base64"), { flag: "wx" });
    }
  }
  return { additionalDirectory: bundle, pluginDirectories: [...pluginDirectories.values()] };
}
