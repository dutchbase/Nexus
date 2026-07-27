import type pg from "pg";
import { inTransaction, pool } from "@dcc/database";

export type JobInput = {
  type: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  priority?: "low" | "normal" | "high";
  maxAttempts?: number;
  availableAt?: Date;
};

export async function enqueueJob(input: JobInput, client?: pg.PoolClient) {
  const db = client ?? pool;
  const result = await db.query(
    `INSERT INTO jobs (type, status, priority, payload_json, idempotency_key, max_attempts, available_at)
     VALUES ($1, 'queued', $2, $3, $4, $5, COALESCE($6, now()))
     ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
     RETURNING *`,
    [input.type, input.priority ?? "normal", input.payload, input.idempotencyKey, input.maxAttempts ?? 3, input.availableAt],
  );
  return result.rows[0];
}

export async function claimJob(workerId: string, supportedTypes: string[]) {
  if (supportedTypes.length === 0) return null;
  return inTransaction(async (client) => {
    const result = await client.query(
      `WITH candidate AS (
         SELECT id FROM jobs
         WHERE status = 'queued'
           AND type = ANY($2::text[])
           AND COALESCE(available_at, now()) <= now()
         ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE jobs j
       SET status = 'running', claimed_at = now(), claimed_by = $1,
           attempt = attempt + 1, updated_at = now()
       FROM candidate
       WHERE j.id = candidate.id AND j.status = 'queued'
       RETURNING j.*`,
      [workerId, supportedTypes],
    );
    return result.rows[0] ?? null;
  });
}

export async function completeJob(id: string, workerId: string) {
  await pool.query(
    `UPDATE jobs SET status = 'completed', completed_at = now(), updated_at = now()
     WHERE id = $1 AND status = 'running' AND claimed_by = $2`,
    [id, workerId],
  );
}

export async function failJob(id: string, workerId: string, error: unknown) {
  const message = error instanceof Error ? error.message : "job failed";
  await pool.query(
    `UPDATE jobs SET
       status = CASE WHEN attempt < max_attempts THEN 'queued' ELSE 'failed' END,
       available_at = CASE WHEN attempt < max_attempts THEN now() + make_interval(secs => LEAST(300, power(2, attempt)::integer)) ELSE available_at END,
       claimed_at = NULL, claimed_by = NULL,
       completed_at = CASE WHEN attempt < max_attempts THEN NULL ELSE now() END,
       error_json = jsonb_build_object('message', $3::text), updated_at = now()
     WHERE id = $1 AND status = 'running' AND claimed_by = $2`,
    [id, workerId, message],
  );
}
