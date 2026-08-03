type Queryable = {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<{ deleted_count: number }> }>;
};

export async function cleanupExpiredSessions(db: Queryable): Promise<{ deletedCount: number }> {
  const result = await db.query(
    `WITH deleted AS (
       DELETE FROM admin_sessions WHERE expires_at <= now() RETURNING 1
     ), audit AS (
       INSERT INTO audit_events (actor_type, action, entity_type, metadata_json)
       SELECT 'system', 'admin_sessions.cleanup', 'admin_sessions', jsonb_build_object('deleted_count', count(*))
       FROM deleted
       RETURNING metadata_json
     )
     SELECT (metadata_json->>'deleted_count')::integer AS deleted_count FROM audit`,
  );
  return { deletedCount: result.rows[0]?.deleted_count ?? 0 };
}
