import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { pool } from "@dcc/database";
import { csrfMatches, securityHeaders } from "./security.ts";

export type Session = {
  id: string;
  user_id: string;
  username: string;
  role: "admin" | "reporter";
  csrf_token_hash: string;
};

const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);

function cookieValue(request: IncomingMessage, name: string) {
  const part = request.headers.cookie?.split(";").map((item) => item.trim()).find((item) => item.startsWith(`${name}=`));
  return part?.slice(name.length + 1);
}

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", ...securityHeaders() });
  response.end(JSON.stringify(body));
}

export function isSessionRole(role: unknown): role is Session["role"] {
  return role === "admin" || role === "reporter";
}

export async function sessionFor(request: IncomingMessage): Promise<Session | null> {
  const token = cookieValue(request, "dcc_session");
  if (!token) return null;
  const result = await pool.query(
    `SELECT s.id,s.user_id,s.csrf_token_hash,u.username,u.role FROM admin_sessions s
     JOIN users u ON u.id=s.user_id
     WHERE s.token_hash=$1 AND s.invalidated_at IS NULL AND s.expires_at>now() AND u.is_active=true`,
    [createHash("sha256").update(token).digest("hex")],
  );
  const session = result.rows[0];
  return session && isSessionRole(session.role) ? session : null;
}

export async function requireSession(request: IncomingMessage, response: ServerResponse): Promise<Session | null> {
  const session = await sessionFor(request);
  if (!session) {
    json(response, 401, { error: "authentication required" });
    return null;
  }
  if (!safeMethods.has(request.method ?? "GET")) {
    const csrf = request.headers["x-csrf-token"];
    if (typeof csrf !== "string" || !csrfMatches(csrf, session.csrf_token_hash)) {
      json(response, 403, { error: "invalid CSRF token" });
      return null;
    }
  }
  return session;
}

export async function requireAdmin(request: IncomingMessage, response: ServerResponse): Promise<Session | null> {
  const session = await requireSession(request, response);
  if (!session) return null;
  if (session.role !== "admin") {
    json(response, 403, { error: "administrator access required" });
    return null;
  }
  return session;
}

export function assertAdmin(session: Session) {
  if (session.role !== "admin") throw Object.assign(new Error("administrator access required"), { status: 403 });
}
