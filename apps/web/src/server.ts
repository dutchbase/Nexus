import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { pool, inTransaction } from "@dcc/database";
import { enqueueJob } from "@dcc/domain";
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
const defaultRateLimit = 5;
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

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
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
  { field_key: "project_id", field_type: "project_selector", label: "Welk project betreft het?", required: true, position: 10 },
  { field_key: "category", field_type: "category_selector", label: "Categorie", required: true, position: 20, options_json: ["Bug", "UI", "Feature", "Performance"] },
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
      if (field.field_type === "email" && value && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) errors[field.field_key] = "invalid email";
      if (field.field_type === "url" && value) {
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
     WHERE form_id = $1 AND ip_address = $2 AND created_at > now() - interval '1 hour'`,
    [form.id, ip],
  );
  if (recent.rows[0].count >= limit) return json(response, 429, { error: "submission rate limit exceeded" });
  const errors = validateFields(fields, body);
  if (typeof body.title !== "string" || !body.title.trim()) errors.title = "required";
  if (typeof body.description !== "string" || !body.description.trim()) errors.description = "required";
  if (Object.keys(errors).length) return json(response, 400, { error: "validation failed", fields: errors });
  const projectId = form.fixed_project_id ?? body.project_id;
  const project = (await pool.query("SELECT id FROM projects WHERE id = $1 AND enabled = true", [projectId])).rows[0];
  if (!project) return json(response, 400, { error: "valid project is required" });
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
      [ticketNumber, form.id, project.id, body.title, body.description, body.category ?? null, body.priority ?? "normal",
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
  const ticketMatch = url.pathname.match(/^\/admin\/tickets\/([^/]+)$/);
  if (ticketMatch) {
    const ticket = (await pool.query(
      `SELECT t.*,p.name project_name,f.name form_name FROM tickets t JOIN projects p ON p.id=t.project_id LEFT JOIN forms f ON f.id=t.form_id WHERE t.id::text=$1 OR t.ticket_number=$1`,
      [decodeURIComponent(ticketMatch[1])],
    )).rows[0];
    if (!ticket) return html(response, 404, adminPage(url.pathname, "Ticket not found", "<h1>Ticket not found</h1>", metrics, session.username));
    const notes = (await pool.query("SELECT n.*,u.username FROM ticket_notes n LEFT JOIN users u ON u.id=n.author_id WHERE ticket_id=$1 ORDER BY n.created_at DESC", [ticket.id])).rows;
    const history = (await pool.query("SELECT * FROM ticket_status_history WHERE ticket_id=$1 ORDER BY created_at DESC", [ticket.id])).rows;
    const body = `<div class="eyebrow">${escapeHtml(ticket.ticket_number)} · ${escapeHtml(ticket.project_name)}</div><h1>${escapeHtml(ticket.title)}</h1><span class="status">${escapeHtml(ticket.status)}</span>
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
  const actionMatch = url.pathname.match(/^\/api\/admin\/tickets\/([^/]+)\/(reject|cancel|archive)$/);
  if (actionMatch && request.method === "POST") {
    const statuses: Record<string, string> = { reject: "Rejected", cancel: "Cancelled", archive: "Archived" };
    return transitionTicket(decodeURIComponent(actionMatch[1]), statuses[actionMatch[2]], `${actionMatch[2]} by administrator`, session, request, response);
  }
  const approveMatch = url.pathname.match(/^\/api\/admin\/tickets\/([^/]+)\/approve-planning$/);
  if (approveMatch && request.method === "POST") return transitionTicket(decodeURIComponent(approveMatch[1]), "Approved for Planning", "Approved for planning", session, request, response);
  const ticketMatch = url.pathname.match(/^\/api\/admin\/tickets\/([^/]+)$/);
  if (ticketMatch && request.method === "GET") {
    const ref = decodeURIComponent(ticketMatch[1]);
    const ticket = (await pool.query("SELECT * FROM tickets WHERE id::text=$1 OR ticket_number=$1", [ref])).rows[0];
    if (!ticket) return json(response, 404, { error: "ticket not found" });
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
    const allowed = ["title", "description", "category", "priority", "status", "project_id", "submitter_name", "submitter_email", "source_url", "environment", "expected_behavior", "actual_behavior", "reproduction_steps"];
    const entries = Object.entries(body).filter(([key]) => allowed.includes(key));
    if (!entries.length) return json(response, 400, { error: "no supported fields" });
    const after = await inTransaction(async (client) => {
      const before = (await client.query("SELECT * FROM tickets WHERE id::text=$1 OR ticket_number=$1 FOR UPDATE", [ref])).rows[0];
      if (!before) return null;
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
    if (!response.headersSent) json(response, error?.status ?? 500, { error: error?.status === 413 ? "request too large" : error?.status === 400 ? error.message : "internal error" });
    else response.end();
  });
});
server.listen(port, "127.0.0.1", () => console.log(`web listening on ${port}`));
