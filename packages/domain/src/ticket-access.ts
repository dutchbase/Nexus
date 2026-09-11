type QueryClient = { query: (sql: string, values?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

export type TicketActor = { userId: string; role: "admin" | "reporter" };
export type SubmissionFields = {
  title: string; description: string; category?: string | null; priority?: string | null;
  source_url?: string | null; environment?: string | null; expected_behavior?: string | null;
  actual_behavior?: string | null; reproduction_steps?: string | null;
  jam_url?: string | null;
  submission?: Record<string, string | boolean | string[]>;
};
export type TicketAttachment = {
  id: string; upload_id: string; field_key: string; original_name: string | null;
  media_type: string; size_bytes: number; url: string;
};
export type ReporterTicket = {
  id: string; ticket_number: string; project_id: string; project_name: string;
  title: string; description: string | null; category: string | null; priority: string | null;
  source_url: string | null; environment: string | null; expected_behavior: string | null;
  actual_behavior: string | null; reproduction_steps: string | null;
  jam_url: string | null; jam_import: { state: import("./ticket-jam.ts").JamState; message: string } | null;
  submission: Record<string, string | boolean | string[]>;
  submission_revision: number; submission_updated_at: string; created_at: string;
  can_delete: boolean; attachments: TicketAttachment[];
};

function fail(message: string, status: number): never {
  throw Object.assign(new Error(message), { status });
}

export async function lockTicketActor(client: QueryClient, actor: TicketActor): Promise<void> {
  const user = (await client.query("SELECT role,is_active FROM users WHERE id=$1 FOR UPDATE", [actor.userId])).rows[0];
  if (!user?.is_active) fail("authentication required", 401);
  if (user.role !== actor.role || !["admin", "reporter"].includes(user.role)) fail("access denied", 403);
}

export async function requireProjectAccess(client: QueryClient, actor: TicketActor, projectId: string): Promise<void> {
  const sql = actor.role === "admin"
    ? "SELECT id,enabled FROM projects WHERE id=$1"
    : `SELECT p.id,p.enabled FROM projects p JOIN project_memberships m ON m.project_id=p.id
       WHERE p.id=$1 AND m.user_id=$2`;
  const project = (await client.query(sql, actor.role === "admin" ? [projectId] : [projectId, actor.userId])).rows[0];
  if (!project) fail("project not found", 404);
}

export async function ticketForActor(client: QueryClient, actor: TicketActor, ref: string, lock = false): Promise<any | null> {
  const access = actor.role === "admin" ? "" : `AND EXISTS (
    SELECT 1 FROM project_memberships m WHERE m.project_id=t.project_id AND m.user_id=$2
  )`;
  const values = actor.role === "admin" ? [ref] : [ref, actor.userId];
  return (await client.query(
    `SELECT t.*,p.name AS project_name,j.state AS jam_state FROM tickets t JOIN projects p ON p.id=t.project_id
     LEFT JOIN ticket_jam_contexts j ON j.ticket_id=t.id
     WHERE (t.id::text=$1 OR t.ticket_number=$1) AND t.submitter_deleted_at IS NULL ${access}
     ${lock ? "FOR UPDATE OF t" : ""}`,
    values,
  )).rows[0] ?? null;
}

function timestamp(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

export function reporterTicket(row: any, actor: TicketActor, fields: any[]): ReporterTicket {
  const custom = row.custom_values_json && typeof row.custom_values_json === "object" ? row.custom_values_json : {};
  const submission = Object.fromEntries(fields
    .filter((field) => !["hidden", "static", "image_upload"].includes(field.field_type) && field.field_key in custom)
    .map((field) => [field.field_key, custom[field.field_key]])
    .filter(([, value]) => typeof value === "string" || typeof value === "boolean" || (Array.isArray(value) && value.every((item) => typeof item === "string"))));
  return {
    id: row.id, ticket_number: row.ticket_number, project_id: row.project_id, project_name: row.project_name,
    title: row.title, description: row.description ?? null, category: row.category ?? null, priority: row.priority ?? null,
    source_url: row.source_url ?? null, environment: row.environment ?? null,
    expected_behavior: row.expected_behavior ?? null, actual_behavior: row.actual_behavior ?? null,
    reproduction_steps: row.reproduction_steps ?? null, jam_url: row.jam_url ?? null,
    jam_import: row.jam_state ? { state: row.jam_state, message: row.jam_state === "ready" ? "Technical details imported" : row.jam_state === "partial" ? "Some technical details imported" : row.jam_state === "failed" ? "Technical details could not be imported" : row.jam_state === "not_configured" ? "Jam import is not configured" : "Technical details import in progress" } : null, submission,
    submission_revision: Number(row.submission_revision), submission_updated_at: timestamp(row.submission_updated_at),
    created_at: timestamp(row.created_at), can_delete: actor.role === "reporter" && row.created_by_user_id === actor.userId,
    attachments: Array.isArray(row.attachments) ? row.attachments : [],
  };
}
