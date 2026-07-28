import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { pool, inTransaction } from "@dcc/database";
import {
  AiConfigurationError, buildExecutionPrompt, buildPlanningPrompt, checkPlanApprovalGate, enqueueJob, globalPromptTypes,
  projectPromptTypes, promptContentHash, resolveAiConfiguration, setPullRequestTicketStatus, syncPullRequest,
  validateAiSelection, type AiPhase,
} from "@dcc/domain";
import {
  resolveSkills, snapshotSkills, SkillResolutionError, type ResolutionSource, type SkillCandidate,
} from "../../../packages/skill-registry/src/index.ts";
import { hashPassword, verifyPassword } from "../../../packages/database/src/password.ts";
import { adminPage, escapeHtml, loginPage, publicFormPage, submittedPage } from "./ui.ts";

const port = Number(process.env.PORT ?? 3000);
const production = process.env.NODE_ENV === "production";
const uploadRoot = resolve(process.env.DCC_DATA_DIR ?? "data", "uploads");
const lockoutThreshold = 5;
const lockoutWindowMinutes = 15;
const sessionHours = 8;
const maxJsonBytes = 1024 * 1024;
const maxUploadBytes = 8 * 1024 * 1024;
const defaultRateLimit = 15;
const dummyHash = await hashPassword(randomBytes(32).toString("hex"));
const systemOnlyStatuses = new Set(["Planning", "Executing", "Validating", "PR Ready for Review", "Merged"]);
const validStatuses = new Set([
  "Submitted", "Triage", "Needs Information", "Rejected", "Approved for Planning", "Planning Queued",
  "Planning", "Plan Ready for Review", "Plan Revision Requested", "Plan Revision Queued", "Plan Approved",
  "Execution Queued", "Executing", "Validating", "Validation Failed", "Execution Failed", "PR Creation Failed",
  "PR Ready for Review", "PR Changes Requested", "PR Approved", "Merged", "Closed Without Merge", "Completed",
  "Cancelled", "Archived",
]);
const fieldTypes = new Set([
  "short_text", "long_text", "email", "url", "number", "dropdown", "radio", "checkbox", "multi_select",
  "project_selector", "category_selector", "environment_selector", "image_upload", "hidden", "static",
]);
const skillSourceTypes = new Set([
  "workspace_global", "project_local", "personal_claude", "repository", "external_directory",
]);
const skillAttachmentTypes = new Set(["automatic", "required"]);
const allowedTemplateVariables = new Set([
  "project.slug", "project.name", "project.repository_path", "project.default_branch",
  "ticket.title", "ticket.description", "ticket.category", "ticket.priority",
]);

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
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
       SELECT s.*, 'global_mandatory'::text source, 1 source_order
       FROM skills s WHERE COALESCE((s.configuration_json->>'mandatory')::boolean, false)
       UNION ALL
       SELECT s.*, 'project_automatic', 2
       FROM project_skills ps JOIN skills s ON s.id=ps.skill_id
       WHERE ps.project_id=$1 AND ps.attachment_type='automatic'
       UNION ALL
       SELECT s.*, 'ticket_selected', 3
       FROM ticket_skills ts LEFT JOIN skills s ON s.id=ts.skill_id
       WHERE ts.ticket_id=$2
       UNION ALL
       SELECT s.*, 'phase_required', 4
       FROM skills s WHERE s.configuration_json->'required_phases' ? $3
     ) resolved ORDER BY source_order, slug, id`,
    [ticket.project_id, ticket.id, phase],
  )).rows;
  return rows.map((row: any) => ({
    skill: row.id ? row : null,
    skillId: row.id,
    slug: row.slug,
    source: row.source as ResolutionSource,
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

async function activePrompt(scope: "global" | "project", promptType: string, projectId?: string) {
  const row = (await pool.query(
    `SELECT pf.id prompt_file_id,pf.active_version_id,pv.content,pv.version
     FROM prompt_files pf LEFT JOIN prompt_versions pv ON pv.id=pf.active_version_id
     WHERE pf.scope=$1 AND pf.prompt_type=$2
       AND (($1='global' AND pf.project_id IS NULL) OR pf.project_id=$3)`,
    [scope, promptType, projectId ?? null],
  )).rows[0];
  return row ?? { prompt_file_id: null, active_version_id: null, content: "", version: null };
}

async function promptInputsFor(ticket: any, phase: "planning" | "execution", approvedPlan?: string) {
  const project = (await pool.query("SELECT * FROM projects WHERE id=$1", [ticket.project_id])).rows[0];
  if (!project) throw Object.assign(new Error("project not found"), { status: 404 });
  const [base, phaseGlobal, context, phaseProject, testing] = await Promise.all([
    activePrompt("global", "base"),
    activePrompt("global", phase),
    activePrompt("project", "context", project.id),
    activePrompt("project", phase, project.id),
    activePrompt("project", "testing", project.id),
  ]);
  const ai = resolvedAiFor(ticket, project, phase);
  const skills = await resolvedSkillsFor(ticket, phase);
  const templateValues = {
    "project.slug": project.slug,
    "project.name": project.name,
    "project.repository_path": project.repository_path,
    "project.default_branch": project.default_branch,
    "ticket.title": ticket.title,
    "ticket.description": ticket.description,
    "ticket.category": ticket.category,
    "ticket.priority": ticket.priority,
  };
  for (const prompt of [base, phaseGlobal, context, phaseProject, testing]) {
    prompt.content = renderPromptTemplate(prompt.content ?? "", templateValues);
  }
  const resolvedSkillContent = skills.map((skill) => ({
    id: skill.id, slug: skill.slug, version: skill.version, resolution_sources: skill.resolution_sources,
  }));
  const promptVersionIds = Object.fromEntries(
    [
      ["global.base", base.active_version_id],
      [`global.${phase}`, phaseGlobal.active_version_id],
      ["project.context", context.active_version_id],
      [`project.${phase}`, phaseProject.active_version_id],
      ...(phase === "execution" ? [["project.testing", testing.active_version_id]] : []),
    ].filter(([, id]) => id),
  );
  if (phase === "planning") {
    return {
      content: buildPlanningPrompt({
        globalBaseInstructions: base.content,
        globalPlanningInstructions: phaseGlobal.content,
        projectContext: context.content,
        projectPlanningInstructions: phaseProject.content,
        projectPathsAndRepositoryMetadata: {
          default_branch: project.default_branch,
          github_owner: project.github_owner,
          github_repository: project.github_repository,
          repository_path: project.repository_path,
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
      globalExecutionInstructions: phaseGlobal.content,
      projectContext: context.content,
      projectExecutionInstructions: phaseProject.content,
      projectTestingInstructions: testing.content,
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

function lineDiff(before: string, after: string) {
  const left = before.split("\n");
  const right = after.split("\n");
  const lines: string[] = [];
  const maximum = Math.max(left.length, right.length);
  for (let index = 0; index < maximum; index += 1) {
    if (left[index] === right[index]) lines.push(` ${left[index] ?? ""}`);
    else {
      if (left[index] !== undefined) lines.push(`-${left[index]}`);
      if (right[index] !== undefined) lines.push(`+${right[index]}`);
    }
  }
  return lines.join("\n");
}

function renderMarkdown(content: string) {
  return content.split("\n").map((line) => {
    if (line.startsWith("### ")) return `<h3>${escapeHtml(line.slice(4))}</h3>`;
    if (line.startsWith("## ")) return `<h2>${escapeHtml(line.slice(3))}</h2>`;
    if (line.startsWith("# ")) return `<h1>${escapeHtml(line.slice(2))}</h1>`;
    if (line.startsWith("- ")) return `<p>• ${escapeHtml(line.slice(2))}</p>`;
    return line ? `<p>${escapeHtml(line)}</p>` : "<br>";
  }).join("");
}

function json(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  response.end(JSON.stringify(body));
}

function html(response: ServerResponse, status: number, body: string, headers: Record<string, string> = {}) {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers });
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
  return request.socket.remoteAddress ?? "unknown";
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
    if (typeof csrf !== "string" || hash(csrf) !== session.csrf_token_hash) {
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
  const failures = await pool.query(
    `SELECT count(*)::integer AS count FROM login_attempts
     WHERE username = $1 AND succeeded = false AND attempted_at > now() - make_interval(mins => $2)`,
    [username, lockoutWindowMinutes],
  );
  if (failures.rows[0].count >= lockoutThreshold) {
    await audit({ actorType: "anonymous", action: "login.failed", entityType: "user", after: { success: false }, metadata: { reason: "locked" }, ip: ipOf(request) });
    return json(response, 429, { error: "account temporarily locked" });
  }
  const user = (await pool.query("SELECT * FROM users WHERE username = $1 AND is_active = true", [username])).rows[0];
  const valid = await verifyPassword(user?.password_hash ?? dummyHash, password);
  await pool.query("INSERT INTO login_attempts (username, succeeded) VALUES ($1, $2)", [username, Boolean(user && valid)]);
  if (!user || !valid) {
    await audit({ actorType: "anonymous", action: "login.failed", entityType: "user", after: { success: false }, ip: ipOf(request) });
    return json(response, 401, { error: "invalid credentials" });
  }
  const token = randomBytes(32).toString("base64url");
  const csrf = randomBytes(32).toString("base64url");
  await inTransaction(async (client) => {
    await client.query("DELETE FROM login_attempts WHERE username = $1", [username]);
    await client.query(
      `INSERT INTO admin_sessions (user_id, token_hash, csrf_token_hash, expires_at)
       VALUES ($1, $2, $3, now() + make_interval(hours => $4))`,
      [user.id, hash(token), hash(csrf), sessionHours],
    );
    await client.query("UPDATE users SET last_login_at = now(), updated_at = now() WHERE id = $1", [user.id]);
    await audit({ actorType: "admin", actorId: user.id, action: "login", entityType: "user", entityId: user.id, after: { success: true }, ip: ipOf(request) }, client);
  });
  const attributes = [`dcc_session=${token}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${sessionHours * 3600}`];
  if (production) attributes.push("Secure");
  json(response, 200, { user: { id: user.id, username: user.username, role: user.role }, csrfToken: csrf }, { "set-cookie": attributes.join("; ") });
}

const standardFields = [
  { field_key: "project_id", field_type: "project_selector", label: "Welk project betreft het?", required: false, position: 10 },
  { field_key: "category", field_type: "category_selector", label: "Categorie", required: false, position: 20, options_json: ["Bug", "UI", "Feature", "Performance"] },
  { field_key: "title", field_type: "short_text", label: "Korte samenvatting", required: true, position: 30, validation_json: { max_length: 200 } },
  { field_key: "description", field_type: "long_text", label: "Wat gaat er mis of wat mist er?", required: true, position: 40, validation_json: { max_length: 10000 } },
  { field_key: "source_url", field_type: "url", label: "Op welke pagina gebeurt dit?", required: false, position: 50 },
  { field_key: "environment", field_type: "environment_selector", label: "Omgeving", required: false, position: 60, options_json: ["Productie", "Staging", "Lokaal"] },
  { field_key: "screenshot", field_type: "image_upload", label: "Schermafbeelding", required: false, position: 70 },
  { field_key: "submitter_email", field_type: "email", label: "E-mailadres (optioneel)", required: false, position: 80 },
  { field_key: "website", field_type: "hidden", label: "Website", required: false, position: 90 },
];

async function fieldsFor(formId: string) {
  const rows = (await pool.query("SELECT * FROM form_fields WHERE form_id = $1 ORDER BY position, created_at", [formId])).rows;
  return rows.length ? rows : standardFields.map((field) => ({ ...field, form_id: formId, validation_json: field.validation_json ?? {}, options_json: field.options_json ?? [] }));
}

async function publicForm(slug: string) {
  return (await pool.query("SELECT * FROM forms WHERE slug = $1 AND status = 'published'", [slug])).rows[0] ?? null;
}

function validateFields(fields: any[], body: Record<string, any>) {
  const errors: Record<string, string> = {};
  for (const field of fields) {
    if (field.field_type === "hidden" || field.field_type === "static" || field.field_type === "image_upload") continue;
    const value = body[field.field_key];
    if (field.required && (value === undefined || value === null || value === "")) errors[field.field_key] = "required";
    if (typeof value === "string") {
      const limit = Math.min(Number(field.validation_json?.max_length ?? (field.field_type === "long_text" ? 10000 : 500)), 10000);
      if (value.length > limit) errors[field.field_key] = "too long";
      if (field.required && field.field_type === "email" && value && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) errors[field.field_key] = "invalid email";
      if (field.required && field.field_type === "url" && value) {
        try { new URL(value); } catch { errors[field.field_key] = "invalid URL"; }
      }
    }
  }
  return errors;
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
  if (typeof body.title !== "string" || !body.title.trim()) errors.title = "required";
  if (typeof body.description !== "string" || !body.description.trim()) errors.description = "required";
  if (Object.keys(errors).length) return json(response, 400, { error: "validation failed", fields: errors });
  const requestedProjectId = form.fixed_project_id ?? body.project_id;
  const project = requestedProjectId
    ? (await pool.query("SELECT id FROM projects WHERE id = $1 AND enabled = true", [requestedProjectId])).rows[0]
    : undefined;
  if (requestedProjectId && !project) return json(response, 400, { error: "valid project is required" });
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
    const customValues = Object.fromEntries(Object.entries(body).filter(([key]) => ![
      "project_id", "title", "description", "category", "priority", "submitter_name", "submitter_email",
      "source_url", "environment", "expected_behavior", "actual_behavior", "reproduction_steps", honeypot,
    ].includes(key)));
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
    const uploadIds = Object.values(body).filter((value) => typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value));
    if (uploadIds.length) {
      await client.query(
        `UPDATE attachments SET ticket_id = $1 WHERE ticket_id IS NULL AND upload_id = ANY($2::uuid[])`,
        [result.rows[0].id, uploadIds],
      );
    }
    await audit({ actorType: "public", action: "ticket.create", entityType: "ticket", entityId: result.rows[0].id, after: result.rows[0], ip }, client);
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
  const filename = `${randomUUID()}${sniffed.extension}`;
  await mkdir(uploadRoot, { recursive: true });
  const path = resolve(uploadRoot, filename);
  await writeFile(path, bytes, { flag: "wx" });
  const originalName = /filename="([^"]*)"/i.exec(raw.subarray(0, headerEnd).toString("utf8"))?.[1] ?? null;
  const row = (await pool.query(
    `INSERT INTO uploads (storage_path,original_name,media_type,size_bytes) VALUES ($1,$2,$3,$4) RETURNING *`,
    [path, originalName ? originalName.slice(0, 255) : null, sniffed.mediaType, bytes.length],
  )).rows[0];
  await pool.query("INSERT INTO attachments (upload_id) VALUES ($1)", [row.id]);
  json(response, 201, { upload_id: row.id, reference: `/uploads/${row.id}` });
}

function normalizeFields(fields: any[]) {
  if (!Array.isArray(fields)) return null;
  return fields.map((field, index) => {
    if (!field || typeof field.field_key !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(field.field_key)) throw Object.assign(new Error("invalid field key"), { status: 400 });
    if (!fieldTypes.has(field.field_type)) throw Object.assign(new Error("invalid field type"), { status: 400 });
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
        field.required, field.position, field.validation_json, field.options_json],
    );
  }
}

async function transitionTicket(ticketRef: string, status: string, reason: string, session: any, request: IncomingMessage, response: ServerResponse) {
  const result = await inTransaction(async (client) => {
    const before = (await client.query("SELECT * FROM tickets WHERE id::text = $1 OR ticket_number = $1 FOR UPDATE", [ticketRef])).rows[0];
    if (!before) return null;
    const after = (await client.query("UPDATE tickets SET status = $2, updated_at = now() WHERE id = $1 RETURNING *", [before.id, status])).rows[0];
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
    (SELECT count(*)::integer FROM tickets WHERE status NOT IN ('Completed','Rejected','Cancelled','Archived')) tickets,
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
  if (url.pathname === "/admin/pull-requests") {
    const values: any[] = [];
    const conditions: string[] = [];
    const search = url.searchParams.get("search") ?? "";
    if (search) {
      values.push(`%${search}%`);
      conditions.push(`(pr.title ILIKE $${values.length} OR t.ticket_number ILIKE $${values.length})`);
    }
    const state = url.searchParams.get("state") ?? "";
    if (state) { values.push(state); conditions.push(`pr.state=$${values.length}`); }
    const pullRequests = (await pool.query(
      `SELECT pr.*,p.name project_name,t.ticket_number,t.status ticket_status
       FROM pull_requests pr JOIN projects p ON p.id=pr.project_id
       LEFT JOIN tickets t ON t.id=pr.ticket_id
       ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
       ORDER BY COALESCE(pr.updated_at_provider,pr.updated_at) DESC LIMIT 200`,
      values,
    )).rows;
    const rows = pullRequests.map((item) =>
      `<a class="ticket-row" href="/admin/pull-requests/${item.id}"><span class="mono">#${item.number}</span><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.project_name)}</span><span>${escapeHtml(item.repository)}</span><span class="status">${escapeHtml(item.review_state ?? item.state)}</span><time>${new Date(item.updated_at_provider ?? item.updated_at).toLocaleDateString("nl-NL")}</time></a>`,
    ).join("");
    const body = `<div class="eyebrow">Work</div><h1>Pull requests</h1>
      <form class="toolbar"><input class="search" name="search" placeholder="Search title or ticket" value="${escapeHtml(search)}">
      <select name="state"><option value="">All states</option><option value="open"${state === "open" ? " selected" : ""}>Open</option><option value="closed"${state === "closed" ? " selected" : ""}>Closed</option></select>
      <button class="button" type="submit">Filter</button><a class="button" href="/admin/pull-requests">Reset</a></form>
      <section class="card"><div class="list-head"><span>PR</span><span>Title</span><span>Project</span><span>Repository</span><span>Review</span><span>Updated</span></div>${rows || "<p>No pull requests found.</p>"}</section>`;
    return html(response, 200, adminPage(url.pathname, "Pull requests", body, metrics, session.username));
  }
  const pullRequestPageMatch = url.pathname.match(/^\/admin\/pull-requests\/([0-9a-f-]+)$/i);
  if (pullRequestPageMatch) {
    const item = (await pool.query(
      `SELECT pr.*,p.name project_name,t.ticket_number,t.title ticket_title,t.status ticket_status,
              pv.content_markdown approved_plan,ar.metadata_json,ea.result_commit
       FROM pull_requests pr JOIN projects p ON p.id=pr.project_id
       LEFT JOIN tickets t ON t.id=pr.ticket_id
       LEFT JOIN plan_versions pv ON pv.id=t.approved_plan_version_id
       LEFT JOIN execution_attempts ea ON ea.id=pr.execution_attempt_id
       LEFT JOIN agent_runs ar ON ar.id=ea.agent_run_id WHERE pr.id=$1`,
      [pullRequestPageMatch[1]],
    )).rows[0];
    if (!item) return html(response, 404, adminPage(url.pathname, "Pull request not found", "<h1>Pull request not found</h1>", metrics, session.username));
    const validation = item.metadata_json?.validation_output ?? {};
    const body = `<div class="eyebrow">${escapeHtml(item.project_name)} · ${escapeHtml(item.repository)}</div>
      <h1>#${item.number} ${escapeHtml(item.title)}</h1>
      <p><span class="status">${escapeHtml(item.state)}</span> <span class="status">${escapeHtml(item.review_state ?? "Review pending")}</span>
      <a class="button primary" href="${escapeHtml(item.url)}">Open on GitHub</a></p>
      <div class="grid two"><section class="card"><div class="card-head">Metadata</div><div class="card-body"><dl>
      <dt>Ticket</dt><dd>${item.ticket_number ? `<a href="/admin/tickets/${escapeHtml(item.ticket_number)}">${escapeHtml(item.ticket_number)} · ${escapeHtml(item.ticket_title)}</a> (${escapeHtml(item.ticket_status)})` : "Unlinked"}</dd>
      <dt>Author</dt><dd>${escapeHtml(item.author)}</dd><dt>Branches</dt><dd>${escapeHtml(item.head_branch)} → ${escapeHtml(item.base_branch)}</dd>
      <dt>Checks</dt><dd>${escapeHtml(item.check_state ?? "Unknown")}</dd><dt>Internal review</dt><dd>${escapeHtml(item.internal_review_state ?? "Not reviewed")}</dd></dl></div></section>
      <section class="card"><div class="card-head">Changed files & validation</div><div class="card-body"><pre>${escapeHtml(JSON.stringify({ changed_files: validation.changed_files ?? [], results: validation.results ?? [] }, null, 2))}</pre></div></section></div>
      <section class="card"><div class="card-head">Approved plan</div><div class="card-body">${item.approved_plan ? renderMarkdown(item.approved_plan) : "<p>No approved plan linked.</p>"}</div></section>
      <section class="card"><div class="card-head">Implementation & commits</div><div class="card-body"><p>${escapeHtml(item.metadata_json?.implementation_summary ?? "No separate implementation summary recorded.")}</p><p class="mono">${escapeHtml(item.result_commit ?? "No commit recorded")}</p></div></section>
      <section class="card"><div class="card-head">Internal notes</div><div class="card-body"><p>${escapeHtml(item.internal_notes ?? "No internal notes.")}</p></div></section>`;
    return html(response, 200, adminPage(url.pathname, `PR #${item.number}`, body, metrics, session.username));
  }
  if (url.pathname === "/admin/tickets") {
    const values: any[] = [];
    const conditions: string[] = [];
    for (const [key, column] of [["project", "p.slug"], ["status", "t.status"], ["priority", "t.priority"], ["category", "t.category"], ["form", "f.slug"]] as const) {
      const value = url.searchParams.get(key);
      if (value) { values.push(value); conditions.push(`${column} = $${values.length}`); }
    }
    const search = url.searchParams.get("search");
    if (search) { values.push(`%${search}%`); conditions.push(`(t.ticket_number ILIKE $${values.length} OR t.title ILIKE $${values.length} OR t.description ILIKE $${values.length})`); }
    const tickets = (await pool.query(
      `SELECT t.*,p.name project_name,f.name form_name FROM tickets t JOIN projects p ON p.id=t.project_id LEFT JOIN forms f ON f.id=t.form_id
       ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""} ORDER BY t.updated_at DESC LIMIT 200`,
      values,
    )).rows;
    const rows = tickets.map((ticket) => `<a class="ticket-row" href="/admin/tickets/${escapeHtml(ticket.ticket_number)}"><span class="mono">${escapeHtml(ticket.ticket_number)}</span><strong>${escapeHtml(ticket.title)}</strong><span>${escapeHtml(ticket.project_name)}</span><span>${escapeHtml(ticket.priority)}</span><span class="status">${escapeHtml(ticket.status)}</span><time>${new Date(ticket.updated_at).toLocaleDateString("nl-NL")}</time></a>`).join("");
    const body = `<div class="eyebrow">Work</div><h1>Tickets</h1><form class="toolbar" id="filters"><input class="search" data-ticket-filter name="search" placeholder="Search tickets" value="${escapeHtml(search)}"><select data-ticket-filter name="status"><option value="">All statuses</option>${[...validStatuses].map((status) => `<option${url.searchParams.get("status") === status ? " selected" : ""}>${status}</option>`).join("")}</select><a class="button" href="/admin/tickets">Reset</a><span aria-live="polite">${tickets.length} tickets</span></form><section class="card"><div class="list-head"><span>Ticket</span><span>Title</span><span>Project</span><span>Priority</span><span>Status</span><span>Updated</span></div>${rows}</section>`;
    return html(response, 200, adminPage(url.pathname, "Tickets", body, metrics, session.username));
  }
  const planComparePageMatch = url.pathname.match(/^\/admin\/tickets\/([^/]+)\/plans\/compare$/);
  if (planComparePageMatch) {
    const ref = decodeURIComponent(planComparePageMatch[1]);
    const ids = [url.searchParams.get("from"), url.searchParams.get("to")].filter(Boolean);
    const rows = (await pool.query(
      `SELECT pv.* FROM plan_versions pv JOIN plans p ON p.id=pv.plan_id
       JOIN tickets t ON t.id=p.ticket_id
       WHERE (t.id::text=$1 OR t.ticket_number=$1) AND pv.id=ANY($2::uuid[])`,
      [ref, ids],
    )).rows;
    const from = rows.find((version) => version.id === ids[0]);
    const to = rows.find((version) => version.id === ids[1]);
    if (!from || !to) {
      return html(response, 404, adminPage(url.pathname, "Versions not found", "<h1>Plan versions not found</h1>", metrics, session.username));
    }
    const body = `<div class="eyebrow">${escapeHtml(ref)} · Plan comparison</div>
      <h1>Version ${from.version} → ${to.version}</h1>
      <p><a class="button" href="/admin/tickets/${escapeHtml(ref)}/plans">Back to plans</a></p>
      <section class="card"><div class="card-body"><pre>${escapeHtml(lineDiff(from.content_markdown, to.content_markdown))}</pre></div></section>`;
    return html(response, 200, adminPage(url.pathname, "Plan comparison", body, metrics, session.username));
  }
  const ticketPlansPageMatch = url.pathname.match(/^\/admin\/tickets\/([^/]+)\/plans$/);
  if (ticketPlansPageMatch) {
    const ref = decodeURIComponent(ticketPlansPageMatch[1]);
    const ticket = (await pool.query(
      "SELECT t.*,p.name project_name FROM tickets t JOIN projects p ON p.id=t.project_id WHERE t.id::text=$1 OR t.ticket_number=$1",
      [ref],
    )).rows[0];
    if (!ticket) return html(response, 404, adminPage(url.pathname, "Ticket not found", "<h1>Ticket not found</h1>", metrics, session.username));
    const versions = (await pool.query(
      `SELECT pv.*,p.planning_session_id,ar.model,ar.reasoning_level,ps.content prompt_content
       FROM plans p JOIN plan_versions pv ON pv.plan_id=p.id
       JOIN agent_runs ar ON ar.id=pv.agent_run_id
       JOIN prompt_snapshots ps ON ps.id=pv.prompt_snapshot_id
       WHERE p.ticket_id=$1 ORDER BY pv.version DESC`,
      [ticket.id],
    )).rows;
    const compare = versions.length > 1
      ? `<a class="button" href="/admin/tickets/${escapeHtml(ticket.ticket_number)}/plans/compare?from=${versions[1].id}&to=${versions[0].id}">Compare latest versions</a>`
      : "";
    const body = `<div class="eyebrow">${escapeHtml(ticket.ticket_number)} · Plan review</div>
      <h1>Implementation plan</h1><p><a class="button" href="/admin/tickets/${escapeHtml(ticket.ticket_number)}">Back to ticket</a></p>
      <p>${compare}</p>
      ${versions.map((version) => `<section class="card"><div class="card-head">Version ${version.version} · ${escapeHtml(version.model)} / ${escapeHtml(version.reasoning_level)}</div>
        <div class="card-body">${renderMarkdown(version.content_markdown)}
        <details><summary>Raw Markdown</summary><pre>${escapeHtml(version.content_markdown)}</pre></details>
        <details><summary>Exact planning prompt</summary><pre>${escapeHtml(version.prompt_content)}</pre></details>
        <p class="mono">Session ${escapeHtml(version.planning_session_id)} · SHA-256 ${escapeHtml(version.content_hash)}</p></div></section>`).join("") || "<p>No completed plan is available yet.</p>"}`;
    return html(response, 200, adminPage(url.pathname, "Plan review", body, metrics, session.username));
  }
  const ticketMatch = url.pathname.match(/^\/admin\/tickets\/([^/]+)$/);
  if (ticketMatch) {
    const ticket = (await pool.query(
      `SELECT t.*,p.name project_name,f.name form_name FROM tickets t JOIN projects p ON p.id=t.project_id LEFT JOIN forms f ON f.id=t.form_id WHERE t.id::text=$1 OR t.ticket_number=$1`,
      [decodeURIComponent(ticketMatch[1])],
    )).rows[0];
    if (!ticket) return html(response, 404, adminPage(url.pathname, "Ticket not found", "<h1>Ticket not found</h1>", metrics, session.username));
    const [notesResult, historyResult, skillsResult] = await Promise.all([
      pool.query("SELECT n.*,u.username FROM ticket_notes n LEFT JOIN users u ON u.id=n.author_id WHERE ticket_id=$1 ORDER BY n.created_at DESC", [ticket.id]),
      pool.query("SELECT * FROM ticket_status_history WHERE ticket_id=$1 ORDER BY created_at DESC", [ticket.id]),
      pool.query(
        `SELECT s.*,ps.id IS NOT NULL automatic,ts.id IS NOT NULL selected
         FROM skills s
         LEFT JOIN project_skills ps ON ps.skill_id=s.id AND ps.project_id=$1 AND ps.attachment_type='automatic'
         LEFT JOIN ticket_skills ts ON ts.skill_id=s.id AND ts.ticket_id=$2
         ORDER BY s.category,s.name`,
        [ticket.project_id, ticket.id],
      ),
    ]);
    const notes = notesResult.rows;
    const history = historyResult.rows;
    const skillRows = skillsResult.rows;
    const chips = skillRows.filter((skill) => skill.automatic || skill.selected).map((skill) =>
      `<span class="skill-chip" data-skill-chip="${skill.id}" data-slug="${escapeHtml(skill.slug)}">${escapeHtml(skill.name)}
       ${skill.automatic ? '<small>auto</small>' : `<button type="button" aria-label="Remove ${escapeHtml(skill.name)}" data-remove-skill="${skill.id}">×</button>`}</span>`,
    ).join("");
    const references = skillRows.filter((skill) => skill.automatic || skill.selected).map((skill) => `- /${escapeHtml(skill.slug)}`).join("\n");
    const modelOptions = ["fable", "opus", "sonnet", "haiku"].map((model) => `<option value="${model}"${ticket.default_model === model ? " selected" : ""}>${model[0].toUpperCase()}${model.slice(1)}</option>`).join("");
    const reasoningOptions = [["low","Low"],["medium","Medium"],["high","High"],["xhigh","Extra high"],["max","Maximum"],["ultracode","Ultracode"]].map(([value,label]) => `<option value="${value}"${ticket.default_reasoning_level === value ? " selected" : ""}>${label}</option>`).join("");
    const phaseConfiguration = (phase: "planning" | "execution" | "repair") => {
      const selectedModel = ticket[`${phase}_model`];
      const selectedReasoning = ticket[`${phase}_reasoning_level`];
      const models = ["fable", "opus", "sonnet", "haiku"].map((model) => `<option value="${model}"${selectedModel === model ? " selected" : ""}>${model[0].toUpperCase()}${model.slice(1)}</option>`).join("");
      const reasoning = [["low","Low"],["medium","Medium"],["high","High"],["xhigh","Extra high"],["max","Maximum"],["ultracode","Ultracode"]].map(([value,label]) => `<option value="${value}"${selectedReasoning === value ? " selected" : ""}>${label}</option>`).join("");
      return `<fieldset><legend>${phase[0].toUpperCase()}${phase.slice(1)}</legend><div class="grid two"><label class="field"><span>Model</span><select name="${phase}_model">${models}</select></label><label class="field"><span>Reasoning level</span><select name="${phase}_reasoning_level">${reasoning}</select></label></div></fieldset>`;
    };
    const body = `<div class="eyebrow">${escapeHtml(ticket.ticket_number)} · ${escapeHtml(ticket.project_name)}</div><h1>${escapeHtml(ticket.title)}</h1><span class="status">${escapeHtml(ticket.status)}</span>
      <div class="tabs" role="tablist">${["Overview","AI & skills","Prompt","Plans","Runs","Validation","Pull request","Activity"].map((label,index) => `<button role="tab" aria-selected="${index === 0}" data-tab="${index}">${label}</button>`).join("")}</div>
      <section class="card" data-tab-panel="1"><div class="card-head">AI configuration</div><div class="card-body">
        <form id="ai-config" data-ticket-id="${ticket.id}"><label class="field"><span>Mode</span><select name="ai_configuration_mode"><option value="basic"${ticket.ai_configuration_mode !== "advanced" ? " selected" : ""}>Basic</option><option value="advanced"${ticket.ai_configuration_mode === "advanced" ? " selected" : ""}>Advanced</option></select></label>
        <div class="grid two"><label class="field"><span>Default model</span><select name="default_model">${modelOptions}</select></label><label class="field"><span>Default reasoning level</span><select name="default_reasoning_level">${reasoningOptions}</select></label></div>
        <div data-advanced-ai${ticket.ai_configuration_mode === "advanced" ? "" : " hidden"}>${phaseConfiguration("planning")}${phaseConfiguration("execution")}${phaseConfiguration("repair")}</div>
        <button class="button primary" type="submit">Save AI configuration</button><p class="error" role="alert"></p></form>
      </div></section>
      <section class="card" data-tab-panel="1"><div class="card-head">Skills</div><div class="card-body"><label class="field"><span>Search and select skills</span><input data-skill-search placeholder="Search skills or categories"></label>
        <div class="skill-options">${skillRows.map((skill) => `<label data-skill-option data-search="${escapeHtml(`${skill.name} ${skill.slug} ${skill.category}`.toLowerCase())}"><input type="checkbox" value="${skill.id}" data-skill-toggle data-slug="${escapeHtml(skill.slug)}" data-name="${escapeHtml(skill.name)}"${skill.automatic || skill.selected ? " checked" : ""}${skill.automatic || !skill.enabled ? " disabled" : ""}> ${escapeHtml(skill.name)} <small>${escapeHtml(skill.category)}${skill.automatic ? " · Automatically added by project" : ""}${!skill.enabled ? " · disabled" : ""}</small></label>`).join("")}</div>
        <div class="skill-chips" data-skill-chips>${chips}</div><pre class="references" data-skill-references>${references}</pre>
      </div></section>
      <section class="card"><div class="card-head">Complete prompt preview</div><div class="card-body"><p>Compile the current prompt versions, project configuration, resolved AI configuration, resolved skills, and this ticket without creating a run or snapshot.</p><a class="button" href="/api/admin/tickets/${ticket.id}/prompt-preview">Open planning prompt preview</a></div></section>
      <section class="card"><div class="card-head">Planning</div><div class="card-body"><p>Review the immutable generated plan, its exact prompt, model, reasoning level, and raw Markdown.</p><a class="button" href="/admin/tickets/${ticket.ticket_number}/plans">Open plan review</a></div></section>
      <div class="grid two"><section class="card"><div class="card-head">Original submission</div><div class="card-body"><p>${escapeHtml(ticket.description)}</p><dl><dt>Category</dt><dd>${escapeHtml(ticket.category)}</dd><dt>Environment</dt><dd>${escapeHtml(ticket.environment)}</dd><dt>Source URL</dt><dd>${escapeHtml(ticket.source_url)}</dd></dl></div></section>
      <section class="card"><div class="card-head">Internal notes</div><div class="card-body notes">${notes.map((note) => `<div class="note"><strong>${escapeHtml(note.username ?? "Administrator")}</strong><p>${escapeHtml(note.body)}</p></div>`).join("") || "<p>No notes yet.</p>"}</div></section></div>
      <section class="card"><div class="card-head">Status history</div><div class="card-body">${history.map((item) => `<p><span class="mono">${new Date(item.created_at).toLocaleString("nl-NL")}</span> ${escapeHtml(item.previous_status ?? "New")} → <strong>${escapeHtml(item.new_status)}</strong></p>`).join("") || "<p>No recorded transitions.</p>"}</div></section>`;
    return html(response, 200, adminPage(url.pathname, ticket.ticket_number, body, metrics, session.username));
  }
  const formPageMatch = url.pathname.match(/^\/admin\/forms\/([^/]+)$/);
  if (formPageMatch) {
    const form = (await pool.query("SELECT * FROM forms WHERE id::text=$1 OR slug=$1", [decodeURIComponent(formPageMatch[1])])).rows[0];
    if (!form) return html(response, 404, adminPage(url.pathname, "Form not found", "<h1>Form not found</h1>", metrics, session.username));
    const fields = await fieldsFor(form.id);
    const body = `<div class="eyebrow">Configure · Form builder</div><h1>${escapeHtml(form.name)}</h1><div class="toolbar"><span class="status">${escapeHtml(form.status)}</span><a class="button" href="/f/${escapeHtml(form.slug)}">Preview public form</a></div>
      <div class="grid two"><section class="card"><div class="card-head">Settings</div><div class="card-body"><dl><dt>Public title</dt><dd>${escapeHtml(form.title)}</dd><dt>Slug</dt><dd class="mono">${escapeHtml(form.slug)}</dd><dt>Description</dt><dd>${escapeHtml(form.description)}</dd><dt>Project binding</dt><dd>${form.fixed_project_id ? "Fixed project" : "Submitter selects"}</dd></dl></div></section>
      <section class="card"><div class="card-head">Fields</div><div class="card-body">${fields.map((field) => `<div class="note"><strong>${escapeHtml(field.label)}</strong><div class="mono">${escapeHtml(field.field_key)} · ${escapeHtml(field.field_type)}${field.required ? " · required" : ""}</div></div>`).join("")}</div></section></div>`;
    return html(response, 200, adminPage(url.pathname, form.name, body, metrics, session.username));
  }
  if (url.pathname === "/admin/forms") {
    const forms = (await pool.query("SELECT f.*,count(ff.id)::integer field_count FROM forms f LEFT JOIN form_fields ff ON ff.form_id=f.id GROUP BY f.id ORDER BY f.name")).rows;
    const body = `<div class="eyebrow">Configure</div><h1>Forms</h1><div class="grid two">${forms.map((form) => `<a class="card" href="/admin/forms/${escapeHtml(form.slug)}"><div class="card-body"><span class="status">${escapeHtml(form.status)}</span><h2>${escapeHtml(form.name)}</h2><p>${escapeHtml(form.title)}</p><span>${form.field_count || standardFields.length} fields</span></div></a>`).join("")}</div>`;
    return html(response, 200, adminPage(url.pathname, "Forms", body, metrics, session.username));
  }
  if (url.pathname === "/admin/prompts") {
    const prompts = (await pool.query(
      `SELECT pf.*,p.name project_name,pv.version active_version
       FROM prompt_files pf LEFT JOIN projects p ON p.id=pf.project_id
       LEFT JOIN prompt_versions pv ON pv.id=pf.active_version_id
       ORDER BY pf.scope,p.name,pf.prompt_type`,
    )).rows;
    const body = `<div class="eyebrow">Configure</div><h1>Prompts</h1><p>Global standards and project-specific instructions are versioned separately.</p>
      <section class="card"><div class="card-head">Prompt documents</div><div class="card-body">
      ${prompts.map((prompt) => `<p><a href="/admin/prompts/${prompt.id}"><strong>${escapeHtml(prompt.prompt_type)}</strong></a> · ${escapeHtml(prompt.scope)}${prompt.project_name ? ` · ${escapeHtml(prompt.project_name)}` : ""} · ${prompt.active_version ? `active v${prompt.active_version}` : "inactive"}</p>`).join("") || "<p>No prompt documents yet. Create them through the prompt API.</p>"}
      </div></section>`;
    return html(response, 200, adminPage(url.pathname, "Prompts", body, metrics, session.username));
  }
  const promptPageMatch = url.pathname.match(/^\/admin\/prompts\/([0-9a-f-]+)$/i);
  if (promptPageMatch) {
    const prompt = (await pool.query(
      `SELECT pf.*,p.name project_name,pv.content active_content,pv.version active_version
       FROM prompt_files pf LEFT JOIN projects p ON p.id=pf.project_id
       LEFT JOIN prompt_versions pv ON pv.id=pf.active_version_id WHERE pf.id=$1`,
      [promptPageMatch[1]],
    )).rows[0];
    if (!prompt) return html(response, 404, adminPage(url.pathname, "Prompt not found", "<h1>Prompt not found</h1>", metrics, session.username));
    const versions = (await pool.query(
      `SELECT pv.*,u.username FROM prompt_versions pv LEFT JOIN users u ON u.id=pv.created_by
       WHERE pv.prompt_file_id=$1 ORDER BY pv.version DESC`,
      [prompt.id],
    )).rows;
    const body = `<div class="eyebrow">Configure · ${escapeHtml(prompt.scope)}${prompt.project_name ? ` · ${escapeHtml(prompt.project_name)}` : ""}</div><h1>${escapeHtml(prompt.prompt_type)} prompt</h1>
      <div class="grid two"><section class="card"><div class="card-head">Markdown editor</div><div class="card-body">
        <form data-prompt-editor data-prompt-id="${prompt.id}"><label class="field"><span>Content</span><textarea name="content" rows="22">${escapeHtml(prompt.active_content)}</textarea></label>
        <p class="mono">Allowed variables: ${[...allowedTemplateVariables].map((item) => `{{${escapeHtml(item)}}}`).join(", ")}</p>
        <button class="button primary" type="submit">Save and activate version</button><button class="button" type="button" data-deactivate>Deactivate</button><p class="error" role="alert"></p></form>
      </div></section><section class="card"><div class="card-head">Rendered preview</div><div class="card-body" data-markdown-preview>${renderMarkdown(prompt.active_content ?? "")}</div></section></div>
      <section class="card"><div class="card-head">Version history</div><div class="card-body">${versions.map((version) =>
        `<p><strong>v${version.version}</strong>${version.id === prompt.active_version_id ? " · active" : ""} · ${escapeHtml(version.username ?? "system")} · <span class="mono">${escapeHtml(version.content_hash.slice(0, 12))}</span>
        <button class="button" data-restore-version="${version.id}">Restore as new version</button>${prompt.active_version_id && prompt.active_version_id !== version.id ? ` <a href="/api/admin/prompts/${prompt.id}/diff?from=${version.id}&to=${prompt.active_version_id}">Diff with active</a>` : ""}</p>`,
      ).join("") || "<p>No versions yet.</p>"}</div></section>`;
    return html(response, 200, adminPage(url.pathname, "Prompt editor", body, metrics, session.username));
  }
  if (url.pathname === "/admin/skills") {
    const skills = (await pool.query("SELECT * FROM skills ORDER BY category,name")).rows;
    const body = `<div class="eyebrow">Configure</div><h1>Skills</h1><p>Central registry of workspace, project, personal, repository, and external skills.</p>
      <section class="card"><div class="list-head skills-head"><span>Skill</span><span>Description</span><span>Category</span><span>Source</span><span>Version</span><span>State</span></div>
      ${skills.map((skill) => `<div class="ticket-row skills-row"><strong>/${escapeHtml(skill.slug)}</strong><span>${escapeHtml(skill.description)}</span><span>${escapeHtml(skill.category)}</span><span>${escapeHtml(skill.source_type)}</span><span>${escapeHtml(skill.version)}</span><span class="status">${skill.enabled ? "Enabled" : "Disabled"}</span></div>`).join("")}</section>`;
    return html(response, 200, adminPage(url.pathname, "Skills", body, metrics, session.username));
  }
  const dashboard = `<div class="eyebrow">Overview</div><h1>Things that need your attention.</h1><div class="grid two"><section class="card"><div class="card-head">Open tickets</div><div class="card-body"><h2>${metrics.tickets}</h2><a class="button" href="/admin/tickets">Open triage</a></div></section><section class="card"><div class="card-head">Job queue</div><div class="card-body"><h2>${metrics.jobs}</h2><p>Queued and running jobs</p></div></section></div>`;
  return html(response, 200, adminPage(url.pathname, "Dashboard", dashboard, metrics, session.username));
}

