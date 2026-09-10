import { inTransaction, pool } from "@dcc/database";
import { lockTicketActor } from "@dcc/domain";
import { hashPassword, validatePassword } from "../../../packages/database/src/password.ts";
import { assertAdmin, type Session } from "./session.ts";

export type ReporterInput = { username: string; password: string; project_ids: string[] };
export type ReporterUpdate = { is_active?: boolean; project_ids?: string[] };
export type ReporterView = {
  id: string; username: string; is_active: boolean; role: "reporter"; project_ids: string[];
  created_at: string; last_login_at: string | null;
};

const usernamePattern = /^[A-Za-z0-9._-]{3,80}$/;
const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function fail(message: string, status = 422): never {
  throw Object.assign(new Error(message), { status });
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("request body must be an object");
  return value as Record<string, unknown>;
}

function allowOnly(value: Record<string, unknown>, allowed: string[]) {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length) fail(`unknown field: ${extra[0]}`);
}

function projectIds(value: unknown) {
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || !uuidPattern.test(id))) fail("project_ids must contain valid project IDs");
  return [...new Set(value as string[])];
}

function password(value: unknown) {
  if (typeof value !== "string" || value.length < 12) fail("password must be at least 12 characters");
  try { validatePassword(value); } catch (error) { fail((error as Error).message); }
  return value;
}

function createInput(value: unknown): ReporterInput {
  const input = record(value);
  allowOnly(input, ["username", "password", "project_ids"]);
  const username = typeof input.username === "string" ? input.username.trim() : "";
  if (!usernamePattern.test(username)) fail("username must be 3–80 ASCII letters, digits, dots, underscores, or hyphens");
  return { username, password: password(input.password), project_ids: projectIds(input.project_ids) };
}

function updateInput(value: unknown): ReporterUpdate {
  const input = record(value);
  allowOnly(input, ["is_active", "project_ids"]);
  if (!Object.keys(input).length) fail("at least one field is required");
  if (input.is_active !== undefined && typeof input.is_active !== "boolean") fail("is_active must be a boolean");
  return {
    ...(input.is_active === undefined ? {} : { is_active: input.is_active }),
    ...(input.project_ids === undefined ? {} : { project_ids: projectIds(input.project_ids) }),
  };
}

function reporter(row: any): ReporterView {
  return {
    id: row.id, username: row.username, is_active: row.is_active, role: "reporter",
    project_ids: row.project_ids ?? [],
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    last_login_at: row.last_login_at instanceof Date ? row.last_login_at.toISOString() : row.last_login_at ?? null,
  };
}

async function validateProjects(client: any, ids: string[]) {
  if (!ids.length) return;
  const found = await client.query("SELECT id FROM projects WHERE id=ANY($1::uuid[])", [ids]);
  if (found.rows.length !== ids.length) fail("one or more projects do not exist");
}

async function assignments(client: any, userId: string, ids: string[]) {
  await client.query("DELETE FROM project_memberships WHERE user_id=$1", [userId]);
  if (ids.length) await client.query(
    `INSERT INTO project_memberships(user_id,project_id)
     SELECT $1::uuid,id FROM projects WHERE id=ANY($2::uuid[]) ON CONFLICT DO NOTHING`,
    [userId, ids],
  );
}

async function audit(client: any, session: Session, action: string, userId: string, before: unknown, after: unknown) {
  await client.query(
    `INSERT INTO audit_events(actor_type,actor_id,action,entity_type,entity_id,before_json,after_json)
     VALUES ('admin',$1,$2,'user',$3,$4,$5)`,
    [session.user_id, action, userId, before, after],
  );
}

async function view(client: any, id: string) {
  const row = (await client.query(
    `SELECT u.id,u.username,u.is_active,u.created_at,u.last_login_at,
       COALESCE(array_agg(pm.project_id ORDER BY pm.project_id) FILTER (WHERE pm.project_id IS NOT NULL),'{}') project_ids
     FROM users u LEFT JOIN project_memberships pm ON pm.user_id=u.id
     WHERE u.id=$1 AND u.role='reporter' GROUP BY u.id`, [id],
  )).rows[0];
  return row ? reporter(row) : null;
}

