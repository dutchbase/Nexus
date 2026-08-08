import type pg from "pg";
import { inTransaction, pool } from "@dcc/database";
export * from "./prompts.ts";
export * from "./approval-input-snapshot.ts";
export * from "./plan-approval.ts";
export * from "./pull-request.ts";
export * from "./pull-request-sync.ts";
export * from "./pull-request-policy.ts";
export * from "./pr-merge.ts";
export * from "./notifications.ts";
export * from "./pr-review.ts";
export * from "./pr-review-publication.ts";
export * from "./pr-conflict-resolution.ts";
export * from "./follow-up-ticket.ts";
export * from "./planning-inputs.ts";

export const aiModels = ["fable", "opus", "sonnet", "haiku", "deepseek-v4-flash", "deepseek-v4-pro"] as const;
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
  // Both run via the OpenCode CLI — see apps/worker/src/opencode.ts.
  "deepseek-v4-flash": ["low", "medium", "high"],
  "deepseek-v4-pro": ["low", "medium", "high"],
};

export const deepSeekModels: readonly AiModel[] = ["deepseek-v4-flash", "deepseek-v4-pro"];
export function isDeepSeekModel(model: string): boolean {
  return (deepSeekModels as readonly string[]).includes(model);
}

export const aiProviders = ["anthropic", "deepseek"] as const;
export type AiProvider = typeof aiProviders[number];
export const aiInvocationPhases = ["planning", "plan_revision", "execution", "execution.repair", "pr_ai_review", "pr_follow_up_description", "pr_conflict_resolution"] as const;
export type AiInvocationPhase = typeof aiInvocationPhases[number];
export type AiLifecycleGroup = "planning" | "execution" | "pr_work";
export type AiUsageStatus = "pending" | "captured" | "unavailable";
export type AiUsage = {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  rawUsage: unknown;
};
export type AiQueryClient = { query: (sql: string, values?: unknown[]) => Promise<{ rows: any[] }> };

export function providerForModel(model: string): AiProvider {
  if ((deepSeekModels as readonly string[]).includes(model)) return "deepseek";
  if ((aiModels as readonly string[]).includes(model)) return "anthropic";
  throw new AiConfigurationError(`Unsupported model "${model}"`);
}

export function aiLifecycleGroup(runType: string): AiLifecycleGroup {
  if (runType === "planning" || runType === "plan_revision") return "planning";
  if (runType === "execution" || runType === "execution.repair") return "execution";
  return "pr_work";
}

export async function createAiInvocation(input: {
  id: string;
  ticketId?: string | null;
  projectId: string;
  pullRequestId?: string | null;
  runType: AiInvocationPhase;
  model: AiModel;
  reasoningLevel: ReasoningLevel;
  taskPrompt?: string | null;
  promptSnapshotId?: string | null;
  startedAt?: Date;
}, client: AiQueryClient = pool) {
  const result = await client.query(
    `INSERT INTO agent_runs
       (id,ticket_id,project_id,pull_request_id,run_type,status,model,reasoning_level,provider,task_prompt,prompt_snapshot_id,started_at,ai_usage_status)
     VALUES ($1,$2,$3,$4,$5,'running',$6,$7,$8,$9,$10,COALESCE($11,now()),'pending')
     RETURNING *`,
    [input.id, input.ticketId ?? null, input.projectId, input.pullRequestId ?? null, input.runType,
      input.model, input.reasoningLevel, providerForModel(input.model), input.taskPrompt ?? null,
      input.promptSnapshotId ?? null, input.startedAt ?? null],
  );
  return result.rows[0];
}

async function withAiAccountingTransaction<T>(client: AiQueryClient | undefined, work: (db: AiQueryClient) => Promise<T>) {
  return client ? work(client) : inTransaction((db) => work(db));
}

export async function recordAiUsage(input: { runId: string } & AiUsage, client?: AiQueryClient) {
  const inputTokens = input.inputTokens;
  const outputTokens = input.outputTokens;
  const reasoningTokens = input.reasoningTokens ?? 0;
  const cacheReadTokens = input.cacheReadTokens ?? 0;
  const cacheWriteTokens = input.cacheWriteTokens ?? 0;
  const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
  return withAiAccountingTransaction(client, async (db) => {
    const run = (await db.query("SELECT * FROM agent_runs WHERE id=$1 FOR UPDATE", [input.runId])).rows[0];
    if (!run || run.ai_usage_status !== "pending") return run;
    const price = (await db.query(
      `SELECT * FROM ai_model_prices
       WHERE model=$1 AND effective_from <= $2
       ORDER BY effective_from DESC LIMIT 1`,
      [run.model, run.started_at],
    )).rows[0];
    return (await db.query(
      `UPDATE agent_runs SET
         ai_usage_status='captured', input_tokens=$2, output_tokens=$3, reasoning_tokens=$4,
         cache_read_tokens=$5, cache_write_tokens=$6, total_tokens=$7, raw_usage_json=$8,
         ai_model_price_id=$9,
         estimated_cost_usd=CASE WHEN $9::uuid IS NULL THEN NULL ELSE
           ($2 * $10 + $3 * $11 + $5 * $12 + $6 * $13) / 1000000 END
       WHERE id=$1 RETURNING *`,
      [input.runId, inputTokens, outputTokens, reasoningTokens, cacheReadTokens, cacheWriteTokens, totalTokens,
        input.rawUsage, price?.id ?? null, price?.input_usd_per_million ?? null, price?.output_usd_per_million ?? null,
        price?.cache_read_usd_per_million ?? null, price?.cache_write_usd_per_million ?? null],
    )).rows[0];
  });
}

