import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pool, inTransaction } from "@dcc/database";
import { enqueueJob } from "@dcc/domain";
import { hashPassword, verifyPassword } from "../../../packages/database/src/password.ts";

const port = Number(process.env.PORT ?? 3000);
const production = process.env.NODE_ENV === "production";
const lockoutThreshold = 5;
const lockoutWindowMinutes = 15;
const sessionHours = 8;
const dummyHash = await hashPassword(randomBytes(32).toString("hex"));

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function json(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  response.end(JSON.stringify(body));
}

async function bodyOf(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) throw Object.assign(new Error("request too large"), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function cookieValue(request: IncomingMessage, name: string) {
  const part = request.headers.cookie?.split(";").map((item) => item.trim()).find((item) => item.startsWith(`${name}=`));
  return part?.slice(name.length + 1);
}

function ipOf(request: IncomingMessage) {
  return request.socket.remoteAddress ?? null;
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
     WHERE username = $1 AND succeeded = false
       AND attempted_at > now() - make_interval(mins => $2)`,
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

async function route(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/api/health")) {
    try {
      await pool.query("SELECT 1");
      return json(response, 200, { status: "ok", database: "ok", web: "ok" });
    } catch {
      return json(response, 503, { status: "degraded", database: "unavailable", web: "ok" });
    }
  }
  if (request.method === "POST" && url.pathname === "/api/admin/login") return login(request, response);

  if (!url.pathname.startsWith("/api/admin/")) return json(response, 404, { error: "not found" });
  const session = await requireAdmin(request, response);
  if (!session) return;

  if (request.method === "GET" && url.pathname === "/api/admin/session") {
    return json(response, 200, { user: { id: session.user_id, username: session.username, role: session.role } });
  }
  if (request.method === "POST" && url.pathname === "/api/admin/logout") {
    await pool.query("UPDATE admin_sessions SET invalidated_at = now() WHERE id = $1", [session.id]);
    await audit({ actorType: "admin", actorId: session.user_id, action: "logout", entityType: "user", entityId: session.user_id, ip: ipOf(request) });
    return json(response, 200, { ok: true }, { "set-cookie": "dcc_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0" });
  }
  if (request.method === "GET" && url.pathname === "/api/admin/projects") {
    return json(response, 200, { projects: (await pool.query("SELECT * FROM projects ORDER BY name")).rows });
  }
  if (request.method === "POST" && url.pathname === "/api/admin/projects") {
    const body = await bodyOf(request);
    const result = await pool.query(
      `INSERT INTO projects (slug,name,description,enabled,repository_path,github_owner,github_repository,default_branch,config_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [body.slug, body.name, body.description ?? null, body.enabled ?? true, body.repository_path,
        body.github_owner ?? null, body.github_repository ?? null, body.default_branch ?? "main", body.config_json ?? {}],
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
    const values = entries.map(([, value]) => value);
    const sets = entries.map(([key], index) => `${key} = $${index + 2}`);
    const after = (await pool.query(`UPDATE projects SET ${sets.join(", ")}, config_version = config_version + 1, updated_at = now() WHERE id = $1 RETURNING *`, [projectMatch[1], ...values])).rows[0];
    await audit({ actorType: "admin", actorId: session.user_id, action: "project.update", entityType: "project", entityId: after.id, before, after, ip: ipOf(request) });
    return json(response, 200, { project: after });
  }

  const validateMatch = url.pathname.match(/^\/api\/admin\/projects\/([0-9a-f-]+)\/validate$/i);
  if (validateMatch && request.method === "POST") {
    const project = (await pool.query("SELECT id FROM projects WHERE id = $1", [validateMatch[1]])).rows[0];
    if (!project) return json(response, 404, { error: "project not found" });
    const job = await enqueueJob({ type: "project.validate", payload: { project_id: project.id }, idempotencyKey: `project.validate:${project.id}` });
    return json(response, 202, { job });
  }

  const ticketMatch = url.pathname.match(/^\/api\/admin\/tickets\/([0-9a-f-]+)$/i);
  if (ticketMatch && request.method === "PATCH") {
    const before = (await pool.query("SELECT * FROM tickets WHERE id = $1", [ticketMatch[1]])).rows[0];
    if (!before) return json(response, 404, { error: "ticket not found" });
    const body = await bodyOf(request);
    const allowed = ["title", "description", "category", "priority", "status"];
    const entries = Object.entries(body).filter(([key]) => allowed.includes(key));
    if (!entries.length) return json(response, 400, { error: "no supported fields" });
    const values = entries.map(([, value]) => value);
    const sets = entries.map(([key], index) => `${key} = $${index + 2}`);
    const after = (await pool.query(`UPDATE tickets SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 RETURNING *`, [ticketMatch[1], ...values])).rows[0];
    await audit({ actorType: "admin", actorId: session.user_id, action: "ticket.update", entityType: "ticket", entityId: after.id, before, after, ip: ipOf(request) });
    return json(response, 200, { ticket: after });
  }
  return json(response, 404, { error: "not found" });
}

const server = createServer((request, response) => {
  route(request, response).catch((error) => {
    console.error(error);
    if (!response.headersSent) json(response, error?.status ?? 500, { error: error?.status === 413 ? "request too large" : "internal error" });
    else response.end();
  });
});
server.listen(port, "127.0.0.1", () => console.log(`web listening on ${port}`));
