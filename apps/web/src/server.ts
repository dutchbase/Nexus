import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { clientIpOf, csrfMatches, secureCookieAttributes, securityHeaders, validateWebRuntime } from "./security.ts";
import { rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { artifactDataRoot, legacyArtifactDataRoot, finalizeArtifact, inTransaction, pool, readArtifact, readStagedArtifact, stageArtifact } from "@dcc/database";
import {
  AiConfigurationError, ApprovalConflictError, ApprovalPolicyError, approvePlanDecision, buildApprovedInputSnapshot,
  buildExecutionPrompt, buildPlanningPrompt, checkPlanApprovalGate, enqueueJob,
  globalPromptTypes, enqueueNotification, promptContentHash, PullRequestMergeError,
  rejectPlanDecision, requestPlanRevisionDecision, requireApprovalPrompt, resolveAiConfiguration, setPullRequestTicketStatus,
  validateAiSelection, type AiPhase, type ApprovedInputSnapshot, type ApprovalInputValue,
} from "@dcc/domain";
import {
  mergeNotificationConfiguration, parseNotificationConfiguration, parseNotificationConfigurationPatch,
  safeNotificationProvider,
} from "../../../packages/notification-provider/src/index.ts";
import {
  resolveSkills, snapshotSkillSet, snapshotSkills, SkillResolutionError, type ResolutionSource, type SkillCandidate,
} from "../../../packages/skill-registry/src/index.ts";
import { hashPassword, verifyPassword } from "../../../packages/database/src/password.ts";
import { normalizeAgentStartPath, validateAgentStartPath, validateProject } from "@dcc/project-config";
import { adminPage, escapeHtml, loginPage, publicFormPage, submittedPage } from "./ui.ts";
import { allowedTemplateVariables, fieldsFor, lineDiff, validStatuses } from "./pages/shared.ts";
import * as dashboardPage from "./pages/dashboard.ts";
import * as ticketsPage from "./pages/tickets.ts";
import * as runsPage from "./pages/runs.ts";
import * as prsPage from "./pages/prs.ts";
import * as projectsPage from "./pages/projects.ts";
import * as formsPage from "./pages/forms.ts";
import * as promptsPage from "./pages/prompts.ts";
import * as skillsPage from "./pages/skills.ts";
import * as notificationsPage from "./pages/notifications.ts";
import * as queuePage from "./pages/queue.ts";
import * as auditPage from "./pages/audit.ts";
import * as operatePage from "./pages/operate.ts";

const port = Number(process.env.PORT ?? 3000);
const { production, trustedProxyHops } = validateWebRuntime();
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const dataRoot = artifactDataRoot(REPO_ROOT);
const legacyDataRoot = legacyArtifactDataRoot(REPO_ROOT);
const lockoutThreshold = 5;
const lockoutWindowMinutes = 15;
const sessionHours = 8;
const maxJsonBytes = 1024 * 1024;
const maxUploadBytes = 5 * 1024 * 1024;
const exec = promisify(execFile);
const defaultRateLimit = 15;
const dummyHash = await hashPassword(randomBytes(32).toString("hex"));
const systemOnlyStatuses = new Set(["Planning", "Execution Queued", "Executing", "Validating", "PR Ready for Review", "Merged"]);
const fieldTypes = new Set([
  "short_text", "long_text", "email", "url", "number", "dropdown", "radio", "checkbox", "multi_select",
  "project_selector", "category_selector", "environment_selector", "image_upload", "hidden", "static",
]);
const optionTypes = new Set(["dropdown", "radio", "multi_select", "category_selector", "environment_selector"]);
const skillSourceTypes = new Set([
  "workspace_global", "project_local", "personal_claude", "repository", "external_directory",
]);
const skillAttachmentTypes = new Set(["automatic", "required"]);

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

async function terminalRerunSource(client: any, metadata: any) {
  const id = metadata?.job_id;
  if (typeof id !== "string") return undefined;
  const source = (await client.query("SELECT status FROM jobs WHERE id=$1 FOR UPDATE", [id])).rows[0];
  if (!source || !["completed", "failed", "cancelled", "blocked_auth", "blocked_auth_configuration"].includes(source.status)) {
    throw Object.assign(new Error("source job is still active"), { status: 409 });
  }
  return id;
}

function ticketAiConfiguration(ticket: any) {
  return {
    default: { model: ticket.default_model, reasoning_level: ticket.default_reasoning_level },
    planning: { model: ticket.planning_model, reasoning_level: ticket.planning_reasoning_level },
    execution: { model: ticket.execution_model, reasoning_level: ticket.execution_reasoning_level },
    repair: { model: ticket.repair_model, reasoning_level: ticket.repair_reasoning_level },
  };
}

function projectAiConfiguration(project: any) {
  const ai = project.config_json?.ai ?? {};
  return {
    default: { model: ai.default_model, reasoning_level: ai.default_reasoning_level },
    planning: ai.planning,
    execution: ai.execution,
    repair: ai.repair,
  };
}

function resolvedAiFor(ticket: any, project: any, phase: AiPhase) {
  return resolveAiConfiguration({
    phase,
    system: { default: { model: "sonnet", reasoning_level: "high" } },
    project: projectAiConfiguration(project),
    ticket: ticketAiConfiguration(ticket),
  });
}

async function skillCandidates(ticket: any, phase: AiPhase, client: any = pool): Promise<SkillCandidate[]> {
  const rows = (await client.query(
    `SELECT resolved.* FROM (
       SELECT s.*, 'global_mandatory'::text source, 1 source_order, NULL::boolean allow_ticket_override
       FROM skills s WHERE COALESCE((s.configuration_json->>'mandatory')::boolean, false)
       UNION ALL
       SELECT s.*, CASE WHEN ps.attachment_type='required' OR ps.required THEN 'project_required' ELSE 'project_automatic' END, 2,
              ps.allow_ticket_override
       FROM project_skills ps JOIN skills s ON s.id=ps.skill_id
       WHERE ps.project_id=$1 AND (ps.attachment_type IN ('automatic','required') OR ps.required)
       UNION ALL
       SELECT s.*, CASE WHEN ts.source='excluded' THEN 'ticket_excluded' ELSE 'ticket_selected' END, 3, ps.allow_ticket_override
       FROM ticket_skills ts LEFT JOIN skills s ON s.id=ts.skill_id
       LEFT JOIN project_skills ps ON ps.project_id=$1 AND ps.skill_id=ts.skill_id
       WHERE ts.ticket_id=$2
       UNION ALL
       SELECT s.*, 'phase_required', 4, NULL::boolean
       FROM skills s WHERE s.configuration_json->'required_phases' ? $3
     ) resolved ORDER BY source_order, slug, id`,
    [ticket.project_id, ticket.id, phase],
  )).rows;
  return rows.map((row: any) => ({
    skill: row.id ? row : null,
    skillId: row.id,
    slug: row.slug,
    source: row.source as ResolutionSource,
    allowTicketOverride: row.allow_ticket_override,
  }));
}

async function resolvedSkillsFor(ticket: any, phase: AiPhase, client: any = pool) {
  return resolveSkills(await skillCandidates(ticket, phase, client), ticket.project_id, phase);
}

function validatePromptTemplate(content: unknown) {
  if (typeof content !== "string") throw Object.assign(new Error("prompt content must be Markdown text"), { status: 400 });
  const variables = [...content.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)].map((match) => match[1]);
  const invalid = variables.filter((variable) => !allowedTemplateVariables.has(variable));
  if (invalid.length) {
    throw Object.assign(new Error(`unknown template variable: ${invalid.join(", ")}`), { status: 422 });
  }
  return { valid: true, variables: [...new Set(variables)].sort() };
}

function renderPromptTemplate(content: string, values: Record<string, unknown>) {
  return content.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_match, variable: string) => String(values[variable] ?? ""));
}

async function resolvedPrompt(promptType: string, projectId: string, client: any = pool) {
  const row = (await client.query(
    `SELECT pf.id prompt_file_id,pf.active_version_id,pv.content,pv.version
     FROM prompt_files pf LEFT JOIN prompt_versions pv ON pv.id=pf.active_version_id
     WHERE pf.prompt_type=$1 AND pf.active_version_id IS NOT NULL
       AND ((pf.scope='project' AND pf.project_id=$2) OR (pf.scope='global' AND pf.project_id IS NULL))
     ORDER BY CASE pf.scope WHEN 'project' THEN 0 ELSE 1 END
     LIMIT 1`,
    [promptType, projectId],
  )).rows[0];
  return row ?? { prompt_file_id: null, active_version_id: null, content: "", version: null };
}

async function promptInputsFor(ticket: any, phase: "planning" | "execution", approvedPlan?: string, client: any = pool) {
  const project = (await client.query("SELECT * FROM projects WHERE id=$1", [ticket.project_id])).rows[0];
  if (!project) throw Object.assign(new Error("project not found"), { status: 404 });
  const [base, phaseResolved] = await Promise.all([
    resolvedPrompt("base", project.id, client),
    resolvedPrompt(phase, project.id, client),
  ]);
  const ai = resolvedAiFor(ticket, project, phase);
  const skills = await resolvedSkillsFor(ticket, phase, client);
  const templateValues = {
    "project.slug": project.slug,
    "project.name": project.name,
    "project.description": project.description,
    "project.repository_path": project.repository_path,
    "project.agent_start_path": project.agent_start_path ?? project.repository_path,
    "project.default_branch": project.default_branch,
    "ticket.title": ticket.title,
    "ticket.description": ticket.description,
    "ticket.category": ticket.category,
    "ticket.priority": ticket.priority,
  };
  for (const prompt of [base, phaseResolved]) {
    prompt.content = renderPromptTemplate(prompt.content ?? "", templateValues);
  }
  const resolvedSkillContent = skills.map((skill) => ({
    id: skill.id, slug: skill.slug, version: skill.version, resolution_sources: skill.resolution_sources,
  }));
  const promptVersionIds = Object.fromEntries(
    [
      // ponytail: a project override's version id is recorded under a global.* key;
      // no consumer reads these keys, scoped keys if audit provenance ever matters.
      ["global.base", base.active_version_id],
      [`global.${phase}`, phaseResolved.active_version_id],
    ].filter(([, id]) => id),
  );
  if (phase === "planning") {
    return {
      content: buildPlanningPrompt({
        globalBaseInstructions: base.content,
        globalPlanningInstructions: phaseResolved.content,
        projectContext: "",
        projectPlanningInstructions: "",
        projectPathsAndRepositoryMetadata: {
          default_branch: project.default_branch,
          github_owner: project.github_owner,
          github_repository: project.github_repository,
          repository_path: project.repository_path,
          agent_start_path: project.agent_start_path ?? project.repository_path,
          slug: project.slug,
        },
        resolvedAiConfiguration: ai,
        resolvedSkills: resolvedSkillContent,
        ticket: {
          title: ticket.title, description: ticket.description, category: ticket.category, priority: ticket.priority,
          environment: ticket.environment, expectedBehavior: ticket.expected_behavior,
          actualBehavior: ticket.actual_behavior, reproductionSteps: ticket.reproduction_steps,
          customValues: ticket.custom_values_json,
        },
        requiredPlanStructure: "Return a Markdown plan with scope, implementation steps, tests, risks, and validation.",
        outputConstraints: "Planning is read-only. Do not modify files, commit, push, or open a pull request.",
      }),
      ai, skills, promptVersionIds, project,
    };
  }
  return {
    content: buildExecutionPrompt({
      globalBaseInstructions: base.content,
      globalExecutionInstructions: phaseResolved.content,
      projectContext: "",
      projectExecutionInstructions: "",
      projectTestingInstructions: "",
      resolvedAiConfiguration: ai,
      resolvedSkills: resolvedSkillContent,
      exactApprovedPlan: approvedPlan ?? "",
      worktreeDetails: {
        repository_path: project.repository_path,
        default_branch: project.default_branch,
      },
      validationCommands: project.config_json?.validation_commands ?? [],
      definitionOfDone: project.config_json?.definition_of_done ?? "The approved plan is implemented and validation passes.",
      outputConstraints: "Work only inside the assigned worktree. Do not push, merge, or open a pull request.",
    }),
    ai, skills, promptVersionIds, project,
  };
}

export async function approvalInputsFor(ticket: any, version: any, client: any) {
  const project = (await client.query("SELECT * FROM projects WHERE id=$1", [ticket.project_id])).rows[0];
  if (!project?.enabled) throw new ApprovalPolicyError("Project is missing or disabled");
  const promptRows = (await client.query(
    `SELECT pf.scope,pf.prompt_type,pf.active_version_id,pv.content,pv.content_hash
     FROM prompt_files pf JOIN prompt_versions pv ON pv.id=pf.active_version_id
     WHERE pf.prompt_type=ANY($1::text[]) AND pf.active_version_id IS NOT NULL
       AND ((pf.scope='global' AND pf.project_id IS NULL) OR (pf.scope='project' AND pf.project_id=$2))`,
    [["base", "execution", "execution-repair", "context", "testing"], project.id],
  )).rows;
  const prompt = (scope: string, type: string) => promptRows.find((row: any) => row.scope === scope && row.prompt_type === type);
  const base = requireApprovalPrompt(prompt("global", "base"), "global", "base");
  const execution = requireApprovalPrompt(prompt("global", "execution"), "global", "execution");
  const repair = requireApprovalPrompt(prompt("global", "execution-repair"), "global", "execution-repair");
  const phases: AiPhase[] = ["planning", "execution", "repair"];
  const phaseSkills = await Promise.all(phases.map((phase) => resolvedSkillsFor(ticket, phase, client)));
  const union = new Map<string, any>();
  for (const skill of phaseSkills.flat()) {
    const existing = union.get(skill.id);
    if (!existing) union.set(skill.id, { ...skill, resolution_sources: [...skill.resolution_sources] });
    else for (const source of skill.resolution_sources) if (!existing.resolution_sources.includes(source)) existing.resolution_sources.push(source);
  }
  const snapshotted = await snapshotSkillSet([...union.values()], phases);
  const models = Object.fromEntries(phases.map((phase) => {
    const resolved = resolvedAiFor(ticket, project, phase);
    return [phase, { model: resolved.model, reasoningLevel: resolved.reasoning_level }];
  }));
  const values = {
    "project.slug": project.slug, "project.name": project.name, "project.description": project.description,
    "project.repository_path": project.repository_path, "project.agent_start_path": project.agent_start_path ?? project.repository_path,
    "project.default_branch": project.default_branch, "ticket.title": ticket.title, "ticket.description": ticket.description,
    "ticket.category": ticket.category, "ticket.priority": ticket.priority,
  };
  const rendered = (row: any) => renderPromptTemplate(row?.content ?? "", values);
  const provenance = (...rows: any[]) => rows.filter(Boolean).map((row) => ({
    scope: row.scope, promptType: row.prompt_type, versionId: row.active_version_id, contentHash: row.content_hash,
  }));
  const context = prompt("project", "context"), projectExecution = prompt("project", "execution"), testing = prompt("project", "testing");
  const skillContent = (phase: AiPhase) => snapshotted.skills
    .filter((skill) => !skill.phases || skill.phases.includes(phase))
    .map((skill) => ({ id: skill.skill_id, slug: skill.slug, version: skill.version, resolution_sources: skill.resolution_sources }));
  const phaseContent = (phase: "execution" | "repair") => buildExecutionPrompt({
    globalBaseInstructions: rendered(base), globalExecutionInstructions: rendered(execution), projectContext: rendered(context),
    projectExecutionInstructions: rendered(projectExecution), projectTestingInstructions: rendered(testing),
    resolvedAiConfiguration: models[phase], resolvedSkills: skillContent(phase), exactApprovedPlan: version.content_markdown,
    worktreeDetails: {}, validationCommands: project.config_json?.validation_commands ?? [],
    definitionOfDone: project.config_json?.definition_of_done ?? "Implement the approved plan.",
    outputConstraints: "Use the assigned worktree. Do not push, merge, or publish.",
  });
  const executionContent = phaseContent("execution");
  const policySources = (await client.query(
    `SELECT ps.skill_id,s.slug,ps.attachment_type,ps.required,ps.allow_ticket_override
     FROM project_skills ps JOIN skills s ON s.id=ps.skill_id WHERE ps.project_id=$1 ORDER BY s.slug`,
    [project.id],
  )).rows;
  const approvedInput: ApprovedInputSnapshot = {
    plan: { versionId: version.id, version: Number(version.version), contentHash: version.content_hash },
    ticket: {
      title: ticket.title, description: ticket.description, category: ticket.category, priority: ticket.priority,
      environment: ticket.environment, expectedBehavior: ticket.expected_behavior, actualBehavior: ticket.actual_behavior,
      reproductionSteps: ticket.reproduction_steps, customValues: ticket.custom_values_json ?? {},
    },
    project: { configVersion: Number(project.config_version), config: {
      slug: project.slug, name: project.name, description: project.description, enabled: project.enabled,
      repositoryPath: project.repository_path, agentStartPath: project.agent_start_path ?? project.repository_path,
      githubOwner: project.github_owner, githubRepository: project.github_repository, defaultBranch: project.default_branch,
      configuration: project.config_json ?? {},
    } },
    models,
    prompts: [
      { phase: "execution", content: executionContent, provenance: provenance(base, execution, context, projectExecution, testing) },
      { phase: "repair", content: `${phaseContent("repair")}\n## Repair instructions\n\n${rendered(repair)}\n`, provenance: provenance(base, execution, repair, context, projectExecution, testing) },
    ],
    skills: snapshotted.skills.map((skill) => ({
      id: skill.skill_id, slug: skill.slug, version: skill.version, contentHash: skill.content_hash,
      sources: skill.resolution_sources, filesystemPath: skill.filesystem_path, phase: skill.phase,
      phases: skill.phases ?? [skill.phase], pluginName: skill.plugin_name ?? null,
      invocationName: skill.invocation_name ?? null, configuration: (skill.configuration_json ?? {}) as ApprovalInputValue,
    })),
    policySources,
  };
  return { ...buildApprovedInputSnapshot(approvedInput), approvedInput, snapshottedSkills: snapshotted };
}

