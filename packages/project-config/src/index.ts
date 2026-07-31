import { access, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parse } from "yaml";

const exec = promisify(execFile);

export type ProjectConfigFile = {
  version: number;
  defaults?: Record<string, unknown>;
  projects: Record<string, Record<string, any>>;
};

export async function loadProjectConfig(path = process.env.PROJECTS_CONFIG_PATH ?? resolve("config/projects.yaml")) {
  const content = await readFile(path, "utf8");
  const parsed = parse(content) as ProjectConfigFile;
  if (!parsed || parsed.version !== 1 || !parsed.projects || typeof parsed.projects !== "object") {
    throw new Error("projects.yaml must contain version: 1 and a projects mapping");
  }
  return { path, content, config: parsed };
}

export type ProjectValidationInput = {
  repositoryPath: string;
  defaultBranch: string;
  worktreeRoot?: string;
  promptDirectory?: string;
  automaticSkillPaths?: string[];
  validationCommands?: string[];
  requireRemote?: boolean;
  agentStartPath?: string | null;
};

export function normalizeAgentStartPath(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export async function validateAgentStartPath(path: unknown) {
  if (path === null || path === undefined || path === "") return [];
  if (typeof path !== "string") return ["planning agent start path must be a string"];
  if (!path.trim()) return [];
  if (!isAbsolute(path)) return ["planning agent start path must be absolute"];
  try {
    if (!(await stat(path)).isDirectory()) throw new Error();
    await access(path, constants.R_OK | constants.X_OK);
    return [];
  } catch {
    return ["planning agent start path is not a readable and searchable directory"];
  }
}


export async function validateProject(input: ProjectValidationInput) {
  const errors: string[] = [];
  const changedFiles: string[] = [];
  errors.push(...await validateAgentStartPath(input.agentStartPath));
  try {
    if (!(await stat(input.repositoryPath)).isDirectory()) errors.push("repository path is not a directory");
    await access(input.repositoryPath, constants.R_OK);
    await exec("git", ["-C", input.repositoryPath, "rev-parse", "--git-dir"]);
    await exec("git", ["-C", input.repositoryPath, "show-ref", "--verify", `refs/heads/${input.defaultBranch}`]);
    const status = (await exec("git", ["-C", input.repositoryPath, "status", "--porcelain"])).stdout;
    changedFiles.push(...status.split("\n").filter(Boolean).map((line) => line.slice(3)));
    if (changedFiles.length) errors.push("repository has uncommitted changes");
    if (input.requireRemote !== false) {
      const remotes = (await exec("git", ["-C", input.repositoryPath, "remote"])).stdout.trim();
      if (!remotes) errors.push("configured remote does not exist");
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "repository validation failed");
  }
  if (input.worktreeRoot) {
    try { await access(dirname(resolve(input.worktreeRoot)), constants.W_OK); } catch { errors.push("worktree location is not writable"); }
  }
  for (const path of [input.promptDirectory, ...(input.automaticSkillPaths ?? [])].filter(Boolean) as string[]) {
    try { await access(path, constants.R_OK); } catch { errors.push(`required path is not readable: ${path}`); }
  }
  for (const command of input.validationCommands ?? []) {
    if (!command.trim()) errors.push("validation command is empty");
  }
  return { valid: errors.length === 0, errors, changedFiles };
}
