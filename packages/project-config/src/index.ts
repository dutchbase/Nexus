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

const GITHUB_POLICY_ENFORCEMENT_MODES = new Set(["auto", "required", "optional"]);

export function getGithubPolicyEnforcementMode(configJson: unknown): "auto" | "required" | "optional" {
  if (!configJson || typeof configJson !== "object") return "auto";
  const githubPolicy = (configJson as Record<string, unknown>).github_policy;
  if (!githubPolicy || typeof githubPolicy !== "object") return "auto";
  const enforcement = (githubPolicy as Record<string, unknown>).enforcement;
  return typeof enforcement === "string" && GITHUB_POLICY_ENFORCEMENT_MODES.has(enforcement)
    ? (enforcement as "auto" | "required" | "optional")
    : "auto";
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


export type ChangedFileDetail = {
  path: string;
  status: "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflicted";
  staged: boolean;
};

// Git porcelain v1 `-z` record: `XY PATH`, X = index/staged status,
// Y = worktree/unstaged status. Renames and copies carry their original path
// in a second record, consumed by parsePorcelainStatus.
function categorizePorcelainLine(record: string): ChangedFileDetail | null {
  if (record.length < 4) return null;
  const indexStatus = record[0];
  const worktreeStatus = record[1];
  const path = record.slice(3);
  const conflictCodes = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);
  const code = `${indexStatus}${worktreeStatus}`;
  if (conflictCodes.has(code)) return { path, status: "conflicted", staged: false };
  if (indexStatus === "?" && worktreeStatus === "?") return { path, status: "untracked", staged: false };
  if (indexStatus === "R") return { path, status: "renamed", staged: true };
  if (indexStatus === "A") return { path, status: "added", staged: true };
  if (indexStatus === "D") return { path, status: "deleted", staged: true };
  if (indexStatus === "M") return { path, status: "modified", staged: true };
  if (worktreeStatus === "D") return { path, status: "deleted", staged: false };
  if (worktreeStatus === "M") return { path, status: "modified", staged: false };
  return { path, status: "modified", staged: false };
}

// `-z` is what makes the reported paths the real ones: without it git
// C-quotes any path containing a space, a quote or a non-ASCII byte
// (`"caf\303\251.txt"`), which the diagnostics list would show verbatim.
// Records are NUL-terminated, and a rename/copy is two records — the new
// path, then the original — so those consume an extra field.
export function parsePorcelainStatus(stdout: string): { paths: string[]; detail: ChangedFileDetail[] } {
  const records = stdout.split("\0").filter(Boolean);
  const paths: string[] = [];
  const detail: ChangedFileDetail[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (["R", "C"].includes(record[0])) index += 1; // skip the original path
    const entry = categorizePorcelainLine(record);
    if (!entry) continue;
    paths.push(entry.path);
    detail.push(entry);
  }
  return { paths, detail };
}

export type InspectionErrorCode = "path_missing" | "not_a_repo" | "permission_denied" | "git_unavailable" | "timeout" | "unknown";

export type ValidateProjectResult =
  | { ok: true; valid: boolean; errors: string[]; changedFiles: string[]; changedFileDetail: ChangedFileDetail[] }
  | { ok: false; errorCode: InspectionErrorCode; message: string };

// execFile options accept a timeout; kept generous since repository
// inspection can run against network filesystems.
const GIT_INSPECTION_TIMEOUT_MS = 10_000;

function classifyInspectionError(error: unknown): { errorCode: InspectionErrorCode; message: string } {
  const err = error as NodeJS.ErrnoException & { stderr?: string; killed?: boolean; signal?: NodeJS.Signals | null };
  const message = (err?.stderr && err.stderr.trim()) || (error instanceof Error ? error.message : String(error));
  if (err?.killed || err?.signal === "SIGTERM") return { errorCode: "timeout", message };
  // execFile ENOENT for a missing `git` binary carries the command path/syscall,
  // distinguishing it from our own stat()/access() ENOENT on repositoryPath.
  if (err?.code === "ENOENT" && (err.path === "git" || (err.syscall ?? "").includes("spawn"))) {
    return { errorCode: "git_unavailable", message };
  }
  if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return { errorCode: "path_missing", message };
  if (err?.code === "EACCES") return { errorCode: "permission_denied", message };
  if (/not a git repository/i.test(message)) return { errorCode: "not_a_repo", message };
  return { errorCode: "unknown", message };
}

export async function validateProject(input: ProjectValidationInput): Promise<ValidateProjectResult> {
  const errors: string[] = [];
  errors.push(...await validateAgentStartPath(input.agentStartPath));

  try {
    if (!(await stat(input.repositoryPath)).isDirectory()) {
      return { ok: false, errorCode: "not_a_repo", message: "repository path is not a directory" };
    }
    await access(input.repositoryPath, constants.R_OK);
    await exec("git", ["-C", input.repositoryPath, "rev-parse", "--git-dir"], { timeout: GIT_INSPECTION_TIMEOUT_MS });
  } catch (error) {
    return { ok: false, ...classifyInspectionError(error) };
  }

  let changedFiles: string[] = [];
  let changedFileDetail: ChangedFileDetail[] = [];
  try {
    await exec("git", ["-C", input.repositoryPath, "show-ref", "--verify", `refs/heads/${input.defaultBranch}`], { timeout: GIT_INSPECTION_TIMEOUT_MS });
    const status = (await exec("git", ["-C", input.repositoryPath, "status", "--porcelain", "-z"], { timeout: GIT_INSPECTION_TIMEOUT_MS })).stdout;
    ({ paths: changedFiles, detail: changedFileDetail } = parsePorcelainStatus(status));
    if (changedFiles.length) errors.push("repository has uncommitted changes");
    if (input.requireRemote !== false) {
      const remotes = (await exec("git", ["-C", input.repositoryPath, "remote"], { timeout: GIT_INSPECTION_TIMEOUT_MS })).stdout.trim();
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
  return { ok: true, valid: errors.length === 0, errors, changedFiles, changedFileDetail };
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