function json(response: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", ...securityHeaders(), ...(headers as Record<string, string | string[]>) });
  response.end(JSON.stringify(body));
}

function html(response: ServerResponse, status: number, body: string, headers: Record<string, string> = {}) {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8", ...securityHeaders(), ...headers });
  response.end(body);
}

async function bodyBuffer(request: IncomingMessage, maximum: number) {
  const declared = Number(request.headers["content-length"] ?? 0);
  if (declared > maximum) throw Object.assign(new Error("request too large"), { status: 413 });
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximum) throw Object.assign(new Error("request too large"), { status: 413 });
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function bodyOf(request: IncomingMessage) {
  const body = await bodyBuffer(request, maxJsonBytes);
  if (!body.length) return {};
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw Object.assign(new Error("invalid JSON"), { status: 400 });
  }
}

function cookieValue(request: IncomingMessage, name: string) {
  const part = request.headers.cookie?.split(";").map((item) => item.trim()).find((item) => item.startsWith(`${name}=`));
  return part?.slice(name.length + 1);
}

function ipOf(request: IncomingMessage) {
  return clientIpOf(request, trustedProxyHops);
}

async function audit(values: {
  actorType: string; actorId?: string | null; action: string; entityType?: string;
  entityId?: string | null; before?: unknown; after?: unknown; metadata?: unknown; ip?: string | null;
}, client: any = pool) {
  await client.query(
    `INSERT INTO audit_events
      (actor_type, actor_id, action, entity_type, entity_id, before_json, after_json, metadata_json, ip_address)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [values.actorType, values.actorId ?? null, values.action, values.entityType ?? null, values.entityId ?? null,
      values.before ?? null, values.after ?? null, values.metadata ?? {}, values.ip ?? null],
  );
}

async function sessionFor(request: IncomingMessage) {
  const token = cookieValue(request, "dcc_session");
  if (!token) return null;
  const result = await pool.query(
    `SELECT s.*, u.username, u.role FROM admin_sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.invalidated_at IS NULL AND s.expires_at > now() AND u.is_active = true`,
    [hash(token)],
  );
  return result.rows[0] ?? null;
}

async function requireAdmin(request: IncomingMessage, response: ServerResponse) {
  const session = await sessionFor(request);
  if (!session) {
    json(response, 401, { error: "authentication required" });
    return null;
  }
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method ?? "GET")) {
    const csrf = request.headers["x-csrf-token"];
    if (typeof csrf !== "string" || !csrfMatches(csrf, session.csrf_token_hash)) {
      json(response, 403, { error: "invalid CSRF token" });
      return null;
    }
  }
  return session;
}

async function login(request: IncomingMessage, response: ServerResponse) {
  const body = await bodyOf(request);
  const username = typeof body.username === "string" ? body.username : "";
  const password = typeof body.password === "string" ? body.password : "";
  const ip = ipOf(request);
  const failures = await pool.query(
    `SELECT count(*)::integer AS count,
       COALESCE(ceil(extract(epoch FROM (min(attempted_at) + make_interval(mins => $2) - now()))), 0)::integer AS retry_after_seconds
     FROM login_attempts
     WHERE ip_address = $1 AND succeeded = false AND attempted_at > now() - make_interval(mins => $2)`,
    [ip, lockoutWindowMinutes],
  );
  if (failures.rows[0].count >= lockoutThreshold) {
    await audit({ actorType: "anonymous", action: "login.failed", entityType: "user", after: { success: false }, metadata: { reason: "throttled" }, ip });
    return json(response, 429, { error: "too many login attempts", retry_after_seconds: Math.max(1, failures.rows[0].retry_after_seconds) });
  }
  const user = (await pool.query("SELECT * FROM users WHERE username = $1 AND is_active = true", [username])).rows[0];
  const valid = await verifyPassword(user?.password_hash ?? dummyHash, password);
  await pool.query("INSERT INTO login_attempts (username, ip_address, succeeded) VALUES ($1, $2, $3)", [username, ip, Boolean(user && valid)]);
  if (!user || !valid) {
    await audit({ actorType: "anonymous", action: "login.failed", entityType: "user", after: { success: false }, ip });
    return json(response, 401, { error: "invalid credentials" });
  }
  const token = randomBytes(32).toString("base64url");
  const csrf = randomBytes(32).toString("base64url");
  await inTransaction(async (client) => {
    await client.query("DELETE FROM login_attempts WHERE ip_address = $1", [ip]);
    await client.query(
      `INSERT INTO admin_sessions (user_id, token_hash, csrf_token_hash, expires_at)
       VALUES ($1, $2, $3, now() + make_interval(hours => $4))`,
      [user.id, hash(token), hash(csrf), sessionHours],
    );
    await client.query("UPDATE users SET last_login_at = now(), updated_at = now() WHERE id = $1", [user.id]);
    await audit({ actorType: "admin", actorId: user.id, action: "login", entityType: "user", entityId: user.id, after: { success: true }, ip }, client);
  });
  const sessionAttributes = [`dcc_session=${token}`, "HttpOnly", ...secureCookieAttributes(production), `Max-Age=${sessionHours * 3600}`];
  const csrfAttributes = [`dcc_csrf=${csrf}`, ...secureCookieAttributes(production), `Max-Age=${sessionHours * 3600}`];
  json(response, 200, { user: { id: user.id, username: user.username, role: user.role }, csrfToken: csrf }, { "set-cookie": [sessionAttributes.join("; "), csrfAttributes.join("; ")] });
}

async function publicForm(slug: string) {
  return (await pool.query("SELECT * FROM forms WHERE slug = $1 AND status = 'published'", [slug])).rows[0] ?? null;
}

export function validateFields(fields: any[], body: Record<string, any>) {
  const errors: Record<string, string> = {};
  for (const field of fields) {
    if (field.field_type === "hidden" || field.field_type === "static") continue;
    const value = body[field.field_key];
    if (field.field_type === "image_upload") {
      const ids = Array.isArray(value) ? value : (typeof value === "string" && value ? [value] : []);
      if (field.required && !ids.length) errors[field.field_key] = "required";
      else if (ids.length > 5) errors[field.field_key] = "max 5 files";
      else if (ids.some((id) => typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id))) errors[field.field_key] = "invalid upload";
      continue;
    }
    if (field.required && (value === undefined || value === null || value === "")) errors[field.field_key] = "required";
    if (optionTypes.has(field.field_type)) {
      const options = Array.isArray(field.options_json) ? field.options_json : [];
      const values = Array.isArray(value) ? value : (value === undefined || value === null || value === "" ? [] : [value]);
      if (field.field_type !== "multi_select" && values.length > 1) errors[field.field_key] = "invalid option";
      else if (values.some((v: any) => !options.includes(v))) errors[field.field_key] = "invalid option";
      continue;
    }
    if (typeof value === "string") {
      const limit = Math.min(Number(field.validation_json?.max_length ?? (field.field_type === "long_text" ? 10000 : 500)), 10000);
      if (value.length > limit) errors[field.field_key] = "too long";
      if (field.field_type === "email" && value && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) errors[field.field_key] = "invalid email";
      if (field.field_type === "url" && value) {
        try {
          const parsed = new URL(value);
          if (parsed.protocol !== "http:" && parsed.protocol !== "https:") errors[field.field_key] = "invalid URL";
        } catch { errors[field.field_key] = "invalid URL"; }
      }
    }
  }
  return errors;
}

export function sanitizeFormSettings(settings: any): Record<string, any> {
  const source = settings ?? {};
  return {
    rate_limit: Math.max(1, Math.min(20, Number.parseInt(source.rate_limit, 10) || 15)),
    captcha_mode: "honeypot",
    notify_on_submission: source.notify_on_submission !== false,
    allow_image_attachments: source.allow_image_attachments !== false,
    completion_message: String(source.completion_message ?? "").slice(0, 2000),
  };
}

async function submitPublicForm(request: IncomingMessage, response: ServerResponse, form: any) {
  const body = await bodyOf(request);
  const fields = await fieldsFor(form.id);
  const honeypot = fields.find((field) => field.field_type === "hidden")?.field_key ?? "website";
  if (typeof body[honeypot] === "string" && body[honeypot].trim()) {
    return json(response, 202, { accepted: true });
  }
  const ip = ipOf(request);
  const configuredLimit = Number(form.settings_json?.rate_limit ?? defaultRateLimit);
  const limit = Number.isFinite(configuredLimit) ? Math.max(1, Math.min(configuredLimit, 20)) : defaultRateLimit;
  const recent = await pool.query(
    `SELECT count(*)::integer AS count FROM public_submission_attempts
     WHERE form_id = $1 AND ip_address = $2 AND created_at > now() - interval '15 seconds'`,
    [form.id, ip],
  );
  if (recent.rows[0].count >= limit) return json(response, 429, { error: "submission rate limit exceeded" });
  const errors = validateFields(fields, body);
  if (form.settings_json?.allow_image_attachments === false) {
    for (const field of fields) {
      if (field.field_type !== "image_upload") continue;
      const value = body[field.field_key];
      if (Array.isArray(value) ? value.length : value) errors[field.field_key] = "attachments disabled";
    }
  }
  if (typeof body.title !== "string" || !body.title.trim()) errors.title = "required";
  if (typeof body.description !== "string" || !body.description.trim()) errors.description = "required";
  if (Object.keys(errors).length) return json(response, 400, { error: "validation failed", fields: errors });
  const requestedProjectId = form.fixed_project_id ?? body.project_id;
  const requestedProjectSlug = typeof body.project_slug === "string" ? body.project_slug : undefined;
  const project = requestedProjectId
    ? (await pool.query("SELECT id FROM projects WHERE id = $1 AND enabled = true", [requestedProjectId])).rows[0]
    : requestedProjectSlug
    ? (await pool.query("SELECT id FROM projects WHERE slug = $1 AND enabled = true", [requestedProjectSlug])).rows[0]
    : undefined;
  if ((requestedProjectId || requestedProjectSlug) && !project) return json(response, 400, { error: "valid project is required" });
  // No project selected and the form isn't fixed to one: triage assigns it
  // later (PRD §17.1's Submitted -> Triage step), so default to the
  // earliest enabled project rather than blocking submission outright.
  const fallbackProject = project ?? (await pool.query("SELECT id FROM projects WHERE enabled = true ORDER BY created_at LIMIT 1")).rows[0];
  if (!fallbackProject) return json(response, 400, { error: "no enabled project available" });
  const projectId = fallbackProject.id;
  const ticket = await inTransaction(async (client) => {
    await client.query("INSERT INTO public_submission_attempts (form_id, ip_address, accepted) VALUES ($1,$2,true)", [form.id, ip]);
    const number = (await client.query("SELECT nextval('ticket_number_sequence') AS number")).rows[0].number;
    const ticketNumber = `DCC-${number}`;
    const reservedKeys = [
      "project_id", "title", "description", "category", "priority", "submitter_name", "submitter_email",
      "source_url", "environment", "expected_behavior", "actual_behavior", "reproduction_steps", honeypot,
    ];
    const excludedKeys = new Set([...reservedKeys, ...fields.filter((f) => f.field_type === "static" || f.field_type === "hidden").map((f) => f.field_key)]);
    const customValues = Object.fromEntries(Object.entries(body).filter(([key]) => !excludedKeys.has(key)));
    const result = await client.query(
      `INSERT INTO tickets
       (ticket_number,form_id,project_id,title,description,category,priority,status,submitter_name,submitter_email,
        source_url,environment,expected_behavior,actual_behavior,reproduction_steps,custom_values_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'Submitted',$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [ticketNumber, form.id, projectId, body.title, body.description, body.category ?? null, body.priority ?? "normal",
        body.submitter_name ?? null, body.submitter_email ?? null, body.source_url ?? null, body.environment ?? null,
        body.expected_behavior ?? null, body.actual_behavior ?? null, body.reproduction_steps ?? null, customValues],
    );
    await client.query(
      `INSERT INTO ticket_status_history (ticket_id,previous_status,new_status,reason,actor_type)
       VALUES ($1,NULL,'Submitted','Public form submitted','public')`,
      [result.rows[0].id],
    );
    const uploadIds = Object.values(body)
      .flatMap((value) => (Array.isArray(value) ? value : [value]))
      .filter((value) => typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value));
    if (uploadIds.length) {
      await client.query(
        `UPDATE attachments SET ticket_id = $1 WHERE ticket_id IS NULL AND upload_id = ANY($2::uuid[])`,
        [result.rows[0].id, uploadIds],
      );
    }
    await audit({ actorType: "public", action: "ticket.create", entityType: "ticket", entityId: result.rows[0].id, after: result.rows[0], ip }, client);
    if (form.settings_json?.notify_on_submission !== false) await enqueueNotification(client, "ticket.created", result.rows[0].id, result.rows[0].id);
    return result.rows[0];
  });
  json(response, 201, { ticket_number: ticket.ticket_number, ticket: { id: ticket.id, ticket_number: ticket.ticket_number } });
}

function sniffImage(buffer: Buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { mediaType: "image/png", extension: ".png" };
  if (buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return { mediaType: "image/jpeg", extension: ".jpg" };
  return null;
}

async function upload(request: IncomingMessage, response: ServerResponse) {
  const contentType = request.headers["content-type"] ?? "";
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)?.slice(1).find(Boolean);
  if (!boundary) return json(response, 400, { error: "multipart form data required" });
  const raw = await bodyBuffer(request, maxUploadBytes + 64 * 1024);
  const separator = Buffer.from(`\r\n--${boundary}`);
  const headerEnd = raw.indexOf(Buffer.from("\r\n\r\n"));
  if (headerEnd < 0) return json(response, 400, { error: "invalid upload" });
  const end = raw.indexOf(separator, headerEnd + 4);
  if (end < 0) return json(response, 400, { error: "invalid upload" });
  const bytes = raw.subarray(headerEnd + 4, end);
  if (!bytes.length || bytes.length > maxUploadBytes) return json(response, 413, { error: "upload too large" });
  const sniffed = sniffImage(bytes);
  if (!sniffed) return json(response, 415, { error: "only PNG and JPEG images are accepted" });
  const artifactId = randomUUID();
  const staged = await stageArtifact({
    root: dataRoot, id: artifactId, storagePath: `uploads/${artifactId}${sniffed.extension}`, content: bytes,
  });
  let registered = false;
  try {
    const originalName = /filename="([^"]*)"/i.exec(raw.subarray(0, headerEnd).toString("utf8"))?.[1] ?? null;
    const row = await inTransaction(async (client) => {
      const upload = (await client.query(
        `INSERT INTO uploads (storage_path,original_name,media_type,size_bytes) VALUES ($1,$2,$3,$4) RETURNING *`,
        [staged.storagePath, originalName ? originalName.slice(0, 255) : null, sniffed.mediaType, bytes.length],
      )).rows[0];
      await client.query(
        `INSERT INTO artifacts (id,storage_path,artifact_type,status,expires_at,upload_id)
         VALUES ($1,$2,'upload','staged',now() + interval '1 hour',$3)`,
        [artifactId, staged.relativePath, upload.id],
      );
      await client.query("INSERT INTO attachments (upload_id) VALUES ($1)", [upload.id]);
      return upload;
    });
    registered = true;
    await inTransaction(async (client) => {
        if (!(await client.query("SELECT id FROM artifacts WHERE id=$1 AND status='staged' FOR UPDATE", [artifactId])).rowCount) throw new Error("artifact is no longer staged");
        const finalized = await finalizeArtifact(staged);
        if (!(await client.query(
          `UPDATE artifacts SET status='finalized',sha256=$2,finalized_at=now(),expires_at=NULL
           WHERE id=$1 AND status='staged'`,
          [artifactId, finalized.sha256],
        )).rowCount) throw new Error("artifact is no longer staged");
    });
    json(response, 201, { upload_id: row.id, reference: `/uploads/${row.id}` });
  } catch (error) {
    if (!registered) await rm(staged.stagedPath, { force: true });
    throw error;
  }
}

export function normalizeFields(fields: any[]) {
  if (!Array.isArray(fields)) return null;
  return fields.map((field, index) => {
    if (!field || typeof field.field_key !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(field.field_key)) throw Object.assign(new Error("invalid field key"), { status: 400 });
    if (!fieldTypes.has(field.field_type)) throw Object.assign(new Error("invalid field type"), { status: 400 });
    if (optionTypes.has(field.field_type) && !(Array.isArray(field.options_json) && field.options_json.length && field.options_json.every((o: any) => typeof o === "string"))) {
      throw Object.assign(new Error("option fields require options"), { status: 400 });
    }
    return {
      field_key: field.field_key, field_type: field.field_type, label: String(field.label ?? field.field_key).slice(0, 200),
      description: field.description ?? null, placeholder: field.placeholder ?? null, required: Boolean(field.required),
      position: Number.isInteger(field.position) ? field.position : index * 10,
      validation_json: field.validation_json ?? {}, options_json: field.options_json ?? [],
    };
  });
}

