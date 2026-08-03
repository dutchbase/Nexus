import type pg from "pg";
import { inTransaction, pool } from "@dcc/database";
export * from "./prompts.ts";
export * from "./approval-input-snapshot.ts";
export * from "./plan-approval.ts";
export * from "./pull-request.ts";
export * from "./pull-request-sync.ts";
export * from "./pr-merge.ts";
export * from "./notifications.ts";
export * from "./pr-review.ts";
export * from "./pr-conflict-resolution.ts";
export * from "./follow-up-ticket.ts";

export const aiModels = ["fable", "opus", "sonnet", "haiku"] as const;
export const reasoningLevels = ["low", "medium", "high", "xhigh", "max", "ultracode"] as const;
export type AiModel = typeof aiModels[number];
export type ReasoningLevel = typeof reasoningLevels[number];
export type AiPhase = "planning" | "execution" | "repair";
export type AiSelection = { model?: string | null; reasoning_level?: string | null };
export type AiConfiguration = {
  default?: AiSelection;
  planning?: AiSelection;
  execution?: AiSelection;
  repair?: AiSelection;
};

const supportedReasoning: Record<AiModel, readonly ReasoningLevel[]> = {
  haiku: ["low", "medium", "high"],
  sonnet: ["low", "medium", "high", "xhigh"],
  opus: ["low", "medium", "high", "xhigh", "max"],
  fable: reasoningLevels,
};

export class AiConfigurationError extends Error {
  status = 422;
  code = "invalid_ai_configuration";
}

export function validateAiSelection(selection: { model: string; reasoning_level: string }) {
  if (!aiModels.includes(selection.model as AiModel)) {
    throw new AiConfigurationError(`Unsupported model "${selection.model}"`);
  }
  if (!reasoningLevels.includes(selection.reasoning_level as ReasoningLevel)) {
    throw new AiConfigurationError(`Unsupported reasoning level "${selection.reasoning_level}"`);
  }
  if (!supportedReasoning[selection.model as AiModel].includes(selection.reasoning_level as ReasoningLevel)) {
    throw new AiConfigurationError(
      `Invalid model/reasoning combination: ${selection.model} does not support ${selection.reasoning_level}`,
    );
  }
  return selection as { model: AiModel; reasoning_level: ReasoningLevel };
}

function overlay(base: AiSelection, next?: AiSelection) {
  return {
    model: next?.model ?? base.model,
    reasoning_level: next?.reasoning_level ?? base.reasoning_level,
  };
}

export function resolveAiConfiguration(input: {
  phase: AiPhase;
  system: AiConfiguration;
  project?: AiConfiguration;
  ticket?: AiConfiguration;
}) {
  let result = overlay({}, input.system.default);
  result = overlay(result, input.project?.default);
  result = overlay(result, input.project?.[input.phase]);
  result = overlay(result, input.ticket?.default);
  result = overlay(result, input.ticket?.[input.phase]);
  if (!result.model || !result.reasoning_level) {
    throw new AiConfigurationError(`Incomplete AI configuration for ${input.phase}`);
  }
  return validateAiSelection({ model: result.model, reasoning_level: result.reasoning_level });
}

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