export async function recordAiUnavailable(runId: string, client?: AiQueryClient) {
  return withAiAccountingTransaction(client, async (db) => {
    const run = (await db.query("SELECT * FROM agent_runs WHERE id=$1 FOR UPDATE", [runId])).rows[0];
    if (!run || run.ai_usage_status !== "pending") return run;
    return (await db.query(
      "UPDATE agent_runs SET ai_usage_status='unavailable' WHERE id=$1 RETURNING *",
      [runId],
    )).rows[0];
  });
}

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
  result = overlay(result, input.system[input.phase]);
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
  rerunOf?: string;
  priority?: "low" | "normal" | "high";
  maxAttempts?: number;
  availableAt?: Date;
};

export async function enqueueJob(input: JobInput, client?: pg.PoolClient) {
  const db = client ?? pool;
  if (input.rerunOf) {
    const source = await db.query(
      `SELECT 1 FROM jobs WHERE id = $1 AND status IN ('completed', 'failed', 'cancelled', 'blocked_auth', 'blocked_auth_configuration')`,
      [input.rerunOf],
    );
    if (source.rowCount !== 1) throw new Error("rerun source must be terminal");
  }
  const result = await db.query(
    `INSERT INTO jobs (type, status, priority, payload_json, idempotency_key, max_attempts, available_at, rerun_of)
     VALUES ($1, 'queued', $2, $3, $4, $5, COALESCE($6, now()), $7)
     ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
     RETURNING *`,
    [input.type, input.priority ?? "normal", input.payload, input.idempotencyKey, input.maxAttempts ?? 3, input.availableAt, input.rerunOf ?? null],
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
           lease_expires_at = now() + interval '60 seconds',
           attempt = attempt + 1, updated_at = now()
       FROM candidate
       WHERE j.id = candidate.id AND j.status = 'queued'
       RETURNING j.*`,
      [workerId, supportedTypes],
    );
    return result.rows[0] ?? null;
  });
}

// Worker heartbeat: the worker process upserts its own row into `workers`
// every WORKER_HEARTBEAT_INTERVAL_MS regardless of whether it is claiming
// jobs, so health can be inferred from process liveness instead of from
// job-claim activity (an idle-but-alive worker no longer looks stale, and a
// dead worker stops looking healthy WORKER_STALE_AFTER_MS after its last
// heartbeat rather than after its last job).
export const WORKER_HEARTBEAT_INTERVAL_MS = 10_000;
export const WORKER_STALE_AFTER_MS = 45_000;

export async function recordWorkerHeartbeat(id: string, capabilities: string[], version: string | null): Promise<void> {
  await pool.query(
    `INSERT INTO workers (id, capabilities, version)
     VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET heartbeat_at = now(), capabilities = EXCLUDED.capabilities, version = EXCLUDED.version`,
    [id, capabilities, version],
  );
}

export async function renewJobLease(id: string, workerId: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE jobs SET lease_expires_at = now() + interval '60 seconds', updated_at = now()
     WHERE id = $1 AND status = 'running' AND claimed_by = $2 AND lease_expires_at > now()`,
    [id, workerId],
  );
  return result.rowCount === 1;
}

export async function completeJob(id: string, workerId: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE jobs SET status = 'completed', completed_at = now(), claimed_by = NULL,
       lease_expires_at = NULL, updated_at = now()
     WHERE id = $1 AND status = 'running' AND claimed_by = $2 AND lease_expires_at > now()`,
    [id, workerId],
  );
  return result.rowCount === 1;
}

export async function failJob(id: string, workerId: string, error: unknown): Promise<boolean> {
  const message = error instanceof Error ? error.message : "job failed";
  const result = await pool.query(
    `UPDATE jobs SET
       status = CASE WHEN attempt < max_attempts THEN 'queued' ELSE 'failed' END,
       available_at = CASE WHEN attempt < max_attempts THEN now() + make_interval(secs => LEAST(300, power(2, attempt)::integer)) ELSE available_at END,
       claimed_at = NULL, claimed_by = NULL, lease_expires_at = NULL,
       completed_at = CASE WHEN attempt < max_attempts THEN NULL ELSE now() END,
       error_json = jsonb_build_object('message', $3::text), updated_at = now()
     WHERE id = $1 AND status = 'running' AND claimed_by = $2 AND lease_expires_at > now()`,
    [id, workerId, message],
  );
  return result.rowCount === 1;
}