export async function createReporter(session: Session, value: ReporterInput): Promise<ReporterView> {
  assertAdmin(session);
  const input = createInput(value);
  const passwordHash = await hashPassword(input.password);
  try {
    return await inTransaction(async (client) => {
      await lockTicketActor(client, { userId: session.user_id, role: session.role });
      await validateProjects(client, input.project_ids);
      const user = (await client.query(
        "INSERT INTO users(username,password_hash,role) VALUES($1,$2,'reporter') RETURNING id",
        [input.username, passwordHash],
      )).rows[0];
      await assignments(client, user.id, input.project_ids);
      const created = (await view(client, user.id))!;
      await audit(client, session, "reporter.create", user.id, null, { username: created.username, is_active: created.is_active, project_ids: created.project_ids });
      return created;
    });
  } catch (error: any) {
    if (error?.code === "23505") fail("username already exists", 409);
    throw error;
  }
}

export async function updateReporter(session: Session, id: string, value: ReporterUpdate): Promise<ReporterView> {
  assertAdmin(session);
  if (!uuidPattern.test(id)) fail("reporter not found", 404);
  const input = updateInput(value);
  return inTransaction(async (client) => {
    await lockTicketActor(client, { userId: session.user_id, role: session.role });
    const target = (await client.query("SELECT id,username,is_active FROM users WHERE id=$1 AND role='reporter' FOR UPDATE", [id])).rows[0];
    if (!target) fail("reporter not found", 404);
    if (input.project_ids) await validateProjects(client, input.project_ids);
    const beforeView = (await view(client, id))!;
    if (input.is_active !== undefined) await client.query("UPDATE users SET is_active=$2,updated_at=now() WHERE id=$1", [id, input.is_active]);
    if (input.project_ids) await assignments(client, id, input.project_ids);
    if (input.is_active === false) await client.query("UPDATE admin_sessions SET invalidated_at=now() WHERE user_id=$1 AND invalidated_at IS NULL", [id]);
    const updated = (await view(client, id))!;
    await audit(client, session, "reporter.update", id,
      { username: beforeView.username, is_active: beforeView.is_active, project_ids: beforeView.project_ids },
      { username: updated.username, is_active: updated.is_active, project_ids: updated.project_ids });
    return updated;
  });
}

export async function resetReporterPassword(session: Session, id: string, value: string): Promise<void> {
  assertAdmin(session);
  if (!uuidPattern.test(id)) fail("reporter not found", 404);
  const passwordHash = await hashPassword(password(value));
  await inTransaction(async (client) => {
    await lockTicketActor(client, { userId: session.user_id, role: session.role });
    const target = (await client.query("SELECT id,username,is_active FROM users WHERE id=$1 AND role='reporter' FOR UPDATE", [id])).rows[0];
    if (!target) fail("reporter not found", 404);
    await client.query("UPDATE users SET password_hash=$2,updated_at=now() WHERE id=$1", [id, passwordHash]);
    await client.query("UPDATE admin_sessions SET invalidated_at=now() WHERE user_id=$1 AND invalidated_at IS NULL", [id]);
    await audit(client, session, "reporter.password_reset", id, { username: target.username, is_active: target.is_active }, { username: target.username, is_active: target.is_active });
  });
}

export async function listReporters(session: Session): Promise<ReporterView[]> {
  assertAdmin(session);
  const rows = (await pool.query(
    `SELECT u.id,u.username,u.is_active,u.created_at,u.last_login_at,
       COALESCE(array_agg(pm.project_id ORDER BY pm.project_id) FILTER (WHERE pm.project_id IS NOT NULL),'{}') project_ids
     FROM users u LEFT JOIN project_memberships pm ON pm.user_id=u.id
     WHERE u.role='reporter' GROUP BY u.id ORDER BY u.username`,
  )).rows;
  return rows.map(reporter);
}