async function adminApi(request: IncomingMessage, response: ServerResponse, url: URL, session: any) {
  if (request.method === "GET" && url.pathname === "/api/admin/session") return json(response, 200, { user: { id: session.user_id, username: session.username, role: session.role } });
  if (request.method === "POST" && url.pathname === "/api/admin/logout") {
    await pool.query("UPDATE admin_sessions SET invalidated_at = now() WHERE id = $1", [session.id]);
    await audit({ actorType: "admin", actorId: session.user_id, action: "logout", entityType: "user", entityId: session.user_id, ip: ipOf(request) });
    return json(response, 200, { ok: true }, { "set-cookie": "dcc_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0" });
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
    return json(response, 200, {
      pull_request: pullRequest,
      implementation_summary: pullRequest.run_metadata?.implementation_summary ?? null,
      validation_output: validation,
      commits: pullRequest.result_commit ? [{ sha: pullRequest.result_commit }] : [],
      changed_files: validation.changed_files ?? [],
      review_comments: [],
      notification_history: [],
    });
  }
  const pullRequestActionMatch = url.pathname.match(
    /^\/api\/admin\/pull-requests\/([0-9a-f-]+)\/(mark-reviewed|approve|request-changes|repair-instructions|start-repair|refresh|close-ticket)$/i,
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
      await syncPullRequest(pullRequest.id, "admin", session.user_id);
    } else if (action === "mark-reviewed") {
      await pool.query("UPDATE pull_requests SET internal_review_state='reviewed',updated_at=now() WHERE id=$1", [pullRequest.id]);
    } else if (action === "approve") {
      await pool.query("UPDATE pull_requests SET internal_review_state='approved',updated_at=now() WHERE id=$1", [pullRequest.id]);
      await setPullRequestTicketStatus(pullRequest.id, "PR Approved", "Pull request approved internally", "admin", session.user_id);
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
          `SELECT ar.*,ea.id execution_attempt_id,ea.plan_version_id,ea.worktree_path,t.status ticket_status
           FROM agent_runs ar JOIN execution_attempts ea ON ea.agent_run_id=ar.id
           JOIN tickets t ON t.id=ea.ticket_id WHERE ar.id=$1 FOR UPDATE OF ea,t`,
          [pullRequest.agent_run_id],
        )).rows[0];
        if (!source?.worktree_path) throw Object.assign(new Error("repair worktree is unavailable"), { status: 409 });
        const active = (await client.query(
          `SELECT 1 FROM jobs WHERE status IN ('queued','running') AND type='execution.repair'
           AND payload_json->>'execution_attempt_id'=$1`,
          [source.execution_attempt_id],
        )).rowCount;
        if (active) throw Object.assign(new Error("a repair is already active"), { status: 409 });
        const job = await enqueueJob({
          type: "execution.repair",
          payload: {
            ticket_id: source.ticket_id, execution_attempt_id: source.execution_attempt_id,
            plan_version_id: source.plan_version_id, feedback,
            validation_output: source.metadata_json?.validation_output ?? {},
          },
          idempotencyKey: `execution.repair:${source.execution_attempt_id}:${randomUUID()}`,
          maxAttempts: 1,
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
    }
    const updated = (await pool.query("SELECT * FROM pull_requests WHERE id=$1", [pullRequest.id])).rows[0];
    return json(response, 200, { pull_request: updated });
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
    const validTypes: readonly string[] = scope === "global" ? globalPromptTypes : projectPromptTypes;
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
    const result = await pool.query(
      `INSERT INTO projects (slug,name,description,enabled,repository_path,github_owner,github_repository,default_branch,config_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [body.slug, body.name, body.description ?? null, body.enabled ?? true, body.repository_path, body.github_owner ?? null, body.github_repository ?? null, body.default_branch ?? "main", body.config_json ?? {}],
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
    const allowed = ["name", "description", "enabled", "repository_path", "github_owner", "github_repository", "default_branch", "config_json"];
    const entries = Object.entries(body).filter(([key]) => allowed.includes(key));
    if (!entries.length) return json(response, 400, { error: "no supported fields" });
    const after = (await pool.query(`UPDATE projects SET ${entries.map(([key], index) => `${key}=$${index + 2}`).join(",")},config_version=config_version+1,updated_at=now() WHERE id=$1 RETURNING *`, [projectMatch[1], ...entries.map(([, value]) => value)])).rows[0];
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
        [body.name, body.slug, body.title, body.description ?? null, body.status === "published" ? "published" : "draft", body.fixed_project_id ?? null, body.settings_json ?? {}],
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
    const entries = Object.entries(body).filter(([key]) => allowed.includes(key));
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
    if (!Array.isArray(supplied) || supplied.some((value: unknown) => typeof value !== "string")) {
      return json(response, 400, { error: "skill_ids must be an array" });
    }
    const ref = decodeURIComponent(ticketSkillsMatch[1]);
    const result = await inTransaction(async (client) => {
      const ticket = (await client.query("SELECT * FROM tickets WHERE id::text=$1 OR ticket_number=$1 FOR UPDATE", [ref])).rows[0];
      if (!ticket) return null;
      const skills = supplied.length ? (await client.query(
        "SELECT * FROM skills WHERE id::text=ANY($1::text[]) OR slug=ANY($1::text[])",
        [supplied],
      )).rows : [];
      for (const selected of supplied) {
        const skill = skills.find((item: any) => item.id === selected || item.slug === selected);
        if (!skill) throw new SkillResolutionError(selected, "missing");
        if (!skill.enabled) throw new SkillResolutionError(skill.slug, "disabled");
      }
      await client.query("DELETE FROM ticket_skills WHERE ticket_id=$1", [ticket.id]);
      for (const skill of skills) {
        await client.query(
          `INSERT INTO ticket_skills (ticket_id,skill_id,source,selected_by) VALUES ($1,$2,'manual',$3)
           ON CONFLICT (ticket_id,skill_id) DO NOTHING`,
          [ticket.id, skill.id, session.user_id],
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
  const approveMatch = url.pathname.match(/^\/api\/admin\/tickets\/([^/]+)\/approve-planning$/);
  if (approveMatch && request.method === "POST") {
    const body = await bodyOf(request);
    const ref = decodeURIComponent(approveMatch[1]);
    const ticket = (await pool.query("SELECT * FROM tickets WHERE id::text=$1 OR ticket_number=$1", [ref])).rows[0];
    if (!ticket) return json(response, 404, { error: "ticket not found" });
    const project = (await pool.query("SELECT * FROM projects WHERE id=$1", [ticket.project_id])).rows[0];
    const selection = resolvedAiFor(ticket, project, "planning");
    validateAiSelection({
      model: typeof body.model === "string" ? body.model : selection.model,
      reasoning_level: typeof body.reasoning_level === "string" ? body.reasoning_level : selection.reasoning_level,
    });
    await resolvedSkillsFor(ticket, "planning");
    const result = await inTransaction(async (client) => {
      const before = (await client.query(
        "SELECT * FROM tickets WHERE id::text=$1 OR ticket_number=$1 FOR UPDATE",
        [ref],
      )).rows[0];
      if (!before) return null;
      if (!["Triage", "Needs Information"].includes(before.status)) {
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
    const result = await inTransaction(async (client) => {
      const plan = (await client.query(
        `SELECT p.*,t.status,t.id ticket_id
         FROM plans p JOIN tickets t ON t.id=p.ticket_id
         WHERE p.id=$1 FOR UPDATE OF p,t`,
        [planRevisionMatch[1]],
      )).rows[0];
      if (!plan) return null;
      if (plan.status !== "Plan Ready for Review") {
        throw Object.assign(new Error(`revision cannot be requested from ${plan.status}`), { status: 409 });
      }
      const current = (await client.query(
        "SELECT * FROM plan_versions WHERE id=$1 AND plan_id=$2",
        [plan.current_version_id, plan.id],
      )).rows[0];
      if (!current) throw Object.assign(new Error("current plan version not found"), { status: 409 });
      const feedback = (await client.query(
        `INSERT INTO plan_review_feedback (plan_id,plan_version_id,feedback,created_by)
         VALUES ($1,$2,$3,$4) RETURNING *`,
        [plan.id, current.id, body.feedback.trim(), session.user_id],
      )).rows[0];
      await client.query(
        "UPDATE tickets SET status='Plan Revision Requested',updated_at=now() WHERE id=$1",
        [plan.ticket_id],
      );
      await client.query(
        `INSERT INTO ticket_status_history
         (ticket_id,previous_status,new_status,reason,actor_type,actor_id,related_plan_version_id)
         VALUES ($1,$2,'Plan Revision Requested','Plan revision requested','admin',$3,$4)`,
        [plan.ticket_id, plan.status, session.user_id, current.id],
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
    });
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
    const approved = await inTransaction(async (client) => {
      const version = (await client.query(
        `SELECT pv.*,p.ticket_id,p.current_version_id,t.updated_at ticket_version,t.project_id,
                pr.config_version,ar.model,ar.reasoning_level,ar.skill_snapshot_id,ps.metadata_json
         FROM plan_versions pv
         JOIN plans p ON p.id=pv.plan_id
         JOIN tickets t ON t.id=p.ticket_id
         JOIN projects pr ON pr.id=t.project_id
         LEFT JOIN agent_runs ar ON ar.id=pv.agent_run_id
         LEFT JOIN prompt_snapshots ps ON ps.id=pv.prompt_snapshot_id
         WHERE pv.id=$1 FOR UPDATE OF p,t`,
        [planApproveMatch[1]],
      )).rows[0];
      if (!version) return null;
      if (body.plan_version_id !== undefined && body.plan_version_id !== version.id) {
        throw Object.assign(new Error("plan version id does not match"), { status: 409 });
      }
      if (body.content_hash !== undefined && body.content_hash !== version.content_hash) {
        throw Object.assign(new Error("plan content hash does not match"), { status: 409 });
      }
      if (version.current_version_id !== version.id) {
        throw Object.assign(new Error("only the current plan version can be approved"), { status: 409 });
      }
      const ticket = (await client.query(
        `UPDATE tickets SET approved_plan_version_id=$2,approved_plan_hash=$3,
           approved_ticket_version=$4,approved_project_config_version=$5,
           approved_model_config_json=$6,approved_skill_snapshot_id=$7,
           approved_prompt_versions_json=$8,plan_approved_at=now(),
           status='Plan Approved',updated_at=now()
         WHERE id=$1 RETURNING *`,
        [version.ticket_id, version.id, version.content_hash, version.ticket_version, version.config_version,
          { model: version.model, reasoning_level: version.reasoning_level }, version.skill_snapshot_id,
          version.metadata_json?.promptVersionIds ?? {}],
      )).rows[0];
      await client.query("UPDATE plans SET potentially_stale=false,updated_at=now() WHERE id=$1", [version.plan_id]);
      await client.query(
        `INSERT INTO ticket_status_history
         (ticket_id,previous_status,new_status,reason,actor_type,actor_id,related_plan_version_id)
         VALUES ($1,$2,'Plan Approved',$3,'admin',$4,$5)`,
        [version.ticket_id, body.reconfirm ? "Plan Approved" : "Plan Ready for Review",
          body.reconfirm ? "Approved plan reconfirmed" : "Plan approved", session.user_id, version.id],
      );
      return { ticket, plan_version: version };
    });
    return approved ? json(response, 200, approved) : json(response, 404, { error: "plan version not found" });
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
      return { attempt, job };
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
      `SELECT ar.id,ar.metadata_json->>'log_path' log_path FROM agent_runs ar
       JOIN execution_attempts ea ON ea.agent_run_id=ar.id WHERE ar.id=$1`,
      [runLogMatch[1]],
    )).rows[0];
    if (!row) return json(response, 404, { error: "execution log not found" });
    const content = row.log_path ? await readFile(row.log_path, "utf8").catch(() => "") : "";
    return json(response, 200, { run_id: row.id, content });
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
                ea.worktree_path,t.status ticket_status
         FROM agent_runs ar
         JOIN execution_attempts ea ON ea.agent_run_id=ar.id
         JOIN tickets t ON t.id=ea.ticket_id
         WHERE ar.id=$1 FOR UPDATE OF ea,t`,
        [runRepairMatch[1]],
      )).rows[0];
      if (!source) return null;
      if (!source.worktree_path) throw Object.assign(new Error("repair worktree is unavailable"), { status: 409 });
      const active = (await client.query(
        `SELECT 1 FROM jobs WHERE status IN ('queued','running')
         AND type='execution.repair' AND payload_json->>'execution_attempt_id'=$1`,
        [source.execution_attempt_id],
      )).rowCount;
      if (active) throw Object.assign(new Error("a repair is already active"), { status: 409 });
      const job = await enqueueJob({
        type: "execution.repair",
        payload: {
          ticket_id: source.ticket_id,
          execution_attempt_id: source.execution_attempt_id,
          plan_version_id: source.plan_version_id,
          feedback: body.feedback.trim(),
          validation_output: source.metadata_json?.validation_output ?? {},
          ...(typeof body.mock_scenario_path === "string" ? { mock_scenario_path: body.mock_scenario_path } : {}),
        },
        idempotencyKey: `execution.repair:${source.execution_attempt_id}:${randomUUID()}`,
        maxAttempts: 1,
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
      return { job, execution_attempt_id: source.execution_attempt_id };
    });
    return result ? json(response, 202, result) : json(response, 404, { error: "run not found" });
  }
  const runRetryMatch = url.pathname.match(/^\/api\/admin\/runs\/([0-9a-f-]+)\/retry$/i);
  if (runRetryMatch && request.method === "POST") {
    const result = await inTransaction(async (client) => {
      const source = (await client.query(
        `SELECT ar.id run_id,ea.*,t.status ticket_status
         FROM agent_runs ar
         JOIN execution_attempts ea ON ea.agent_run_id=ar.id
         JOIN tickets t ON t.id=ea.ticket_id
         WHERE ar.id=$1 FOR UPDATE OF ea,t`,
        [runRetryMatch[1]],
      )).rows[0];
      if (!source) return null;
      if (source.ticket_status !== "PR Creation Failed" || !source.result_commit) {
        throw Object.assign(new Error("run has no failed publication to retry"), { status: 409 });
      }
      const job = await enqueueJob({
        type: "pull-request.retry",
        payload: { ticket_id: source.ticket_id, execution_attempt_id: source.id },
        idempotencyKey: `pull-request.retry:${source.id}:${randomUUID()}`,
        maxAttempts: 1,
      }, client);
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
    const ticket = (await pool.query("SELECT * FROM tickets WHERE id::text=$1 OR ticket_number=$1", [ref])).rows[0];
    if (!ticket) return json(response, 404, { error: "ticket not found" });
    const phase = url.searchParams.get("phase") === "execution" ? "execution" : "planning";
    if (phase === "execution") {
      return json(response, 409, { error: "execution preview requires an approved plan; available after Phase 6" });
    }
    const preview = await promptInputsFor(ticket, "planning");
    return json(response, 200, {
      phase, content: preview.content, content_hash: promptContentHash(preview.content),
      model: preview.ai.model, reasoning_level: preview.ai.reasoning_level,
      prompt_version_ids: preview.promptVersionIds,
      project_config_version: preview.project.config_version,
      ticket_version: ticket.updated_at,
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
    const [history, notes, attachments] = await Promise.all([
      pool.query("SELECT * FROM ticket_status_history WHERE ticket_id=$1 ORDER BY created_at", [ticket.id]),
      pool.query("SELECT * FROM ticket_notes WHERE ticket_id=$1 ORDER BY created_at", [ticket.id]),
      pool.query("SELECT a.*,u.media_type,u.size_bytes FROM attachments a JOIN uploads u ON u.id=a.upload_id WHERE a.ticket_id=$1", [ticket.id]),
    ]);
    return json(response, 200, { ticket, status_history: history.rows, notes: notes.rows, attachments: attachments.rows });
  }
  if (ticketMatch && request.method === "PATCH") {
    const ref = decodeURIComponent(ticketMatch[1]);
    const body = await bodyOf(request);
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
  return json(response, 404, { error: "not found" });
}

async function route(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/api/health")) {
    if (url.pathname === "/") { response.writeHead(302, { location: "/login" }); return response.end(); }
    try { await pool.query("SELECT 1"); return json(response, 200, { status: "ok", database: "ok", web: "ok" }); }
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
    if (!response.headersSent) json(response, status, {
      error: status === 413 ? "request too large" : status < 500 ? error.message : "internal error",
      code: status < 500 ? error?.code : undefined,
    });
    else response.end();
  });
});
server.listen(port, "127.0.0.1", () => console.log(`web listening on ${port}`));
