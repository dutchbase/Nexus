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

export type DeploymentConfig = {
  enabled: boolean;
  production_branch: string;
  image: { registry: string; repository: string; tag_template: string };
  health?: { host: string; health_path: string; version_path: string; version_field?: string };
  promotion: { require_e2e_gate_label: boolean; e2e_gate_label?: string };
  auto_rollback_on_failed_health_check?: boolean;
  cron_jobs?: Array<{ key: string; description?: string; expected_interval_minutes: number; grace_minutes?: number }>;
  cron_webhook_secret_reference?: string;
  mechanism?: "health_check" | "github_actions_jobs"; // defaults to "health_check" when absent
  actions?: { docker_image_job_name: string; migrations_job_name: string; deploy_job_name: string }; // required iff mechanism === "github_actions_jobs"
};

// Mirrors notification-provider's secretReferencePattern: only env vars with this
// exact prefix may be nominated as the cron webhook secret, so admin-authored
// config can never point an unauthenticated public endpoint at an arbitrary
// env var (DATABASE_URL, session secrets, etc).
export const cronWebhookSecretReferencePattern = /^DCC_DEPLOYMENT_SECRET_[A-Za-z_][A-Za-z0-9_]*$/;

// Pure shape check — no I/O, no network, never throws. Returns [] when
// `value` is either absent (deployment is fully optional per project) or a
// well-formed DeploymentConfig; otherwise returns human-readable messages
// naming exactly what's wrong, in the order checked.
export function validateDeploymentConfig(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value !== "object" || Array.isArray(value)) return ["deployment must be an object"];
  const v = value as Record<string, unknown>;
  const errors: string[] = [];
  if (typeof v.enabled !== "boolean") errors.push("deployment.enabled must be a boolean");
  if (v.enabled !== true) return errors; // disabled/absent config needs no further shape checking
  if (typeof v.production_branch !== "string" || !v.production_branch.trim()) errors.push("deployment.production_branch is required");
  const image = v.image as Record<string, unknown> | undefined;
  if (!image || typeof image !== "object") errors.push("deployment.image is required");
  else {
    if (typeof image.registry !== "string" || !image.registry.trim()) errors.push("deployment.image.registry is required");
    if (typeof image.repository !== "string" || !image.repository.trim()) errors.push("deployment.image.repository is required");
    if (typeof image.tag_template !== "string" || !image.tag_template.includes("{{commit}}")) errors.push("deployment.image.tag_template must contain {{commit}}");
  }
  const mechanism = v.mechanism === undefined ? "health_check" : v.mechanism;
  if (mechanism !== "health_check" && mechanism !== "github_actions_jobs") {
    errors.push('deployment.mechanism must be "health_check" or "github_actions_jobs"');
  }
  const health = v.health as Record<string, unknown> | undefined;
  if (mechanism === "health_check") {
    if (!health || typeof health !== "object") errors.push("deployment.health is required");
    else {
      if (typeof health.host !== "string" || !/^https?:\/\//.test(health.host)) errors.push("deployment.health.host must be an http(s) URL");
      if (typeof health.health_path !== "string" || !health.health_path.startsWith("/")) errors.push("deployment.health.health_path must start with /");
      if (typeof health.version_path !== "string" || !health.version_path.startsWith("/")) errors.push("deployment.health.version_path must start with /");
    }
  } else if (health !== undefined) {
    // health is optional under github_actions_jobs, but if provided it must still be well-formed
    if (typeof health !== "object") errors.push("deployment.health must be an object when provided");
    else {
      if (typeof health.host !== "string" || !/^https?:\/\//.test(health.host)) errors.push("deployment.health.host must be an http(s) URL");
      if (typeof health.health_path !== "string" || !health.health_path.startsWith("/")) errors.push("deployment.health.health_path must start with /");
      if (typeof health.version_path !== "string" || !health.version_path.startsWith("/")) errors.push("deployment.health.version_path must start with /");
    }
  }
  if (mechanism === "github_actions_jobs") {
    const actions = v.actions as Record<string, unknown> | undefined;
    if (!actions || typeof actions !== "object") errors.push("deployment.actions is required when mechanism is github_actions_jobs");
    else {
      if (typeof actions.docker_image_job_name !== "string" || !actions.docker_image_job_name.trim()) errors.push("deployment.actions.docker_image_job_name is required");
      if (typeof actions.migrations_job_name !== "string" || !actions.migrations_job_name.trim()) errors.push("deployment.actions.migrations_job_name is required");
      if (typeof actions.deploy_job_name !== "string" || !actions.deploy_job_name.trim()) errors.push("deployment.actions.deploy_job_name is required");
    }
  }
  const promotion = v.promotion as Record<string, unknown> | undefined;
  if (!promotion || typeof promotion !== "object") errors.push("deployment.promotion is required");
  else if (typeof promotion.require_e2e_gate_label !== "boolean") errors.push("deployment.promotion.require_e2e_gate_label must be a boolean");
  if (v.cron_jobs !== undefined) {
    if (!Array.isArray(v.cron_jobs)) errors.push("deployment.cron_jobs must be an array");
    else v.cron_jobs.forEach((job: any, i: number) => {
      if (typeof job?.key !== "string" || !job.key.trim()) errors.push(`deployment.cron_jobs[${i}].key is required`);
      if (typeof job?.expected_interval_minutes !== "number" || job.expected_interval_minutes <= 0) errors.push(`deployment.cron_jobs[${i}].expected_interval_minutes must be a positive number`);
    });
  }
  if (v.cron_webhook_secret_reference !== undefined) {
    if (typeof v.cron_webhook_secret_reference !== "string" || !cronWebhookSecretReferencePattern.test(v.cron_webhook_secret_reference)) {
      errors.push("deployment.cron_webhook_secret_reference must match DCC_DEPLOYMENT_SECRET_<NAME>");
    }
  }
  if (image && typeof image === "object" && typeof image.registry === "string" && image.registry.trim() && image.registry !== "ghcr.io") {
    errors.push("deployment.image.registry must be ghcr.io (only registry currently supported)");
  }
  return errors;
}