async function replaceFields(client: any, formId: string, fields: any[]) {
  await client.query("DELETE FROM form_fields WHERE form_id = $1", [formId]);
  for (const field of fields) {
    await client.query(
      `INSERT INTO form_fields
       (form_id,field_key,field_type,label,description,placeholder,required,position,validation_json,options_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [formId, field.field_key, field.field_type, field.label, field.description, field.placeholder,
        field.required, field.position, JSON.stringify(field.validation_json ?? {}), JSON.stringify(field.options_json ?? [])],
    );
  }
}

async function transitionTicket(ticketRef: string, status: string, reason: string, session: any, request: IncomingMessage, response: ServerResponse) {
  const result = await inTransaction(async (client) => {
    const before = (await client.query("SELECT *,updated_at::text ticket_version FROM tickets WHERE id::text = $1 OR ticket_number = $1 FOR UPDATE", [ticketRef])).rows[0];
    if (!before) return null;
    let after;
    if (status === "Rejected") {
      if (!["Submitted", "Triage", "Needs Information"].includes(before.status)) {
        throw new ApprovalConflictError(before.approved_input_snapshot_id ?? null);
      }
      const currentPlan = (await client.query(
        "SELECT current_version_id FROM plans WHERE ticket_id=$1 AND current_version_id IS NOT NULL",
        [before.id],
      )).rows[0];
      after = currentPlan ? (await rejectPlanDecision(client, {
        ticketId: before.id, planVersionId: currentPlan.current_version_id, expectedTicketVersion: before.ticket_version, expectedStatus: before.status,
        expectedSnapshotId: before.approved_input_snapshot_id ?? null, decidedBy: session.user_id, metadata: { reason },
      })).ticket : (await client.query(
        `UPDATE tickets SET status=$2,approved_plan_version_id=NULL,approved_plan_hash=NULL,
           approved_ticket_version=NULL,approved_project_config_version=NULL,approved_model_config_json=NULL,
           approved_skill_snapshot_id=NULL,approved_prompt_versions_json=NULL,approved_input_snapshot_id=NULL,
           plan_approved_at=NULL,updated_at=now() WHERE id=$1 RETURNING *`,
        [before.id, status],
      )).rows[0];
    } else {
      after = (await client.query("UPDATE tickets SET status = $2, updated_at = now() WHERE id = $1 RETURNING *", [before.id, status])).rows[0];
    }
    await client.query(
      `INSERT INTO ticket_status_history (ticket_id,previous_status,new_status,reason,actor_type,actor_id)
       VALUES ($1,$2,$3,$4,'admin',$5)`,
      [before.id, before.status, status, reason, session.user_id],
    );
    await audit({ actorType: "admin", actorId: session.user_id, action: "ticket.status_change", entityType: "ticket", entityId: before.id, before, after, metadata: { reason }, ip: ipOf(request) }, client);
    return after;
  });
  return result ? json(response, 200, { ticket: result }) : json(response, 404, { error: "ticket not found" });
}

async function counts() {
  const row = (await pool.query(`SELECT
    (SELECT count(*)::integer FROM tickets WHERE status IN ('Submitted','Triage','Needs Information')) tickets,
    (SELECT count(*)::integer FROM agent_runs WHERE status IN ('running','queued')) runs,
    (SELECT count(*)::integer FROM jobs WHERE status IN ('queued','running')) jobs,
    (SELECT count(*)::integer FROM pull_requests WHERE state = 'open') prs,
    (SELECT count(*)::integer FROM projects WHERE enabled = true) projects,
    (SELECT count(*)::integer FROM forms) forms,
    (SELECT count(*)::integer FROM skills) skills,
    (SELECT count(*)::integer FROM notification_deliveries WHERE status = 'failed') notifications`)).rows[0];
  return row;
}

async function adminHtml(request: IncomingMessage, response: ServerResponse, url: URL) {
  const session = await sessionFor(request);
  if (!session) {
    response.writeHead(302, { location: "/login" });
    return response.end();
  }
  const metrics = await counts();
  const pageModules = [
    dashboardPage, ticketsPage, runsPage, prsPage, projectsPage, formsPage, promptsPage, skillsPage, notificationsPage, queuePage, auditPage, operatePage,
  ];
  for (const pageModule of pageModules) {
    const result = await pageModule.render(url, session, metrics);
    if (result) return html(response, result.status, adminPage(url.pathname, result.title, result.body, metrics, session.username));
  }
  return html(response, 404, adminPage(url.pathname, "Page not found", "<h1>Page not found</h1><p>Page not found.</p>", metrics, session.username));
}

export async function adminApi(request: IncomingMessage, response: ServerResponse, url: URL, session: any) {
  if (request.method === "GET" && url.pathname === "/api/admin/session") return json(response, 200, { user: { id: session.user_id, username: session.username, role: session.role } });
  if (request.method === "POST" && url.pathname === "/api/admin/logout") {
    await pool.query("UPDATE admin_sessions SET invalidated_at = now() WHERE id = $1", [session.id]);
    await audit({ actorType: "admin", actorId: session.user_id, action: "logout", entityType: "user", entityId: session.user_id, ip: ipOf(request) });
    return json(response, 200, { ok: true }, { "set-cookie": [
      ["dcc_session=", "HttpOnly", ...secureCookieAttributes(production), "Max-Age=0"].join("; "),
      ["dcc_csrf=", ...secureCookieAttributes(production), "Max-Age=0"].join("; "),
    ] });
  }
  if (url.pathname === "/api/admin/pull-requests" && request.method === "GET") {
    const params: any[] = [];
    const where: string[] = [];
    const equal = (value: string | null, column: string) => {
      if (value) { params.push(value); where.push(`${column}=$${params.length}`); }
    };
    const project = url.searchParams.get("project") ?? url.searchParams.get("project_id");
    if (project) {
      params.push(project);
      where.push(`(pr.project_id::text=$${params.length} OR p.slug=$${params.length})`);
    }
    equal(url.searchParams.get("repository"), "pr.repository");
    const truthy = (key: string) => ["1", "true", "yes"].includes((url.searchParams.get(key) ?? "").toLowerCase());
    if (url.searchParams.get("linked") === "false" || url.searchParams.get("ticket") === "unlinked") where.push("pr.ticket_id IS NULL");
    if (truthy("linked") || url.searchParams.get("ticket") === "linked") where.push("pr.ticket_id IS NOT NULL");
    if (truthy("created_by_platform") || truthy("platform_created")) where.push("pr.execution_attempt_id IS NOT NULL");
    if (truthy("draft")) where.push("pr.is_draft=true");
    if (truthy("open")) where.push("pr.state='open'");
    if (truthy("merged")) where.push("pr.merged_at IS NOT NULL");
    if (truthy("closed")) where.push("pr.state='closed' AND pr.merged_at IS NULL");
    if (truthy("review_required")) where.push("COALESCE(pr.review_state,'') NOT IN ('approved','changes_requested')");
    if (truthy("checks_failing")) where.push("pr.check_state IN ('failed','failure','failing')");
    if (truthy("checks_pending")) where.push("pr.check_state IN ('pending','queued','in_progress')");
    if (truthy("changes_requested")) where.push("pr.review_state='changes_requested'");
    if (truthy("approved")) where.push("pr.review_state='approved'");
    const from = url.searchParams.get("date_from") ?? url.searchParams.get("from");
    const to = url.searchParams.get("date_to") ?? url.searchParams.get("to");
    if (from) { params.push(from); where.push(`pr.created_at_provider >= $${params.length}::timestamptz`); }
    if (to) { params.push(to); where.push(`pr.created_at_provider <= $${params.length}::timestamptz`); }
    const search = url.searchParams.get("search") ?? url.searchParams.get("q");
    if (search) {
      params.push(`%${search}%`);
      where.push(`(pr.title ILIKE $${params.length} OR t.ticket_number ILIKE $${params.length})`);
    }
    const pullRequests = (await pool.query(
      `SELECT pr.*,p.name project_name,p.slug project_slug,
              t.ticket_number,t.title ticket_title,t.status ticket_status,
              (ar.metadata_json->'validation_output'->'changed_files') changed_file_summary
       FROM pull_requests pr
       JOIN projects p ON p.id=pr.project_id
       LEFT JOIN tickets t ON t.id=pr.ticket_id
       LEFT JOIN execution_attempts ea ON ea.id=pr.execution_attempt_id
       LEFT JOIN agent_runs ar ON ar.id=ea.agent_run_id
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY COALESCE(pr.updated_at_provider,pr.updated_at) DESC LIMIT 200`,
      params,
    )).rows;
    return json(response, 200, { pull_requests: pullRequests });
  }
  const pullRequestDetailMatch = url.pathname.match(/^\/api\/admin\/pull-requests\/([0-9a-f-]+)$/i);
  if (pullRequestDetailMatch && request.method === "GET") {
    const pullRequest = (await pool.query(
      `SELECT pr.*,p.name project_name,p.slug project_slug,
              t.ticket_number,t.title ticket_title,t.status ticket_status,
              pv.content_markdown approved_plan,
              ar.id run_id,ar.metadata_json run_metadata,ea.validation_status,ea.result_commit
       FROM pull_requests pr
       JOIN projects p ON p.id=pr.project_id
       LEFT JOIN tickets t ON t.id=pr.ticket_id
       LEFT JOIN plan_versions pv ON pv.id=t.approved_plan_version_id
       LEFT JOIN execution_attempts ea ON ea.id=pr.execution_attempt_id
       LEFT JOIN agent_runs ar ON ar.id=ea.agent_run_id
       WHERE pr.id=$1`,
      [pullRequestDetailMatch[1]],
    )).rows[0];
    if (!pullRequest) return json(response, 404, { error: "pull request not found" });
    const validation = pullRequest.run_metadata?.validation_output ?? {};
    const notifications = (await pool.query(
      `SELECT nd.*,np.name provider
       FROM notification_deliveries nd LEFT JOIN notification_providers np ON np.id=nd.provider_id
       WHERE nd.pull_request_id=$1 OR (nd.pull_request_id IS NULL AND nd.ticket_id=$2)
       ORDER BY nd.created_at DESC`,
      [pullRequest.id, pullRequest.ticket_id],
    )).rows;
    const aiReviews = (await pool.query(
      "SELECT * FROM pr_ai_reviews WHERE pull_request_id=$1 ORDER BY created_at DESC",
      [pullRequest.id],
    )).rows;
    const conflictResolutions = (await pool.query(
      "SELECT * FROM pr_conflict_resolutions WHERE pull_request_id=$1 ORDER BY created_at DESC",
      [pullRequest.id],
    )).rows;
    return json(response, 200, {
      pull_request: pullRequest,
      implementation_summary: pullRequest.run_metadata?.implementation_summary ?? null,
      validation_output: validation,
      commits: pullRequest.result_commit ? [{ sha: pullRequest.result_commit }] : [],
      changed_files: validation.changed_files ?? [],
      review_comments: [],
      notification_history: notifications,
      ai_reviews: aiReviews,
      conflict_resolutions: conflictResolutions,
    });
  }
  if (url.pathname === "/api/admin/notifications/providers" && request.method === "GET") {
    const providers = (await pool.query("SELECT * FROM notification_providers ORDER BY name")).rows;
    return json(response, 200, { providers: providers.map(safeNotificationProvider) });
  }
  if (url.pathname === "/api/admin/notifications/providers" && request.method === "POST") {
    const body = await bodyOf(request);
    if (!body.name || !body.type) return json(response, 400, { error: "name and type are required" });
    const configuration = parseNotificationConfiguration(body.configuration);
    if (!configuration) return json(response, 400, { error: "invalid notification configuration" });
    const result = await pool.query(
      `INSERT INTO notification_providers (name,type,enabled,configuration_encrypted_json) VALUES ($1,$2,$3,$4) RETURNING *`,
      [body.name, body.type, body.enabled ?? true, configuration],
    );
    await audit({ actorType: "admin", actorId: session.user_id, action: "notification_provider.create", entityType: "notification_provider", entityId: result.rows[0].id, after: safeNotificationProvider(result.rows[0]), ip: ipOf(request) });
    return json(response, 201, { provider: safeNotificationProvider(result.rows[0]) });
  }
  const providerMatch = url.pathname.match(/^\/api\/admin\/notifications\/providers\/([0-9a-f-]+)$/i);
  if (providerMatch && request.method === "PATCH") {
    const before = (await pool.query("SELECT * FROM notification_providers WHERE id=$1", [providerMatch[1]])).rows[0];
    if (!before) return json(response, 404, { error: "notification provider not found" });
    const body = await bodyOf(request);
    const configurationPatch = body.configuration === undefined ? {} : parseNotificationConfigurationPatch(body.configuration);
    if (!configurationPatch) return json(response, 400, { error: "invalid notification configuration" });
    const configuration = mergeNotificationConfiguration(before.configuration_encrypted_json, configurationPatch);
    const after = (await pool.query(
      `UPDATE notification_providers SET name=COALESCE($2,name),enabled=COALESCE($3,enabled),configuration_encrypted_json=$4,updated_at=now() WHERE id=$1 RETURNING *`,
      [before.id, body.name ?? null, body.enabled ?? null, configuration],
    )).rows[0];
    await audit({ actorType: "admin", actorId: session.user_id, action: "notification_provider.update", entityType: "notification_provider", entityId: after.id, before: safeNotificationProvider(before), after: safeNotificationProvider(after), ip: ipOf(request) });
    return json(response, 200, { provider: safeNotificationProvider(after) });
  }
  const providerTestMatch = url.pathname.match(/^\/api\/admin\/notifications\/providers\/([0-9a-f-]+)\/test$/i);
  if (providerTestMatch && request.method === "POST") {
    const provider = (await pool.query("SELECT * FROM notification_providers WHERE id=$1", [providerTestMatch[1]])).rows[0];
    if (!provider) return json(response, 404, { error: "notification provider not found" });
    const delivery = (await pool.query(
      `INSERT INTO notification_deliveries (provider_id,event_type,payload_json,status,attempt_count,next_attempt_at)
       VALUES ($1,'provider.test',$2,'queued',0,now()) RETURNING *`,
      [provider.id, { event: "provider.test", occurredAt: new Date().toISOString(), provider: provider.name }],
    )).rows[0];
    await audit({ actorType: "admin", actorId: session.user_id, action: "notification_provider.test", entityType: "notification_provider", entityId: provider.id, after: delivery, ip: ipOf(request) });
    return json(response, 202, { delivery });
  }
  const notificationRetryMatch = url.pathname.match(/^\/api\/admin\/notifications\/deliveries\/([0-9a-f-]+)\/retry$/i);
  if (notificationRetryMatch && request.method === "POST") {
    const delivery = (await pool.query(
      `UPDATE notification_deliveries SET status='queued',next_attempt_at=now(),error_message=NULL,response_status=NULL,updated_at=now() WHERE id=$1 RETURNING *`,
      [notificationRetryMatch[1]],
    )).rows[0];
    if (!delivery) return json(response, 404, { error: "notification delivery not found" });
    await audit({ actorType: "admin", actorId: session.user_id, action: "notification_delivery.retry", entityType: "notification_delivery", entityId: delivery.id, after: delivery, ip: ipOf(request) });
    return json(response, 202, { delivery });
  }
  if (url.pathname === "/api/admin/pull-requests/sync" && request.method === "POST") {
    const job = await enqueueJob({ type: "github.sync_open", payload: { actor_id: session.user_id }, idempotencyKey: `g07:github.sync_open:all:${randomUUID()}` });
    return json(response, 202, { job });
  }
  if (url.pathname === "/api/admin/settings/ai-review" && request.method === "POST") {
    const body = await bodyOf(request);
    const selection = validateAiSelection({
      model: typeof body.default_model === "string" ? body.default_model : "",
      reasoning_level: typeof body.default_reasoning_level === "string" ? body.default_reasoning_level : "",
    });
    await pool.query(
      `UPDATE ai_review_settings SET default_model=$1,default_reasoning_level=$2,updated_at=now(),updated_by=$3 WHERE id=1`,
      [selection.model, selection.reasoning_level, session.user_id],
    );
    return json(response, 200, { ok: true });
  }
  const followUpDescriptionMatch = url.pathname.match(/^\/api\/admin\/pull-requests\/([0-9a-f-]+)\/follow-up-description$/i);
  if (followUpDescriptionMatch && request.method === "POST") {
    const body = await bodyOf(request);
    const submittedFeedback = typeof body.feedback === "string" ? body.feedback : "";
    const feedback = submittedFeedback.trim();
    if (!feedback || submittedFeedback.length > 10_000) return json(response, 400, { error: "feedback is required" });
    const pullRequest = (await pool.query("SELECT id,project_id FROM pull_requests WHERE id=$1", [followUpDescriptionMatch[1]])).rows[0];
    if (!pullRequest) return json(response, 404, { error: "pull request not found" });
    const ticketId = typeof body.ticket_id === "string" ? body.ticket_id : "";
    const initialDescription = typeof body.initial_description === "string" ? body.initial_description : "";
    if (ticketId && !(await pool.query("SELECT 1 FROM tickets WHERE id::text=$1 AND project_id=$2", [ticketId, pullRequest.project_id])).rowCount) {
      return json(response, 400, { error: "ticket must belong to the pull request project" });
    }
    const job = await enqueueJob({
      type: "pr.follow_up_description",
      payload: { pull_request_id: pullRequest.id, feedback, ticket_id: ticketId || undefined, initial_description: initialDescription || undefined },
      priority: "low",
      idempotencyKey: `pr-follow-up-description:${pullRequest.id}:${randomUUID()}`,
    });
    return json(response, 202, { job });
  }
  const followUpDescriptionStatusMatch = url.pathname.match(/^\/api\/admin\/pull-requests\/follow-up-descriptions\/([0-9a-f-]+)$/i);
  if (followUpDescriptionStatusMatch && request.method === "GET") {
    const job = (await pool.query(
      "SELECT status,payload_json,error_json FROM jobs WHERE id=$1 AND type=$2",
      [followUpDescriptionStatusMatch[1], "pr.follow_up_description"],
    )).rows[0];
    if (!job) return json(response, 404, { error: "follow-up description job not found" });
    const generatedDescription = job.payload_json?.generated_description;
    const error = job.error_json?.message;
    return json(response, 200, {
      status: job.status,
      ...(typeof generatedDescription === "string" ? { generated_description: generatedDescription } : {}),
      ...(typeof error === "string" ? { error } : {}),
    });
  }
  const pullRequestActionMatch = url.pathname.match(
    /^\/api\/admin\/pull-requests\/([0-9a-f-]+)\/(mark-reviewed|approve|request-changes|repair-instructions|start-repair|refresh|close-ticket|ai-review|resolve-conflicts)$/i,
  );
  if (pullRequestActionMatch && request.method === "POST") {
    const [, pullRequestId, action] = pullRequestActionMatch;
    const body = await bodyOf(request);
    const pullRequest = (await pool.query(
      `SELECT pr.*,ea.agent_run_id,ar.metadata_json
       FROM pull_requests pr
       LEFT JOIN execution_attempts ea ON ea.id=pr.execution_attempt_id
       LEFT JOIN agent_runs ar ON ar.id=ea.agent_run_id WHERE pr.id=$1`,
      [pullRequestId],
    )).rows[0];
    if (!pullRequest) return json(response, 404, { error: "pull request not found" });
    if (action === "refresh") {
      const job = await enqueueJob({ type: "github.sync_one", payload: { actor_id: session.user_id, pull_request_id: pullRequest.id }, idempotencyKey: `g07:github.sync_one:${pullRequest.id}:${randomUUID()}` });
      return json(response, 202, { job });
    } else if (action === "mark-reviewed") {
      await pool.query("UPDATE pull_requests SET internal_review_state='reviewed',updated_at=now() WHERE id=$1", [pullRequest.id]);
    } else if (action === "approve") {
      const expectedHeadSha = typeof body.expected_head_sha === "string" ? body.expected_head_sha.trim() : "";
      const policySnapshotId = typeof body.policy_snapshot_id === "string" ? body.policy_snapshot_id.trim() : "";
      if (!expectedHeadSha || !policySnapshotId || pullRequest.policy_stale
        || expectedHeadSha !== pullRequest.head_sha || policySnapshotId !== pullRequest.current_policy_snapshot_id) {
        return json(response, 409, { error: "pull request policy binding is missing or stale" });
      }
      const job = await enqueueJob({
        type: "github.merge_pull_request",
        payload: {
          actor_id: session.user_id, pull_request_id: pullRequest.id,
          expected_head_sha: expectedHeadSha, policy_snapshot_id: policySnapshotId,
        },
        idempotencyKey: `g07:github.merge_pull_request:${pullRequest.id}:${randomUUID()}`,
      });
      return json(response, 202, { job });
    } else if (action === "request-changes") {
      await pool.query("UPDATE pull_requests SET internal_review_state='changes_requested',updated_at=now() WHERE id=$1", [pullRequest.id]);
      await setPullRequestTicketStatus(pullRequest.id, "PR Changes Requested", "Internal changes requested", "admin", session.user_id);
    } else if (action === "repair-instructions") {
      if (typeof body.instructions !== "string" || !body.instructions.trim() || body.instructions.length > 10000) {
        return json(response, 400, { error: "instructions are required" });
      }
      await pool.query("UPDATE pull_requests SET internal_notes=$2,updated_at=now() WHERE id=$1", [pullRequest.id, body.instructions.trim()]);
    } else if (action === "start-repair") {
      const feedback = typeof body.feedback === "string" && body.feedback.trim()
        ? body.feedback.trim() : pullRequest.internal_notes?.trim();
      if (!feedback) return json(response, 400, { error: "repair instructions are required" });
      if (!pullRequest.agent_run_id) return json(response, 409, { error: "linked execution run is unavailable" });
      const result = await inTransaction(async (client) => {
        const source = (await client.query(
          `SELECT ar.*,ea.id execution_attempt_id,ea.plan_version_id,ea.worktree_path,ea.worktree_lifecycle_status,t.status ticket_status
           FROM agent_runs ar JOIN execution_attempts ea ON ea.agent_run_id=ar.id
           JOIN tickets t ON t.id=ea.ticket_id WHERE ar.id=$1 FOR UPDATE OF ea,t`,
          [pullRequest.agent_run_id],
        )).rows[0];
        if (!source) throw Object.assign(new Error("linked execution attempt is unavailable"), { status: 409 });
        if (source.worktree_lifecycle_status === "reclaimed") throw Object.assign(new Error("repair source worktree has been reclaimed"), { status: 409 });
        const approvedSnapshotId = source.metadata_json?.approved_input_snapshot_id;
        if (typeof approvedSnapshotId !== "string") throw Object.assign(new Error("repair run has no approved input snapshot"), { status: 409 });
        const active = (await client.query(
          `SELECT 1 FROM jobs WHERE status IN ('queued','running') AND type='execution.repair'
          AND payload_json->>'source_execution_attempt_id'=$1`,
          [source.execution_attempt_id],
        )).rowCount;
        if (active) throw Object.assign(new Error("a repair is already active"), { status: 409 });
        const rerunOf = await terminalRerunSource(client, source.metadata_json);
        const attemptNumber = (await client.query(
          "SELECT COALESCE(max(attempt_number),0)+1 next FROM execution_attempts WHERE ticket_id=$1",
          [source.ticket_id],
        )).rows[0].next;
        const attempt = (await client.query(
          `INSERT INTO execution_attempts (ticket_id,plan_version_id,attempt_number,validation_status,source_execution_attempt_id)
           VALUES ($1,$2,$3,'queued',$4) RETURNING *`,
          [source.ticket_id, source.plan_version_id, attemptNumber, source.execution_attempt_id],
        )).rows[0];
        const job = await enqueueJob({
          type: "execution.repair",
          payload: {
            ticket_id: source.ticket_id, execution_attempt_id: attempt.id,
            source_execution_attempt_id: source.execution_attempt_id,
            plan_version_id: source.plan_version_id,
            approved_input_snapshot_id: approvedSnapshotId,
            feedback,
            validation_output: source.metadata_json?.validation_output ?? {},
          },
          idempotencyKey: `execution.repair:${attempt.id}`,
          maxAttempts: 1,
          rerunOf,
        }, client);
        await client.query("UPDATE tickets SET status='Execution Queued',updated_at=now() WHERE id=$1", [source.ticket_id]);
        await client.query(
          `INSERT INTO ticket_status_history
           (ticket_id,previous_status,new_status,reason,actor_type,actor_id,related_job_id,related_run_id,related_plan_version_id,related_pull_request_id)
           VALUES ($1,$2,'Execution Queued','Repair execution queued','admin',$3,$4,$5,$6,$7)`,
          [source.ticket_id, source.ticket_status, session.user_id, job.id, source.id, source.plan_version_id, pullRequest.id],
        );
        return job;
      });
      return json(response, 202, { job: result });
    } else if (action === "close-ticket") {
      const target: "Completed" | "Closed Without Merge" = pullRequest.merged_at ? "Completed" : "Closed Without Merge";
      await setPullRequestTicketStatus(pullRequest.id, target, "Ticket closed manually after external pull-request completion", "admin", session.user_id);
    } else if (action === "ai-review") {
      const mode = body.mode === "review_and_merge" ? "review_and_merge" : "review_only";
      const targetBranch = typeof body.target_branch === "string" && body.target_branch.trim() ? body.target_branch.trim() : undefined;
      const settings = (await pool.query("SELECT * FROM ai_review_settings WHERE id=1")).rows[0];
      const selection = validateAiSelection({
        model: typeof body.model === "string" ? body.model : settings.default_model,
        reasoning_level: typeof body.reasoning_level === "string" ? body.reasoning_level : settings.default_reasoning_level,
      });
      const reviewRow = await inTransaction(async (client) => {
        await client.query("SELECT id FROM pull_requests WHERE id=$1 FOR UPDATE", [pullRequest.id]);
        const previous = (await client.query(
          `SELECT r.id,j.id job_id,j.status job_status
           FROM pr_ai_reviews r
           LEFT JOIN LATERAL (
             SELECT id,status FROM jobs
             WHERE type='pr.ai_review' AND payload_json->>'pr_ai_review_id'=r.id::text
             ORDER BY created_at DESC LIMIT 1
           ) j ON true
           WHERE r.pull_request_id=$1
           ORDER BY CASE WHEN j.status IN ('queued','running') THEN 0 ELSE 1 END,r.created_at DESC LIMIT 1
           FOR UPDATE OF r`,
          [pullRequest.id],
        )).rows[0];
        if (previous && ["queued", "running"].includes(previous.job_status)) return previous;
        const row = (
          await client.query(
            `INSERT INTO pr_ai_reviews (pull_request_id, mode, status, model, reasoning_level, created_by)
             VALUES ($1,$2,'running',$3,$4,$5) RETURNING id`,
            [pullRequest.id, mode, selection.model, selection.reasoning_level, session.user_id],
          )
        ).rows[0];
        await enqueueJob({
          type: "pr.ai_review",
          payload: {
            pr_ai_review_id: row.id,
            pull_request_id: pullRequest.id,
            mode,
            model: selection.model,
            reasoning_level: selection.reasoning_level,
            target_branch: targetBranch,
          },
          idempotencyKey: `pr-ai-review:${row.id}`,
          maxAttempts: 3,
          rerunOf: previous?.job_id,
        }, client);
        return row;
      });
      return json(response, 200, { id: reviewRow.id });
    } else if (action === "resolve-conflicts") {
      const settings = (await pool.query("SELECT * FROM ai_review_settings WHERE id=1")).rows[0];
      const selection = validateAiSelection({
        model: typeof body.model === "string" ? body.model : settings.default_model,
        reasoning_level: typeof body.reasoning_level === "string" ? body.reasoning_level : settings.default_reasoning_level,
      });
      const resolutionRow = await inTransaction(async (client) => {
        await client.query("SELECT id FROM pull_requests WHERE id=$1 FOR UPDATE", [pullRequest.id]);
        const previous = (await client.query(
          `SELECT r.id,j.id job_id,j.status job_status
           FROM pr_conflict_resolutions r
           LEFT JOIN LATERAL (
             SELECT id,status FROM jobs
             WHERE type='pr.conflict_resolution' AND payload_json->>'pr_conflict_resolution_id'=r.id::text
             ORDER BY created_at DESC LIMIT 1
           ) j ON true
           WHERE r.pull_request_id=$1
           ORDER BY CASE WHEN j.status IN ('queued','running') THEN 0 ELSE 1 END,r.created_at DESC LIMIT 1
           FOR UPDATE OF r`,
          [pullRequest.id],
        )).rows[0];
        if (previous && ["queued", "running"].includes(previous.job_status)) return previous;
        const row = (
          await client.query(
            `INSERT INTO pr_conflict_resolutions (pull_request_id, status, model, reasoning_level, created_by)
             VALUES ($1,'running',$2,$3,$4) RETURNING id`,
            [pullRequest.id, selection.model, selection.reasoning_level, session.user_id],
          )
        ).rows[0];
        await enqueueJob({
          type: "pr.conflict_resolution",
          payload: {
            pr_conflict_resolution_id: row.id,
            pull_request_id: pullRequest.id,
            model: selection.model,
            reasoning_level: selection.reasoning_level,
          },
          idempotencyKey: `pr-conflict-resolution:${row.id}`,
          maxAttempts: 1,
          rerunOf: previous?.job_id,
        }, client);
        return row;
      });
      return json(response, 200, { id: resolutionRow.id });
    }
    const updated = (await pool.query("SELECT * FROM pull_requests WHERE id=$1", [pullRequest.id])).rows[0];
    return json(response, 200, { pull_request: updated });
  }
  const mergeBranchesMatch = url.pathname.match(/^\/api\/admin\/projects\/([0-9a-f-]+)\/merge-branches$/i);
  if (mergeBranchesMatch && request.method === "POST") {
    const project = (await pool.query("SELECT * FROM projects WHERE id=$1", [mergeBranchesMatch[1]])).rows[0];
    if (!project) return json(response, 404, { error: "project not found" });
    if (!project.github_owner || !project.github_repository) return json(response, 400, { error: "project has no GitHub repository configured" });
    const body = await bodyOf(request);
    const head = typeof body.head === "string" ? body.head.trim() : "";
    const base = typeof body.base === "string" ? body.base.trim() : "";
    if (!head || !base) return json(response, 400, { error: "head and base branch are required" });
    const job = await enqueueJob({ type: "github.merge_branches", payload: { actor_id: session.user_id, project_id: project.id, head, base }, idempotencyKey: `g07:github.merge_branches:${project.id}:${randomUUID()}` });
    return json(response, 202, { job });
  }
  if (url.pathname === "/api/admin/projects/import-github-prs" && request.method === "POST") {
    const job = await enqueueJob({ type: "github.import", payload: { actor_id: session.user_id }, idempotencyKey: `g07:github.import:all:${randomUUID()}` });
    return json(response, 202, { job });
  }
  const importGithubPrsMatch = url.pathname.match(/^\/api\/admin\/projects\/([0-9a-f-]+)\/import-github-prs$/i);
  if (importGithubPrsMatch && request.method === "POST") {
    const project = (await pool.query("SELECT * FROM projects WHERE id=$1", [importGithubPrsMatch[1]])).rows[0];
    if (!project) return json(response, 404, { error: "project not found" });
    if (!project.github_owner || !project.github_repository) return json(response, 400, { error: "project has no GitHub repository configured" });
    const job = await enqueueJob({ type: "github.import", payload: { actor_id: session.user_id, project_id: project.id }, idempotencyKey: `g07:github.import:${project.id}:${randomUUID()}` });
    return json(response, 202, { job });
  }
  if (url.pathname === "/api/admin/prompts" && request.method === "GET") {
    const projectId = url.searchParams.get("project_id");
    const params = projectId ? [projectId] : [];
    const prompts = (await pool.query(
      `SELECT pf.*,p.name project_name,pv.version active_version,pv.content active_content,pv.content_hash
       FROM prompt_files pf LEFT JOIN projects p ON p.id=pf.project_id
       LEFT JOIN prompt_versions pv ON pv.id=pf.active_version_id
       ${projectId ? "WHERE pf.project_id=$1 OR pf.scope='global'" : ""}
       ORDER BY pf.scope,p.name,pf.prompt_type`,
      params,
    )).rows;
    return json(response, 200, { prompts });
  }
  if (url.pathname === "/api/admin/prompts/validate" && request.method === "POST") {
    const body = await bodyOf(request);
    return json(response, 200, validatePromptTemplate(body.content));
  }
  if (url.pathname === "/api/admin/prompts" && request.method === "POST") {
    const body = await bodyOf(request);
    const scope = body.scope === "project" ? "project" : body.scope === "global" ? "global" : null;
    const validTypes: readonly string[] = globalPromptTypes;
    if (!scope || !validTypes.includes(body.prompt_type)) return json(response, 400, { error: "invalid prompt scope or type" });
    if ((scope === "project") !== Boolean(body.project_id)) return json(response, 400, { error: "project prompts require project_id" });
    validatePromptTemplate(body.content ?? "");
    const prompt = await inTransaction(async (client) => {
      const file = (await client.query(
        `INSERT INTO prompt_files (scope,project_id,prompt_type,file_path)
         VALUES ($1,$2,$3,$4) RETURNING *`,
        [scope, body.project_id ?? null, body.prompt_type,
          scope === "global" ? `prompts/global/${body.prompt_type}.md` : `prompts/projects/${body.project_id}/${body.prompt_type}.md`],
      )).rows[0];
      const version = (await client.query(
        `INSERT INTO prompt_versions (prompt_file_id,version,content,content_hash,created_by)
         VALUES ($1,1,$2,$3,$4) RETURNING *`,
        [file.id, body.content ?? "", promptContentHash(body.content ?? ""), session.user_id],
      )).rows[0];
      const updated = (await client.query(
        "UPDATE prompt_files SET active_version_id=$2,updated_at=now() WHERE id=$1 RETURNING *",
        [file.id, body.active === false ? null : version.id],
      )).rows[0];
      await audit({ actorType: "admin", actorId: session.user_id, action: "prompt.create", entityType: "prompt_file", entityId: file.id, after: { ...updated, version }, ip: ipOf(request) }, client);
      return { ...updated, active_version: version };
    });
    return json(response, 201, { prompt });
  }
  const promptMatch = url.pathname.match(/^\/api\/admin\/prompts\/([0-9a-f-]+)$/i);
  if (promptMatch && request.method === "GET") {
    const prompt = (await pool.query(
      `SELECT pf.*,pv.content active_content,pv.version active_version,pv.content_hash
       FROM prompt_files pf LEFT JOIN prompt_versions pv ON pv.id=pf.active_version_id WHERE pf.id=$1`,
      [promptMatch[1]],
    )).rows[0];
    if (!prompt) return json(response, 404, { error: "prompt not found" });
    const versions = (await pool.query("SELECT * FROM prompt_versions WHERE prompt_file_id=$1 ORDER BY version DESC", [prompt.id])).rows;
    return json(response, 200, { prompt, versions });
  }
  const promptVersionsMatch = url.pathname.match(/^\/api\/admin\/prompts\/([0-9a-f-]+)\/versions$/i);
  if (promptVersionsMatch && request.method === "POST") {
    const body = await bodyOf(request);
    validatePromptTemplate(body.content);
    const result = await inTransaction(async (client) => {
      const file = (await client.query("SELECT * FROM prompt_files WHERE id=$1 FOR UPDATE", [promptVersionsMatch[1]])).rows[0];
      if (!file) return null;
      const next = (await client.query("SELECT COALESCE(max(version),0)+1 next FROM prompt_versions WHERE prompt_file_id=$1", [file.id])).rows[0].next;
      const version = (await client.query(
        `INSERT INTO prompt_versions (prompt_file_id,version,content,content_hash,created_by)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [file.id, next, body.content, promptContentHash(body.content), session.user_id],
      )).rows[0];
      if (body.activate !== false) await client.query("UPDATE prompt_files SET active_version_id=$2,updated_at=now() WHERE id=$1", [file.id, version.id]);
      await audit({ actorType: "admin", actorId: session.user_id, action: "prompt.version.create", entityType: "prompt_file", entityId: file.id, after: version, ip: ipOf(request) }, client);
      return version;
    });
    return result ? json(response, 201, { version: result }) : json(response, 404, { error: "prompt not found" });
  }
  const promptActivateMatch = url.pathname.match(/^\/api\/admin\/prompts\/([0-9a-f-]+)\/activate$/i);
  if (promptActivateMatch && request.method === "POST") {
    const body = await bodyOf(request);
    const file = (await pool.query(
      `UPDATE prompt_files SET active_version_id=$2,updated_at=now()
       WHERE id=$1 AND ($2::uuid IS NULL OR EXISTS (
         SELECT 1 FROM prompt_versions WHERE id=$2 AND prompt_file_id=prompt_files.id
       )) RETURNING *`,
      [promptActivateMatch[1], body.version_id ?? null],
    )).rows[0];
    if (!file) return json(response, 404, { error: "prompt or version not found" });
    await audit({ actorType: "admin", actorId: session.user_id, action: body.version_id ? "prompt.activate" : "prompt.deactivate", entityType: "prompt_file", entityId: file.id, after: file, ip: ipOf(request) });
    return json(response, 200, { prompt: file });
  }
  const promptRestoreMatch = url.pathname.match(/^\/api\/admin\/prompts\/([0-9a-f-]+)\/restore$/i);
  if (promptRestoreMatch && request.method === "POST") {
    const body = await bodyOf(request);
    const restored = await inTransaction(async (client) => {
      const file = (await client.query("SELECT * FROM prompt_files WHERE id=$1 FOR UPDATE", [promptRestoreMatch[1]])).rows[0];
      if (!file) return null;
      const source = (await client.query("SELECT * FROM prompt_versions WHERE id=$1 AND prompt_file_id=$2", [body.version_id, file.id])).rows[0];
      if (!source) return null;
      const next = (await client.query("SELECT max(version)+1 next FROM prompt_versions WHERE prompt_file_id=$1", [file.id])).rows[0].next;
      const version = (await client.query(
        `INSERT INTO prompt_versions (prompt_file_id,version,content,content_hash,created_by)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [file.id, next, source.content, source.content_hash, session.user_id],
      )).rows[0];
      await client.query("UPDATE prompt_files SET active_version_id=$2,updated_at=now() WHERE id=$1", [file.id, version.id]);
      await audit({ actorType: "admin", actorId: session.user_id, action: "prompt.restore", entityType: "prompt_file", entityId: file.id, metadata: { restored_from_version_id: source.id }, after: version, ip: ipOf(request) }, client);
      return version;
    });
    return restored ? json(response, 201, { version: restored }) : json(response, 404, { error: "prompt or version not found" });
  }
  const promptDiffMatch = url.pathname.match(/^\/api\/admin\/prompts\/([0-9a-f-]+)\/diff$/i);
  if (promptDiffMatch && request.method === "GET") {
    const versions = (await pool.query(
      "SELECT id,version,content FROM prompt_versions WHERE prompt_file_id=$1 AND id=ANY($2::uuid[])",
      [promptDiffMatch[1], [url.searchParams.get("from"), url.searchParams.get("to")].filter(Boolean)],
    )).rows;
    const from = versions.find((version) => version.id === url.searchParams.get("from"));
    const to = versions.find((version) => version.id === url.searchParams.get("to"));
    if (!from || !to) return json(response, 404, { error: "prompt versions not found" });
    return json(response, 200, { from, to, diff: lineDiff(from.content, to.content) });
  }
  if (request.method === "GET" && url.pathname === "/api/admin/projects") return json(response, 200, { projects: (await pool.query("SELECT * FROM projects ORDER BY name")).rows });
  if (request.method === "POST" && url.pathname === "/api/admin/projects") {
    const body = await bodyOf(request);
    const agentStartPath = normalizeAgentStartPath(body.agent_start_path);
    const agentStartPathErrors = await validateAgentStartPath(body.agent_start_path);
    if (agentStartPathErrors.length) return json(response, 400, { error: agentStartPathErrors.join("; ") });
    const result = await pool.query(
      `INSERT INTO projects (slug,name,description,enabled,repository_path,agent_start_path,github_owner,github_repository,default_branch,config_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [body.slug, body.name, body.description ?? null, body.enabled ?? true, body.repository_path, agentStartPath, body.github_owner ?? null, body.github_repository ?? null, body.default_branch ?? "main", body.config_json ?? {}],
    );
    await audit({ actorType: "admin", actorId: session.user_id, action: "project.create", entityType: "project", entityId: result.rows[0].id, after: result.rows[0], ip: ipOf(request) });
    return json(response, 201, { project: result.rows[0] });
  }
  const projectMatch = url.pathname.match(/^\/api\/admin\/projects\/([0-9a-f-]+)$/i);
  if (projectMatch && request.method === "GET") {
    const project = (await pool.query("SELECT * FROM projects WHERE id = $1", [projectMatch[1]])).rows[0];
    return project ? json(response, 200, { project }) : json(response, 404, { error: "project not found" });
  }
  if (projectMatch && request.method === "PATCH") {
    const before = (await pool.query("SELECT * FROM projects WHERE id = $1", [projectMatch[1]])).rows[0];
    if (!before) return json(response, 404, { error: "project not found" });
    const body = await bodyOf(request);
    const agentStartPath = normalizeAgentStartPath(body.agent_start_path);
    if (Object.hasOwn(body, "agent_start_path")) {
      const agentStartPathErrors = await validateAgentStartPath(body.agent_start_path);
      if (agentStartPathErrors.length) return json(response, 400, { error: agentStartPathErrors.join("; ") });
    }
    const allowed = ["name", "description", "enabled", "repository_path", "agent_start_path", "github_owner", "github_repository", "default_branch", "config_json"];
    const entries = Object.entries(body).filter(([key]) => allowed.includes(key)).map(([key, value]) => [key, key === "agent_start_path" ? agentStartPath : value]);
    if (!entries.length) return json(response, 400, { error: "no supported fields" });
    // config_json is shallow-merged into the existing value (not replaced) so a
    // partial save from the UI (e.g. just `commands` + `branch_prefix`) never
    // wipes worker-only keys like `ai`, `protected_paths`, `definition_of_done`.
    const assignments = entries.map(([key], index) => key === "config_json" ? `config_json=COALESCE(config_json,'{}'::jsonb) || $${index + 2}::jsonb` : `${key}=$${index + 2}`).join(",");
    const after = (await pool.query(`UPDATE projects SET ${assignments},config_version=config_version+1,updated_at=now() WHERE id=$1 RETURNING *`, [projectMatch[1], ...entries.map(([, value]) => value)])).rows[0];
    await audit({ actorType: "admin", actorId: session.user_id, action: "project.update", entityType: "project", entityId: after.id, before, after, ip: ipOf(request) });
    return json(response, 200, { project: after });
  }
  const validateMatch = url.pathname.match(/^\/api\/admin\/projects\/([0-9a-f-]+)\/validate$/i);
  if (validateMatch && request.method === "POST") {
    const project = (await pool.query("SELECT id FROM projects WHERE id = $1", [validateMatch[1]])).rows[0];
    if (!project) return json(response, 404, { error: "project not found" });
    return json(response, 202, { job: await enqueueJob({ type: "project.validate", payload: { project_id: project.id }, idempotencyKey: `project.validate:${project.id}` }) });
  }
  if (url.pathname === "/api/admin/forms" && request.method === "GET") {
    const forms = (await pool.query("SELECT * FROM forms ORDER BY name")).rows;
    return json(response, 200, { forms });
  }
  if (url.pathname === "/api/admin/forms" && request.method === "POST") {
    const body = await bodyOf(request);
    const fields = normalizeFields(body.fields ?? []);
    const form = await inTransaction(async (client) => {
      const result = await client.query(
        `INSERT INTO forms (name,slug,title,description,status,fixed_project_id,settings_json,published_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,CASE WHEN $5='published' THEN now() ELSE NULL END) RETURNING *`,
        [body.name, body.slug, body.title, body.description ?? null, body.status === "published" ? "published" : "draft", body.fixed_project_id ?? null, sanitizeFormSettings(body.settings_json)],
      );
      if (fields) await replaceFields(client, result.rows[0].id, fields);
      await audit({ actorType: "admin", actorId: session.user_id, action: "form.create", entityType: "form", entityId: result.rows[0].id, after: result.rows[0], ip: ipOf(request) }, client);
      return result.rows[0];
    });
    return json(response, 201, { form: { ...form, fields: await fieldsFor(form.id) } });
  }
  const formMatch = url.pathname.match(/^\/api\/admin\/forms\/([0-9a-f-]+)$/i);
  if (formMatch && request.method === "GET") {
    const form = (await pool.query("SELECT * FROM forms WHERE id=$1", [formMatch[1]])).rows[0];
    return form ? json(response, 200, { form: { ...form, fields: await fieldsFor(form.id) } }) : json(response, 404, { error: "form not found" });
  }
  if (formMatch && request.method === "PATCH") {
    const body = await bodyOf(request);
    const fields = body.fields === undefined ? null : normalizeFields(body.fields);
    const allowed = ["name", "slug", "title", "description", "fixed_project_id", "settings_json"];
    const entries = Object.entries(body).filter(([key]) => allowed.includes(key))
      .map(([key, value]) => [key, key === "settings_json" ? sanitizeFormSettings(value) : value]);
    const form = await inTransaction(async (client) => {
      const before = (await client.query("SELECT * FROM forms WHERE id=$1 FOR UPDATE", [formMatch[1]])).rows[0];
      if (!before) return null;
      let after = before;
      if (entries.length) after = (await client.query(`UPDATE forms SET ${entries.map(([key], index) => `${key}=$${index + 2}`).join(",")},updated_at=now() WHERE id=$1 RETURNING *`, [formMatch[1], ...entries.map(([, value]) => value)])).rows[0];
      if (fields) await replaceFields(client, before.id, fields);
      await audit({ actorType: "admin", actorId: session.user_id, action: "form.update", entityType: "form", entityId: before.id, before, after, ip: ipOf(request) }, client);
      return after;
    });
    return form ? json(response, 200, { form: { ...form, fields: await fieldsFor(form.id) } }) : json(response, 404, { error: "form not found" });
  }
  const publishMatch = url.pathname.match(/^\/api\/admin\/forms\/([0-9a-f-]+)\/(publish|unpublish)$/i);
  if (publishMatch && request.method === "POST") {
    const status = publishMatch[2] === "publish" ? "published" : "draft";
    const form = (await pool.query("UPDATE forms SET status=$2,published_at=CASE WHEN $2='published' THEN now() ELSE NULL END,updated_at=now() WHERE id=$1 RETURNING *", [publishMatch[1], status])).rows[0];
    if (!form) return json(response, 404, { error: "form not found" });
    await audit({ actorType: "admin", actorId: session.user_id, action: `form.${publishMatch[2]}`, entityType: "form", entityId: form.id, after: form, ip: ipOf(request) });
    return json(response, 200, { form });
  }
  if (url.pathname === "/api/admin/skills" && request.method === "GET") {
    return json(response, 200, { skills: (await pool.query("SELECT * FROM skills ORDER BY category,name")).rows });
  }
  if (url.pathname === "/api/admin/skills" && request.method === "POST") {
    const body = await bodyOf(request);
    if (typeof body.slug !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(body.slug)) return json(response, 400, { error: "invalid skill slug" });
    if (typeof body.name !== "string" || !body.name.trim()) return json(response, 400, { error: "skill name is required" });
    if (!skillSourceTypes.has(body.source_type)) return json(response, 400, { error: "unsupported skill source type" });
    const skill = (await pool.query(
      `INSERT INTO skills
       (slug,name,description,category,source_type,filesystem_path,enabled,risk_level,version,content_hash,configuration_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [body.slug, body.name.trim(), body.description ?? null, body.category ?? null, body.source_type,
        body.filesystem_path ?? null, body.enabled ?? true, body.risk_level ?? "low", body.version ?? "1.0.0",
        body.content_hash ?? null, body.configuration_json ?? {}],
    )).rows[0];
    await audit({ actorType: "admin", actorId: session.user_id, action: "skill.create", entityType: "skill", entityId: skill.id, after: skill, ip: ipOf(request) });
    return json(response, 201, { skill });
  }
  const skillValidateMatch = url.pathname.match(/^\/api\/admin\/skills\/([0-9a-f-]+)\/validate$/i);
  if (skillValidateMatch && request.method === "POST") {
    const skill = (await pool.query("SELECT * FROM skills WHERE id=$1", [skillValidateMatch[1]])).rows[0];
    if (!skill) return json(response, 404, { error: "skill not found" });
    try {
      const resolved = resolveSkills([{ skill, skillId: skill.id, slug: skill.slug, source: "ticket_selected" }], "", "planning");
      const snapshot = await snapshotSkills(resolved, "planning");
      const result = { valid: true, content_hash: snapshot.skills[0].content_hash, files: snapshot.skills[0].files.map((file) => file.path) };
      await pool.query(
        `UPDATE skills SET content_hash=$2,configuration_json=jsonb_set(configuration_json,'{last_validation_result}',$3::jsonb,true),updated_at=now() WHERE id=$1`,
        [skill.id, result.content_hash, JSON.stringify(result)],
      );
      return json(response, 200, result);
    } catch (error) {
      return json(response, 422, { error: error instanceof Error ? error.message : "skill validation failed", valid: false });
    }
  }
  const skillMatch = url.pathname.match(/^\/api\/admin\/skills\/([0-9a-f-]+)$/i);
  if (skillMatch && request.method === "GET") {
    const skill = (await pool.query("SELECT * FROM skills WHERE id=$1", [skillMatch[1]])).rows[0];
    return skill ? json(response, 200, { skill }) : json(response, 404, { error: "skill not found" });
  }
  if (skillMatch && request.method === "PATCH") {
    const body = await bodyOf(request);
    if (body.source_type !== undefined && !skillSourceTypes.has(body.source_type)) return json(response, 400, { error: "unsupported skill source type" });
    const allowed = ["name", "description", "category", "source_type", "filesystem_path", "enabled", "risk_level", "version", "configuration_json"];
    const entries = Object.entries(body).filter(([key]) => allowed.includes(key));
    if (!entries.length) return json(response, 400, { error: "no supported fields" });
    const before = (await pool.query("SELECT * FROM skills WHERE id=$1", [skillMatch[1]])).rows[0];
    if (!before) return json(response, 404, { error: "skill not found" });
    const skill = (await pool.query(
      `UPDATE skills SET ${entries.map(([key], index) => `${key}=$${index + 2}`).join(",")},updated_at=now() WHERE id=$1 RETURNING *`,
      [skillMatch[1], ...entries.map(([, value]) => value)],
    )).rows[0];
    await audit({ actorType: "admin", actorId: session.user_id, action: "skill.update", entityType: "skill", entityId: skill.id, before, after: skill, ip: ipOf(request) });
    return json(response, 200, { skill });
  }
  if (skillMatch && request.method === "DELETE") {
    const skill = (await pool.query("UPDATE skills SET enabled=false,updated_at=now() WHERE id=$1 RETURNING *", [skillMatch[1]])).rows[0];
    return skill ? json(response, 200, { skill }) : json(response, 404, { error: "skill not found" });
  }
  const projectSkillsMatch = url.pathname.match(/^\/api\/admin\/projects\/([0-9a-f-]+)\/skills$/i);
  if (projectSkillsMatch && request.method === "PUT") {
    const body = await bodyOf(request);
    const attachments = Array.isArray(body.skills) ? body.skills : [];
    for (const item of attachments) {
      if (!item || typeof item.skill_id !== "string" || !skillAttachmentTypes.has(item.attachment_type ?? "automatic")) {
        return json(response, 400, { error: "each project skill requires a skill_id and valid attachment_type" });
      }
    }
    const rows = await inTransaction(async (client) => {
      const project = (await client.query("SELECT id FROM projects WHERE id=$1 FOR UPDATE", [projectSkillsMatch[1]])).rows[0];
      if (!project) return null;
      await client.query("DELETE FROM project_skills WHERE project_id=$1", [project.id]);
      for (const item of attachments) {
        await client.query(
          `INSERT INTO project_skills (project_id,skill_id,attachment_type,required,allow_ticket_override)
           VALUES ($1,$2,$3,$4,$5)`,
          [project.id, item.skill_id, item.attachment_type ?? "automatic", item.required ?? false, item.allow_ticket_override ?? false],
        );
      }
      return (await client.query(
        "SELECT ps.*,s.slug,s.name FROM project_skills ps JOIN skills s ON s.id=ps.skill_id WHERE ps.project_id=$1 ORDER BY s.name",
        [project.id],
      )).rows;
    });
    return rows ? json(response, 200, { skills: rows }) : json(response, 404, { error: "project not found" });
  }
  if (url.pathname === "/api/admin/jobs" && request.method === "GET") {
    const params: any[] = [];
    const where: string[] = [];
    const status = url.searchParams.get("status");
    if (status) { params.push(status); where.push(`status=$${params.length}`); }
    const type = url.searchParams.get("type");
    if (type) { params.push(type); where.push(`type=$${params.length}`); }
    const [jobs, capacity] = await Promise.all([pool.query(
      `SELECT *,id AS attempt_id FROM jobs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT 200`,
      params,
    ), pool.query("SELECT count(*)::int observed_running FROM jobs WHERE status='running'")]);
    return json(response, 200, { jobs: jobs.rows, capacity: { configured: 1, observed_running: capacity.rows[0]?.observed_running ?? 0 } });
  }
  if (url.pathname === "/api/admin/tickets" && request.method === "GET") {
    const params: any[] = [];
    const where: string[] = [];
    const mappings = [["project_id", "t.project_id"], ["status", "t.status"], ["priority", "t.priority"], ["category", "t.category"], ["form_id", "t.form_id"]];
    for (const [query, column] of mappings) {
      const value = url.searchParams.get(query);
      if (value) { params.push(value); where.push(`${column}=$${params.length}`); }
    }
    const search = url.searchParams.get("search");
    if (search) { params.push(`%${search}%`); where.push(`(t.ticket_number ILIKE $${params.length} OR t.title ILIKE $${params.length} OR t.description ILIKE $${params.length})`); }
    const tickets = (await pool.query(`SELECT t.*,p.name project_name,f.name form_name FROM tickets t JOIN projects p ON p.id=t.project_id LEFT JOIN forms f ON f.id=t.form_id ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY t.updated_at DESC LIMIT 200`, params)).rows;
    return json(response, 200, { tickets });
  }
  const createTicketMatch = url.pathname === "/api/admin/tickets" && request.method === "POST";
  if (createTicketMatch) {
    const body = await bodyOf(request);
    const text = (key: string) => typeof body[key] === "string" ? body[key].trim() : "";
    const projectId = text("project_id"), title = text("title"), description = text("description");
    if (!projectId || !title || !description) return json(response, 400, { error: "Project, title, and description are required" });
    const project = (await pool.query("SELECT id FROM projects WHERE id=$1", [projectId])).rows[0];
    if (!project) return json(response, 404, { error: "Choose an existing project" });
    const priority = text("priority");
    if (priority && !["critical", "high", "medium", "low"].includes(priority)) return json(response, 400, { error: "Choose a valid priority" });
    const number = (await pool.query("SELECT nextval('ticket_number_sequence') AS number")).rows[0].number;
    const ticket = (await pool.query(
      `INSERT INTO tickets (ticket_number,project_id,title,description,category,priority,environment,expected_behavior,actual_behavior,reproduction_steps,status,custom_values_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'Triage','{}'::jsonb) RETURNING *`,
      [`DCC-${number}`, projectId, title, description, text("category") || null, priority || null, text("environment") || null, text("expected_behavior") || null, text("actual_behavior") || null, text("reproduction_steps") || null],
    )).rows[0];
    await pool.query(
      `INSERT INTO ticket_status_history (ticket_id,previous_status,new_status,reason,actor_type,actor_id)
       VALUES ($1,NULL,'Triage','Created by admin',$2,$3)`,
      [ticket.id, "admin", session.user_id],
    );
    await audit({ actorType: "admin", actorId: session.user_id, action: "ticket.create", entityType: "ticket", entityId: ticket.id, metadata: { title }, ip: ipOf(request) });
    return json(response, 201, { ticket });
  }
  const notesMatch = url.pathname.match(/^\/api\/admin\/tickets\/([^/]+)\/notes$/);
  if (notesMatch && request.method === "POST") {
    const body = await bodyOf(request);
    if (typeof body.body !== "string" || !body.body.trim() || body.body.length > 10000) return json(response, 400, { error: "note body is required" });
    const ticket = (await pool.query("SELECT id FROM tickets WHERE id::text=$1 OR ticket_number=$1", [decodeURIComponent(notesMatch[1])])).rows[0];
    if (!ticket) return json(response, 404, { error: "ticket not found" });
    const note = (await pool.query("INSERT INTO ticket_notes (ticket_id,author_id,body) VALUES ($1,$2,$3) RETURNING *", [ticket.id, session.user_id, body.body.trim()])).rows[0];
    await audit({ actorType: "admin", actorId: session.user_id, action: "ticket.note.create", entityType: "ticket", entityId: ticket.id, after: note, ip: ipOf(request) });
    return json(response, 201, { note });
  }
  const ticketSkillsMatch = url.pathname.match(/^\/api\/admin\/tickets\/([^/]+)\/skills$/);
  if (ticketSkillsMatch && request.method === "PUT") {
    const body = await bodyOf(request);
    const supplied = body.skill_ids ?? body.skills ?? body.skill_slugs ?? [];
    const excluded = body.excluded_skill_ids ?? [];
    if (!Array.isArray(supplied) || supplied.some((value: unknown) => typeof value !== "string")
      || !Array.isArray(excluded) || excluded.some((value: unknown) => typeof value !== "string")) {
      return json(response, 400, { error: "skill_ids and excluded_skill_ids must be arrays" });
    }
    const requested = [...new Set([...supplied, ...excluded])];
    const ref = decodeURIComponent(ticketSkillsMatch[1]);
    const result = await inTransaction(async (client) => {
      const ticket = (await client.query("SELECT * FROM tickets WHERE id::text=$1 OR ticket_number=$1 FOR UPDATE", [ref])).rows[0];
      if (!ticket) return null;
      const skills = requested.length ? (await client.query(
        "SELECT * FROM skills WHERE id::text=ANY($1::text[]) OR slug=ANY($1::text[])",
        [requested],
      )).rows : [];
      for (const selected of requested) {
        const skill = skills.find((item: any) => item.id === selected || item.slug === selected);
        if (!skill) throw new SkillResolutionError(selected, "missing");
        if (!skill.enabled) throw new SkillResolutionError(skill.slug, "disabled");
      }
      await client.query("DELETE FROM ticket_skills WHERE ticket_id=$1", [ticket.id]);
      for (const skill of skills) {
        const isExcluded = excluded.includes(skill.id) || excluded.includes(skill.slug);
        await client.query(
          `INSERT INTO ticket_skills (ticket_id,skill_id,source,selected_by) VALUES ($1,$2,$3,$4)
           ON CONFLICT (ticket_id,skill_id) DO NOTHING`,
          [ticket.id, skill.id, isExcluded ? "excluded" : "manual", session.user_id],
        );
      }
      return { ticket, skills: await resolvedSkillsFor(ticket, "planning", client) };
    });
    return result ? json(response, 200, result) : json(response, 404, { error: "ticket not found" });
  }
  const snapshotMatch = url.pathname.match(/^\/api\/admin\/tickets\/([^/]+)\/skill-snapshots$/);
  if (snapshotMatch && request.method === "POST") {
    const body = await bodyOf(request);
    const phase: AiPhase = ["planning", "execution", "repair"].includes(body.phase) ? body.phase : "planning";
    const ref = decodeURIComponent(snapshotMatch[1]);
    const ticket = (await pool.query("SELECT * FROM tickets WHERE id::text=$1 OR ticket_number=$1", [ref])).rows[0];
    if (!ticket) return json(response, 404, { error: "ticket not found" });
    const copied = await snapshotSkills(await resolvedSkillsFor(ticket, phase), phase);
    const snapshot = (await pool.query(
      `INSERT INTO skill_snapshots (ticket_id,run_id,skills_json,content_hash) VALUES ($1,$2,$3,$4) RETURNING *`,
      [ticket.id, body.run_id ?? null, JSON.stringify(copied.skills), copied.contentHash],
    )).rows[0];
    return json(response, 201, { skill_snapshot: snapshot });
  }
  const actionMatch = url.pathname.match(/^\/api\/admin\/tickets\/([^/]+)\/(reject|cancel|archive)$/);
  if (actionMatch && request.method === "POST") {
    const statuses: Record<string, string> = { reject: "Rejected", cancel: "Cancelled", archive: "Archived" };
    return transitionTicket(decodeURIComponent(actionMatch[1]), statuses[actionMatch[2]], `${actionMatch[2]} by administrator`, session, request, response);
  }
  const reopenMatch = url.pathname.match(/^\/api\/admin\/tickets\/([^/]+)\/reopen$/);
  if (reopenMatch && request.method === "POST") {
    const ticketRef = decodeURIComponent(reopenMatch[1]);
    const before = (await pool.query("SELECT * FROM tickets WHERE id::text = $1 OR ticket_number = $1", [ticketRef])).rows[0];
    if (!before) return json(response, 404, { error: "ticket not found" });
    if (!["Completed", "Merged", "Closed Without Merge"].includes(before.status)) {
      return json(response, 409, { error: `ticket cannot be reopened from ${before.status}` });
    }
    return transitionTicket(ticketRef, "Needs Information", "Reopened by admin", session, request, response);
  }
  const approveMatch = url.pathname.match(/^\/api\/admin\/tickets\/([^/]+)\/approve-planning$/);
  if (approveMatch && request.method === "POST") {
    const body = await bodyOf(request);
    const ref = decodeURIComponent(approveMatch[1]);
    const ticket = (await pool.query("SELECT * FROM tickets WHERE id::text=$1 OR ticket_number=$1", [ref])).rows[0];
    if (!ticket) return json(response, 404, { error: "ticket not found" });
    const project = (await pool.query("SELECT * FROM projects WHERE id=$1", [ticket.project_id])).rows[0];
    // PRD §28.4: a dirty repository blocks planning outright unless the admin
    // supplies a commit_message to snapshot the working tree first. It's an
    // environment precondition, not a business-state one, so the commit only
    // happens once the request can actually proceed.
    const repoCheck = await validateProject({
      repositoryPath: project.repository_path, defaultBranch: project.default_branch, requireRemote: false, agentStartPath: project.agent_start_path,
    });
    const commitMessage = typeof body.commit_message === "string" ? body.commit_message.trim() : "";
    const selection = resolvedAiFor(ticket, project, "planning");
    validateAiSelection({
      model: typeof body.model === "string" ? body.model : selection.model,
      reasoning_level: typeof body.reasoning_level === "string" ? body.reasoning_level : selection.reasoning_level,
    });
    await resolvedSkillsFor(ticket, "planning");
    if (repoCheck.changedFiles.length) {
      if (!commitMessage) {
        return json(response, 409, {
          error: "repository has uncommitted changes and cannot be planned or executed",
          changed_files: repoCheck.changedFiles,
        });
      }
      if (!["Triage", "Needs Information", "Planning Failed"].includes(ticket.status)) {
        return json(response, 409, { error: "ticket cannot be approved from " + ticket.status });
      }
      // A global master-guard hook (~/.githooks, via core.hooksPath) blocks
      // direct commits on master/main unless a fresh MASTER_UNLOCK marker
      // exists in the repo — the same mechanism ~/.claude/scripts/git-master.sh
      // uses. This commit is an explicit, human-approved admin action (the
      // Commit & Approve button), so mirror the sanctioned unlock/commit/lock
      // sequence around it.
      const commonDir = (await exec("git", ["-C", project.repository_path, "rev-parse", "--git-common-dir"])).stdout.trim();
      const unlockPath = resolve(project.repository_path, commonDir, "MASTER_UNLOCK");
      await writeFile(unlockPath, "");
      try {
        await exec("git", ["-C", project.repository_path, "add", "--all"]);
        await exec("git", ["-C", project.repository_path, "commit", "-m", commitMessage]);
      } catch (error) {
        return json(response, 409, {
          error: "could not commit uncommitted changes: " + (error instanceof Error ? error.message : "git commit failed"),
          changed_files: repoCheck.changedFiles,
        });
      } finally {
        await rm(unlockPath, { force: true });
      }
      const recheck = await validateProject({
        repositoryPath: project.repository_path, defaultBranch: project.default_branch, requireRemote: false, agentStartPath: project.agent_start_path,
      });
      if (recheck.changedFiles.length) {
        return json(response, 409, {
          error: "repository still has uncommitted changes after committing",
          changed_files: recheck.changedFiles,
        });
      }
    }
    const result = await inTransaction(async (client) => {
      const before = (await client.query(
        "SELECT * FROM tickets WHERE id::text=$1 OR ticket_number=$1 FOR UPDATE",
        [ref],
      )).rows[0];
      if (!before) return null;
      if (!["Triage", "Needs Information", "Planning Failed"].includes(before.status)) {
        throw Object.assign(new Error(`ticket cannot be approved from ${before.status}`), { status: 409 });
      }
      await client.query("UPDATE tickets SET status='Approved for Planning',updated_at=now() WHERE id=$1", [before.id]);
      await client.query(
        `INSERT INTO ticket_status_history
         (ticket_id,previous_status,new_status,reason,actor_type,actor_id)
         VALUES ($1,$2,'Approved for Planning','Approved for planning','admin',$3)`,
        [before.id, before.status, session.user_id],
      );
      const priorAttempts = (await client.query(
        "SELECT count(*)::int AS c FROM jobs WHERE type='planning.generate' AND payload_json->>'ticket_id'=$1",
        [before.id],
      )).rows[0].c;
      const job = await enqueueJob({
        type: "planning.generate",
        payload: {
          ticket_id: before.id,
          // Dev/test only — the worker never reads this in a production
          // build (see @dcc/claude-runner's NODE_ENV guard). Lets tests
          // route a specific mock-claude scenario to this job without a
          // dedicated preview endpoint; see HARNESS_CONVENTIONS.md.
          ...(typeof body.mock_scenario_path === "string" ? { mock_scenario_path: body.mock_scenario_path } : {}),
        },
        idempotencyKey: `planning.generate:${before.id}:${priorAttempts + 1}`, maxAttempts: 1,
      }, client);
      const after = (await client.query(
        "UPDATE tickets SET status='Planning Queued',updated_at=now() WHERE id=$1 RETURNING *",
        [before.id],
      )).rows[0];
      await client.query(
        `INSERT INTO ticket_status_history
         (ticket_id,previous_status,new_status,reason,actor_type,actor_id,related_job_id)
         VALUES ($1,'Approved for Planning','Planning Queued','Planning job queued','admin',$2,$3)`,
        [before.id, session.user_id, job.id],
      );
      await audit({
        actorType: "admin", actorId: session.user_id, action: "ticket.approve_planning",
        entityType: "ticket", entityId: before.id, before, after, metadata: { job_id: job.id }, ip: ipOf(request),
      }, client);
      return { ticket: after, job };
    });
    return result ? json(response, 202, result) : json(response, 404, { error: "ticket not found" });
  }
  const ticketPlansMatch = url.pathname.match(/^\/api\/admin\/tickets\/([^/]+)\/plans$/);
  if (ticketPlansMatch && request.method === "GET") {
    const ref = decodeURIComponent(ticketPlansMatch[1]);
    const ticket = (await pool.query("SELECT id FROM tickets WHERE id::text=$1 OR ticket_number=$1", [ref])).rows[0];
    if (!ticket) return json(response, 404, { error: "ticket not found" });
    const plans = (await pool.query(
      `SELECT p.*,COALESCE(json_agg(pv ORDER BY pv.version) FILTER (WHERE pv.id IS NOT NULL),'[]') versions
       FROM plans p LEFT JOIN plan_versions pv ON pv.plan_id=p.id WHERE p.ticket_id=$1 GROUP BY p.id`,
      [ticket.id],
    )).rows;
    return json(response, 200, { plans });
  }
  const planRevisionMatch = url.pathname.match(/^\/api\/admin\/plans\/([0-9a-f-]+)\/request-revision$/i);
  if (planRevisionMatch && request.method === "POST") {
    const body = await bodyOf(request);
    if (typeof body.feedback !== "string" || !body.feedback.trim() || body.feedback.length > 10000) {
      return json(response, 400, { error: "feedback is required" });
    }
    const expected = (await pool.query(
      `SELECT p.ticket_id,p.current_version_id,t.status,t.updated_at::text ticket_version,t.approved_input_snapshot_id
       FROM plans p JOIN tickets t ON t.id=p.ticket_id WHERE p.id=$1`,
      [planRevisionMatch[1]],
    )).rows[0];
    if (!expected) return json(response, 404, { error: "plan not found" });
    if (!["Plan Ready for Review", "Plan Approved", "Needs Information", "Planning Failed"].includes(expected.status)) {
      return json(response, 409, { error: `revision cannot be requested from ${expected.status}` });
    }
    let result;
    try { result = await inTransaction(async (client) => {
      const plan = (await client.query(
        `SELECT p.*,t.id ticket_id
         FROM plans p JOIN tickets t ON t.id=p.ticket_id
         WHERE p.id=$1 FOR UPDATE OF p,t`,
        [planRevisionMatch[1]],
      )).rows[0];
      if (!plan) return null;
      const current = (await client.query(
        "SELECT * FROM plan_versions WHERE id=$1 AND plan_id=$2",
        [expected.current_version_id, plan.id],
      )).rows[0];
      if (!current) throw Object.assign(new Error("current plan version not found"), { status: 409 });
      await requestPlanRevisionDecision(client, {
        ticketId: expected.ticket_id, planVersionId: expected.current_version_id,
        expectedTicketVersion: expected.ticket_version, expectedStatus: expected.status,
        expectedSnapshotId: expected.approved_input_snapshot_id ?? null,
      });
      const feedback = (await client.query(
        `INSERT INTO plan_review_feedback (plan_id,plan_version_id,feedback,created_by)
         VALUES ($1,$2,$3,$4) RETURNING *`,
        [plan.id, current.id, body.feedback.trim(), session.user_id],
      )).rows[0];
      await client.query(
        `INSERT INTO ticket_status_history
         (ticket_id,previous_status,new_status,reason,actor_type,actor_id,related_plan_version_id)
         VALUES ($1,$2,'Plan Revision Requested','Plan revision requested','admin',$3,$4)`,
        [plan.ticket_id, expected.status, session.user_id, current.id],
      );
      const job = await enqueueJob({
        type: "planning.revise",
        payload: {
          ticket_id: plan.ticket_id,
          plan_id: plan.id,
          plan_version_id: current.id,
          feedback_id: feedback.id,
          ...(typeof body.mock_scenario_path === "string" ? { mock_scenario_path: body.mock_scenario_path } : {}),
        },
        idempotencyKey: `planning.revise:${plan.id}:${current.version + 1}`,
        maxAttempts: 1,
      }, client);
      const ticket = (await client.query(
        "UPDATE tickets SET status='Plan Revision Queued',updated_at=now() WHERE id=$1 RETURNING *",
        [plan.ticket_id],
      )).rows[0];
      await client.query(
        `INSERT INTO ticket_status_history
         (ticket_id,previous_status,new_status,reason,actor_type,actor_id,related_job_id,related_plan_version_id)
         VALUES ($1,'Plan Revision Requested','Plan Revision Queued','Plan revision job queued','admin',$2,$3,$4)`,
        [plan.ticket_id, session.user_id, job.id, current.id],
      );
      return { ticket, job, feedback };
    }); } catch (error) {
      if (error instanceof ApprovalConflictError) return json(response, 409, {
        error: error.code, message: error.message, current_snapshot_id: error.currentSnapshotId,
      });
      throw error;
    }
    return result ? json(response, 202, result) : json(response, 404, { error: "plan not found" });
  }
  const planFeedbackMatch = url.pathname.match(/^\/api\/admin\/plans\/([0-9a-f-]+)\/feedback$/i);
  if (planFeedbackMatch && request.method === "GET") {
    const feedback = (await pool.query(
      "SELECT * FROM plan_review_feedback WHERE plan_id=$1 ORDER BY created_at",
      [planFeedbackMatch[1]],
    )).rows;
    return json(response, 200, { feedback });
  }
  const planDiffMatch = url.pathname.match(/^\/api\/admin\/plans\/([0-9a-f-]+)\/diff$/i);
  if (planDiffMatch && request.method === "GET") {
    const ids = [url.searchParams.get("from"), url.searchParams.get("to")].filter(Boolean);
    const versions = (await pool.query(
      "SELECT id,version,content_markdown FROM plan_versions WHERE plan_id=$1 AND id=ANY($2::uuid[])",
      [planDiffMatch[1], ids],
    )).rows;
    const from = versions.find((version) => version.id === ids[0]);
    const to = versions.find((version) => version.id === ids[1]);
    if (!from || !to) return json(response, 404, { error: "plan versions not found" });
    return json(response, 200, { from, to, diff: lineDiff(from.content_markdown, to.content_markdown) });
  }
  const planApproveMatch = url.pathname.match(/^\/api\/admin\/plan-versions\/([0-9a-f-]+)\/approve$/i);
  if (planApproveMatch && request.method === "POST") {
    const body = await bodyOf(request);
    let approved;
    try { approved = await inTransaction(async (client) => {
      const version = (await client.query(
        `SELECT pv.*,p.ticket_id,p.current_version_id,t.status ticket_status,t.updated_at::text ticket_version,
                t.approved_input_snapshot_id,t.project_id
         FROM plan_versions pv
         JOIN plans p ON p.id=pv.plan_id
         JOIN tickets t ON t.id=p.ticket_id
         JOIN projects pr ON pr.id=t.project_id
         WHERE pv.id=$1 FOR UPDATE OF p,t,pr`,
        [planApproveMatch[1]],
      )).rows[0];
      if (!version) return null;
      if (body.plan_version_id !== undefined && body.plan_version_id !== version.id) {
        throw new ApprovalConflictError(version.approved_input_snapshot_id ?? null);
      }
      if (body.content_hash !== undefined && body.content_hash !== version.content_hash) {
        throw new ApprovalConflictError(version.approved_input_snapshot_id ?? null);
      }
      if (version.current_version_id !== version.id) {
        throw new ApprovalConflictError(version.approved_input_snapshot_id ?? null);
      }
      const expectedStatus = body.reconfirm ? "Plan Approved" : "Plan Ready for Review";
      if (version.ticket_status !== expectedStatus) throw new ApprovalConflictError(version.approved_input_snapshot_id ?? null);
      await client.query("LOCK TABLE skills,prompt_files,prompt_versions,project_skills,ticket_skills IN SHARE MODE");
      const ticketBefore = (await client.query("SELECT * FROM tickets WHERE id=$1", [version.ticket_id])).rows[0];
      const resolved = await approvalInputsFor(ticketBefore, version, client);
      const skillSnapshot = (await client.query(
        `INSERT INTO skill_snapshots (ticket_id,skills_json,content_hash) VALUES ($1,$2,$3) RETURNING *`,
        [version.ticket_id, JSON.stringify(resolved.snapshottedSkills.skills), resolved.snapshottedSkills.contentHash],
      )).rows[0];
      const transition = await approvePlanDecision(client, {
        ticketId: version.ticket_id, planVersionId: version.id, expectedTicketVersion: version.ticket_version,
        expectedStatus, expectedSnapshotId: version.approved_input_snapshot_id, approvedInput: resolved.approvedInput,
        decidedBy: session.user_id, skillSnapshotId: skillSnapshot.id,
        metadata: { note: typeof body.note === "string" ? body.note.trim() : null, reconfirm: Boolean(body.reconfirm) },
      });
      await client.query("UPDATE plans SET potentially_stale=false,updated_at=now() WHERE id=$1", [version.plan_id]);
      const approvalNote = typeof body.note === "string" && body.note.trim() ? body.note.trim() : null;
      const defaultReason = body.reconfirm ? "Approved plan reconfirmed" : "Plan approved";
      await client.query(
        `INSERT INTO ticket_status_history
         (ticket_id,previous_status,new_status,reason,actor_type,actor_id,related_plan_version_id)
         VALUES ($1,$2,'Plan Approved',$3,'admin',$4,$5)`,
        [version.ticket_id, body.reconfirm ? "Plan Approved" : "Plan Ready for Review",
          approvalNote ?? defaultReason, session.user_id, version.id],
      );
      return { ticket: transition.ticket, plan_version: version, approved_input_snapshot: transition.approvedInputSnapshot, input_hash: resolved.inputHash };
    }); } catch (error) {
      if (error instanceof ApprovalConflictError) return json(response, 409, {
        error: error.code, message: error.message, current_snapshot_id: error.currentSnapshotId,
      });
      throw error;
    }
    return approved ? json(response, 200, approved) : json(response, 404, { error: "plan version not found" });
  }
  const planRejectMatch = url.pathname.match(/^\/api\/admin\/plan-versions\/([0-9a-f-]+)\/reject$/i);
  if (planRejectMatch && request.method === "POST") {
    const body = await bodyOf(request);
    const expected = (await pool.query(
      `SELECT pv.id,p.ticket_id,p.current_version_id,t.status,t.updated_at::text ticket_version,t.approved_input_snapshot_id
       FROM plan_versions pv JOIN plans p ON p.id=pv.plan_id JOIN tickets t ON t.id=p.ticket_id WHERE pv.id=$1`,
      [planRejectMatch[1]],
    )).rows[0];
    if (!expected) return json(response, 404, { error: "plan version not found" });
    if (body.plan_version_id !== undefined && body.plan_version_id !== expected.id) {
      return json(response, 409, { error: "approval_conflict", message: "the ticket or current plan changed before the approval decision completed", current_snapshot_id: expected.approved_input_snapshot_id ?? null });
    }
    if (expected.current_version_id !== expected.id || !["Plan Ready for Review", "Plan Approved"].includes(expected.status)) {
      return json(response, 409, { error: "approval_conflict", message: "the ticket or current plan changed before the approval decision completed", current_snapshot_id: expected.approved_input_snapshot_id ?? null });
    }
    let rejected;
    try { rejected = await inTransaction(async (client) => {
      const version = (await client.query(
        `SELECT pv.*,p.ticket_id,p.current_version_id,t.status,t.updated_at::text ticket_version,t.approved_input_snapshot_id
         FROM plan_versions pv
         JOIN plans p ON p.id=pv.plan_id
         JOIN tickets t ON t.id=p.ticket_id
         WHERE pv.id=$1 FOR UPDATE OF p,t`,
        [planRejectMatch[1]],
      )).rows[0];
      if (!version) return null;
      const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : "Plan rejected";
      const transition = await rejectPlanDecision(client, {
        ticketId: expected.ticket_id, planVersionId: expected.id, expectedTicketVersion: expected.ticket_version, expectedStatus: expected.status,
        expectedSnapshotId: expected.approved_input_snapshot_id, decidedBy: session.user_id, metadata: { reason },
      });
      await client.query(
        `INSERT INTO ticket_status_history
         (ticket_id,previous_status,new_status,reason,actor_type,actor_id,related_plan_version_id)
         VALUES ($1,$2,'Rejected',$3,'admin',$4,$5)`,
        [version.ticket_id, expected.status, reason, session.user_id, version.id],
      );
      await audit({
        actorType: "admin", actorId: session.user_id, action: "plan_version.reject",
        entityType: "plan_version", entityId: version.id, before: { status: expected.status }, after: { status: "Rejected" },
        metadata: { ticket_id: version.ticket_id, reason: body.reason ?? null }, ip: ipOf(request),
      }, client);
      return { ticket: transition.ticket, plan_version: version, decision: transition.decision };
    }); } catch (error) {
      if (error instanceof ApprovalConflictError) return json(response, 409, {
        error: error.code, message: error.message, current_snapshot_id: error.currentSnapshotId,
      });
      throw error;
    }
    return rejected ? json(response, 200, rejected) : json(response, 404, { error: "plan version not found" });
  }
  const executeMatch = url.pathname.match(/^\/api\/admin\/tickets\/([^/]+)\/execute$/);
  if (executeMatch && request.method === "POST") {
    const body = await bodyOf(request);
    const ref = decodeURIComponent(executeMatch[1]);
    const ticket = (await pool.query(
      "SELECT id FROM tickets WHERE id::text=$1 OR ticket_number=$1",
      [ref],
    )).rows[0];
    if (!ticket) return json(response, 404, { error: "ticket not found" });
    const gate = await checkPlanApprovalGate(pool, ticket.id);
    if ("code" in gate) return json(response, 409, { error: gate.code, message: gate.message });
    const result = await inTransaction(async (client) => {
      const lockedGate = await checkPlanApprovalGate(client, ticket.id);
      if ("code" in lockedGate) throw Object.assign(new Error(lockedGate.message), { status: 409 });
      const active = (await client.query(
        `SELECT 1 FROM execution_attempts
         WHERE ticket_id=$1 AND validation_status IN ('queued','executing','pending') LIMIT 1`,
        [ticket.id],
      )).rowCount;
      if (active) throw Object.assign(new Error("an execution is already active"), { status: 409 });
      const attemptNumber = (await client.query(
        "SELECT COALESCE(max(attempt_number),0)+1 next FROM execution_attempts WHERE ticket_id=$1",
        [ticket.id],
      )).rows[0].next;
      const attempt = (await client.query(
        `INSERT INTO execution_attempts (ticket_id,plan_version_id,attempt_number,validation_status)
         VALUES ($1,$2,$3,'queued') RETURNING *`,
        [ticket.id, lockedGate.planVersion.id, attemptNumber],
      )).rows[0];
      const job = await enqueueJob({
        type: "execution.run",
        payload: {
          ticket_id: ticket.id, execution_attempt_id: attempt.id,
          plan_version_id: lockedGate.planVersion.id,
          approved_input_snapshot_id: lockedGate.approvedInputSnapshot.id,
          ...(typeof body.mock_scenario_path === "string" ? { mock_scenario_path: body.mock_scenario_path } : {}),
        },
        idempotencyKey: `execution.run:${attempt.id}`, maxAttempts: 1,
      }, client);
      const before = lockedGate.ticket.status;
      await client.query("UPDATE tickets SET status='Execution Queued',updated_at=now() WHERE id=$1", [ticket.id]);
      await client.query(
        `INSERT INTO ticket_status_history
         (ticket_id,previous_status,new_status,reason,actor_type,actor_id,related_job_id,related_plan_version_id)
         VALUES ($1,$2,'Execution Queued','Execution job queued','admin',$3,$4,$5)`,
        [ticket.id, before, session.user_id, job.id, lockedGate.planVersion.id],
      );
      return {
        attempt, job, approved_input_snapshot_id: lockedGate.approvedInputSnapshot.id,
        input_hash: lockedGate.approvedInputSnapshot.inputHash,
      };
    });
    return json(response, 202, result);
  }
  const runEventsMatch = url.pathname.match(/^\/api\/admin\/runs\/([0-9a-f-]+)\/events$/i);
  if (runEventsMatch && request.method === "GET") {
    const run = (await pool.query("SELECT * FROM agent_runs WHERE id=$1", [runEventsMatch[1]])).rows[0];
    if (!run) return json(response, 404, { error: "run not found" });
    const after = Math.max(0, Number(url.searchParams.get("after") ?? 0));
    const events = (await pool.query(
      `SELECT * FROM agent_run_events
       WHERE agent_run_id=$1 AND sequence>$2 ORDER BY sequence LIMIT 500`,
      [run.id, after],
    )).rows;
    return json(response, 200, { run, events });
  }
  const runLogMatch = url.pathname.match(/^\/api\/admin\/runs\/([0-9a-f-]+)\/log$/i);
  if (runLogMatch && request.method === "GET") {
    const row = (await pool.query(
      `SELECT ar.id,a.id artifact_id,a.storage_path,a.status,a.storage_root FROM agent_runs ar
       JOIN artifacts a ON a.agent_run_id=ar.id AND a.artifact_type='execution_log' AND a.status IN ('staged','finalized')
       WHERE ar.id=$1`,
      [runLogMatch[1]],
    )).rows[0];
    if (!row) return json(response, 404, { error: "execution log not found" });
    try {
      const root = row.storage_root === "legacy" ? legacyDataRoot : dataRoot;
      const content = await (row.status === "staged"
        ? readStagedArtifact(root, row.artifact_id).catch(() => readArtifact(root, row.storage_path))
        : readArtifact(root, row.storage_path)).then((content) => content.toString("utf8"));
      return json(response, 200, { run_id: row.id, content });
    } catch {
      return json(response, 404, { error: "execution log not found" });
    }
  }
  const runCancelMatch = url.pathname.match(/^\/api\/admin\/runs\/([0-9a-f-]+)\/cancel$/i);
  const attemptCancelMatch = url.pathname.match(/^\/api\/admin\/execution-attempts\/([0-9a-f-]+)\/cancel$/i);
  if ((runCancelMatch || attemptCancelMatch) && request.method === "POST") {
    const run = (await pool.query(
      runCancelMatch
        ? "SELECT * FROM agent_runs WHERE id=$1"
        : `SELECT ar.* FROM execution_attempts ea JOIN agent_runs ar ON ar.id=ea.agent_run_id WHERE ea.id=$1`,
      [(runCancelMatch ?? attemptCancelMatch)![1]],
    )).rows[0];
    if (!run) return json(response, 404, { error: "active execution run not found" });
    if (!["running", "cancellation_requested"].includes(run.status)) {
      return json(response, 409, { error: "run is not active" });
    }
    const updated = (await pool.query(
      `UPDATE agent_runs SET status='cancellation_requested'
       WHERE id=$1 AND status IN ('running','cancellation_requested') RETURNING *`,
      [run.id],
    )).rows[0];
    return json(response, 202, { run: updated });
  }
  const runRepairMatch = url.pathname.match(/^\/api\/admin\/runs\/([0-9a-f-]+)\/repair$/i);
  if (runRepairMatch && request.method === "POST") {
    const body = await bodyOf(request);
    if (typeof body.feedback !== "string" || !body.feedback.trim() || body.feedback.length > 10000) {
      return json(response, 400, { error: "feedback is required" });
    }
    const result = await inTransaction(async (client) => {
      const source = (await client.query(
        `SELECT ar.*,ea.id execution_attempt_id,ea.plan_version_id,ea.validation_status,
                ea.worktree_path,ea.worktree_lifecycle_status,t.status ticket_status
         FROM agent_runs ar
         JOIN execution_attempts ea ON ea.agent_run_id=ar.id
         JOIN tickets t ON t.id=ea.ticket_id
         WHERE ar.id=$1 FOR UPDATE OF ea,t`,
        [runRepairMatch[1]],
      )).rows[0];
      if (!source) return null;
      if (source.worktree_lifecycle_status === "reclaimed") throw Object.assign(new Error("repair source worktree has been reclaimed"), { status: 409 });
      const approvedSnapshotId = source.metadata_json?.approved_input_snapshot_id;
      if (typeof approvedSnapshotId !== "string") throw Object.assign(new Error("repair run has no approved input snapshot"), { status: 409 });
      const active = (await client.query(
        `SELECT 1 FROM jobs WHERE status IN ('queued','running')
         AND type='execution.repair' AND payload_json->>'source_execution_attempt_id'=$1`,
        [source.execution_attempt_id],
      )).rowCount;
      if (active) throw Object.assign(new Error("a repair is already active"), { status: 409 });
      const rerunOf = await terminalRerunSource(client, source.metadata_json);
      const attemptNumber = (await client.query(
        "SELECT COALESCE(max(attempt_number),0)+1 next FROM execution_attempts WHERE ticket_id=$1",
        [source.ticket_id],
      )).rows[0].next;
      const attempt = (await client.query(
        `INSERT INTO execution_attempts (ticket_id,plan_version_id,attempt_number,validation_status,source_execution_attempt_id)
         VALUES ($1,$2,$3,'queued',$4) RETURNING *`,
        [source.ticket_id, source.plan_version_id, attemptNumber, source.execution_attempt_id],
      )).rows[0];
      const job = await enqueueJob({
        type: "execution.repair",
        payload: {
          ticket_id: source.ticket_id,
          execution_attempt_id: attempt.id,
          source_execution_attempt_id: source.execution_attempt_id,
          plan_version_id: source.plan_version_id,
          approved_input_snapshot_id: approvedSnapshotId,
          feedback: body.feedback.trim(),
          validation_output: source.metadata_json?.validation_output ?? {},
          ...(typeof body.mock_scenario_path === "string" ? { mock_scenario_path: body.mock_scenario_path } : {}),
        },
        idempotencyKey: `execution.repair:${attempt.id}`,
        maxAttempts: 1,
        rerunOf,
      }, client);
      await client.query(
        "UPDATE tickets SET status='Execution Queued',updated_at=now() WHERE id=$1",
        [source.ticket_id],
      );
      await client.query(
        `INSERT INTO ticket_status_history
         (ticket_id,previous_status,new_status,reason,actor_type,actor_id,related_job_id,related_run_id,related_plan_version_id)
         VALUES ($1,$2,'Execution Queued','Repair execution queued','admin',$3,$4,$5,$6)`,
        [source.ticket_id, source.ticket_status, session.user_id, job.id, source.id, source.plan_version_id],
      );
      return { job, execution_attempt_id: attempt.id };
    });
    return result ? json(response, 202, result) : json(response, 404, { error: "run not found" });
  }
  const runRetryMatch = url.pathname.match(/^\/api\/admin\/runs\/([0-9a-f-]+)\/retry$/i);
  if (runRetryMatch && request.method === "POST") {
    const result = await inTransaction(async (client) => {
      const source = (await client.query(
        `SELECT ar.id run_id,ar.metadata_json,ea.*,t.status ticket_status,
                ep.id publication_id,ep.status publication_status,
                ep.idempotency_key publication_idempotency_key
         FROM agent_runs ar
         JOIN execution_attempts ea ON ea.agent_run_id=ar.id
         JOIN tickets t ON t.id=ea.ticket_id
         JOIN execution_publications ep ON ep.execution_attempt_id=ea.id
         WHERE ar.id=$1 FOR UPDATE OF ea,t,ep`,
        [runRetryMatch[1]],
      )).rows[0];
      if (!source) return null;
      if (source.publication_status !== "failed" || source.ticket_status !== "PR Creation Failed" || !source.result_commit || source.validation_status !== "pr_creation_failed") {
        throw Object.assign(new Error("run has no failed publication to retry"), { status: 409 });
      }
      const rerunOf = await terminalRerunSource(client, source.metadata_json);
      const job = await enqueueJob({
        type: "pull-request.retry",
        payload: { ticket_id: source.ticket_id, execution_attempt_id: source.id },
        idempotencyKey: `pull-request.retry:${source.id}:${randomUUID()}`,
        maxAttempts: 1,
        rerunOf,
      }, client);
      await client.query(
        `UPDATE execution_publications
         SET status='pending',error_message=NULL,updated_at=now()
         WHERE id=$1 AND status='failed'`,
        [source.publication_id],
      );
      await client.query(
        "UPDATE tickets SET status='Validating',updated_at=now() WHERE id=$1",
        [source.ticket_id],
      );
      await client.query(
        `INSERT INTO ticket_status_history
         (ticket_id,previous_status,new_status,reason,actor_type,actor_id,related_job_id,related_run_id,related_plan_version_id)
         VALUES ($1,'PR Creation Failed','Validating','Pull-request publication retry queued',
                 'admin',$2,$3,$4,$5)`,
        [source.ticket_id, session.user_id, job.id, source.run_id, source.plan_version_id],
      );
      return { job, execution_attempt_id: source.id };
    });
    return result ? json(response, 202, result) : json(response, 404, { error: "run not found" });
  }
  const promptPreviewMatch = url.pathname.match(/^\/api\/admin\/tickets\/([^/]+)\/prompt-preview$/);
  if (promptPreviewMatch && request.method === "GET") {
    const ref = decodeURIComponent(promptPreviewMatch[1]);
    const phase = url.searchParams.get("phase") === "execution" ? "execution" : "planning";
    const preview = await inTransaction(async (client) => {
      const ticket = (await client.query("SELECT * FROM tickets WHERE id::text=$1 OR ticket_number=$1", [ref])).rows[0];
      if (!ticket) return null;
      if (phase === "execution") {
        const version = (await client.query(
          `SELECT pv.* FROM plans p JOIN plan_versions pv ON pv.id=p.current_version_id WHERE p.ticket_id=$1`,
          [ticket.id],
        )).rows[0];
        if (!version) return { unavailable: true };
        const resolved = await approvalInputsFor(ticket, version, client);
        return {
          phase, content: resolved.approvedInput.prompts.find((item) => item.phase === "execution")?.content ?? "",
          content_hash: promptContentHash(resolved.approvedInput.prompts.find((item) => item.phase === "execution")?.content ?? ""),
          input_hash: resolved.inputHash, material_input: resolved.materialInput,
          model: resolved.approvedInput.models.execution.model,
          reasoning_level: resolved.approvedInput.models.execution.reasoningLevel,
          project_config_version: resolved.approvedInput.project.configVersion, ticket_version: ticket.updated_at,
        };
      }
      const resolved = await promptInputsFor(ticket, "planning", undefined, client);
      return {
        phase, content: resolved.content, content_hash: promptContentHash(resolved.content),
        model: resolved.ai.model, reasoning_level: resolved.ai.reasoning_level,
        prompt_version_ids: resolved.promptVersionIds, project_config_version: resolved.project.config_version,
        ticket_version: ticket.updated_at,
      };
    });
    if (!preview) return json(response, 404, { error: "ticket not found" });
    if ("unavailable" in preview) return json(response, 409, { error: "execution preview requires a current plan" });
    return json(response, 200, {
      ...preview,
    });
  }
  const ticketMatch = url.pathname.match(/^\/api\/admin\/tickets\/([^/]+)$/);
  if (ticketMatch && request.method === "GET") {
    const ref = decodeURIComponent(ticketMatch[1]);
    let ticket = (await pool.query("SELECT * FROM tickets WHERE id::text=$1 OR ticket_number=$1", [ref])).rows[0];
    if (!ticket) return json(response, 404, { error: "ticket not found" });
    if (ticket.status === "Submitted") {
      // PRD §17.2 "Administrator opens triage": Submitted -> Triage fires
      // as a side effect of an admin viewing the ticket.
      ticket = await inTransaction(async (client) => {
        const updated = (await client.query(
          "UPDATE tickets SET status='Triage',updated_at=now() WHERE id=$1 AND status='Submitted' RETURNING *",
          [ticket.id],
        )).rows[0];
        if (updated) {
          await client.query(
            `INSERT INTO ticket_status_history (ticket_id,previous_status,new_status,reason,actor_type,actor_id)
             VALUES ($1,'Submitted','Triage','Administrator opened triage','admin',$2)`,
            [ticket.id, session.user_id],
          );
        }
        return updated ?? ticket;
      });
    }
    const [history, notes, attachments, notifications] = await Promise.all([
      pool.query("SELECT * FROM ticket_status_history WHERE ticket_id=$1 ORDER BY created_at", [ticket.id]),
      pool.query("SELECT * FROM ticket_notes WHERE ticket_id=$1 ORDER BY created_at", [ticket.id]),
      pool.query("SELECT a.*,u.media_type,u.size_bytes FROM attachments a JOIN uploads u ON u.id=a.upload_id WHERE a.ticket_id=$1", [ticket.id]),
      pool.query(
        `SELECT nd.*,np.name provider
         FROM notification_deliveries nd LEFT JOIN notification_providers np ON np.id=nd.provider_id
         WHERE nd.ticket_id=$1 ORDER BY nd.created_at`,
        [ticket.id],
      ),
    ]);
    return json(response, 200, {
      ticket, status_history: history.rows, notes: notes.rows, attachments: attachments.rows,
      notification_history: notifications.rows,
    });
  }
  if (ticketMatch && request.method === "PATCH") {
    const ref = decodeURIComponent(ticketMatch[1]);
    const body = await bodyOf(request);
    if (body.status !== undefined && ["Rejected", "Plan Approved"].includes(body.status)) {
      return json(response, 422, { error: "status must use its decision endpoint" });
    }
    if (body.status !== undefined && (!validStatuses.has(body.status) || systemOnlyStatuses.has(body.status))) return json(response, 422, { error: "status cannot be set manually" });
    const allowed = [
      "title", "description", "category", "priority", "status", "project_id", "submitter_name", "submitter_email",
      "source_url", "environment", "expected_behavior", "actual_behavior", "reproduction_steps",
      "ai_configuration_mode", "default_model", "default_reasoning_level", "planning_model",
      "planning_reasoning_level", "execution_model", "execution_reasoning_level", "repair_model", "repair_reasoning_level",
    ];
    const entries = Object.entries(body).filter(([key]) => allowed.includes(key));
    if (!entries.length) return json(response, 400, { error: "no supported fields" });
    const after = await inTransaction(async (client) => {
      const before = (await client.query("SELECT * FROM tickets WHERE id::text=$1 OR ticket_number=$1 FOR UPDATE", [ref])).rows[0];
      if (!before) return null;
      if (body.ai_configuration_mode !== undefined && !["basic", "advanced"].includes(body.ai_configuration_mode)) {
        throw new AiConfigurationError(`Unsupported AI configuration mode "${body.ai_configuration_mode}"`);
      }
      const candidate = { ...before, ...Object.fromEntries(entries) };
      const project = (await client.query("SELECT * FROM projects WHERE id=$1", [candidate.project_id])).rows[0];
      for (const phase of (candidate.ai_configuration_mode === "advanced"
        ? ["planning", "execution", "repair"] : ["planning"]) as AiPhase[]) {
        resolvedAiFor(candidate, project, phase);
      }
      const updated = (await client.query(`UPDATE tickets SET ${entries.map(([key], index) => `${key}=$${index + 2}`).join(",")},updated_at=now() WHERE id=$1 RETURNING *`, [before.id, ...entries.map(([, value]) => value)])).rows[0];
      if (body.status && body.status !== before.status) await client.query(
        `INSERT INTO ticket_status_history (ticket_id,previous_status,new_status,reason,actor_type,actor_id) VALUES ($1,$2,$3,'Manual admin update','admin',$4)`,
        [before.id, before.status, body.status, session.user_id],
      );
      await audit({ actorType: "admin", actorId: session.user_id, action: "ticket.update", entityType: "ticket", entityId: before.id, before, after: updated, ip: ipOf(request) }, client);
      return updated;
    });
    return after ? json(response, 200, { ticket: after }) : json(response, 404, { error: "ticket not found" });
  }
  if (url.pathname === "/api/admin/audit" && request.method === "GET") {
    const search = url.searchParams.get("search") ?? "";
    const values: any[] = [];
    const conditions: string[] = [];
    if (search) {
      values.push(`%${search}%`);
      const idx = values.length;
      conditions.push(
        `(ae.action ILIKE $${idx} OR ae.entity_type ILIKE $${idx} OR ae.actor_type ILIKE $${idx})`
      );
    }
    const events = (await pool.query(
      `SELECT ae.* FROM audit_events ae
       ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
       ORDER BY ae.created_at DESC LIMIT 200`,
      values,
    )).rows;
    return json(response, 200, { audit_events: events });
  }
  return json(response, 404, { error: "not found" });
}

async function route(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/api/health")) {
    if (url.pathname === "/") { response.writeHead(302, { location: "/login" }); return response.end(); }
    try { const health = await pool.query("SELECT current_database() AS name, (pg_control_system()).system_identifier AS system_identifier"); const database = health.rows[0]; return json(response, 200, { status: "ok", database: "ok", web: "ok", database_identity: createHash("sha256").update(`${database.name}|${database.system_identifier}`).digest("hex") }); }
    catch { return json(response, 503, { status: "degraded", database: "unavailable", web: "ok" }); }
  }
  if (request.method === "GET" && url.pathname === "/login") return html(response, 200, loginPage());
  if (request.method === "POST" && url.pathname === "/api/admin/login") return login(request, response);
  const publicMatch = url.pathname.match(/^\/api\/public\/forms\/([^/]+)$/);
  if (publicMatch && request.method === "GET") {
    const form = await publicForm(decodeURIComponent(publicMatch[1]));
    return form ? json(response, 200, { form, fields: await fieldsFor(form.id) }) : json(response, 404, { error: "form not found" });
  }
  const submissionMatch = url.pathname.match(/^\/api\/public\/forms\/([^/]+)\/submissions$/);
  if (submissionMatch && request.method === "POST") {
    const form = await publicForm(decodeURIComponent(submissionMatch[1]));
    return form ? submitPublicForm(request, response, form) : json(response, 404, { error: "form not found" });
  }
  if (request.method === "POST" && url.pathname === "/api/public/uploads") return upload(request, response);
  const publicPageMatch = url.pathname.match(/^\/f\/([^/]+)(\/submitted)?$/);
  if (publicPageMatch && request.method === "GET") {
    const form = await publicForm(decodeURIComponent(publicPageMatch[1]));
    if (!form) return html(response, 404, "<h1>Form not found</h1>");
    if (publicPageMatch[2]) return html(response, 200, submittedPage(form));
    const projects = (await pool.query("SELECT id,name FROM projects WHERE enabled=true ORDER BY name")).rows;
    return html(response, 200, publicFormPage(form, await fieldsFor(form.id), projects));
  }
  if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) return adminHtml(request, response, url);
  if (!url.pathname.startsWith("/api/admin/")) return json(response, 404, { error: "not found" });
  const session = await requireAdmin(request, response);
  if (session) return adminApi(request, response, url, session);
}

const server = createServer((request, response) => {
  route(request, response).catch((error) => {
    console.error(error);
    const status = Number(error?.status) || 500;
    if (!response.headersSent) json(response, status, error instanceof ApprovalConflictError ? {
      error: error.code, message: error.message, current_snapshot_id: error.currentSnapshotId,
    } : {
      error: status === 413 ? "request too large" : status < 500 ? error.message : "internal error",
      code: status < 500 ? error?.code : undefined,
    });
    else response.end();
  });
});
if (process.env.NODE_ENV !== "test") server.listen(port, process.env.HOST ?? "0.0.0.0", () => console.log(`web listening on ${port}`));
