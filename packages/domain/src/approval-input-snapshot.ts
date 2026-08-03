import { createHash } from "node:crypto";

export type ApprovalInputValue =
  | string | number | boolean | null
  | readonly ApprovalInputValue[]
  | { readonly [key: string]: ApprovalInputValue };

export type ApprovedInputSnapshot = {
  plan: { versionId: string; version: number; contentHash: string };
  ticket: ApprovalInputValue;
  project: { configVersion: number; config: ApprovalInputValue; lastValidatedAt?: string | null };
  models: Record<string, { model: string; reasoningLevel: string }>;
  prompts: readonly {
    phase: string;
    content: string;
    provenance: readonly { scope: string; promptType: string; versionId: string; contentHash: string }[];
  }[];
  skills: readonly {
    id: string;
    slug: string;
    version: string | null;
    contentHash: string;
    sources: readonly string[];
    filesystemPath: string;
    phase: string;
    phases: readonly string[];
    pluginName: string | null;
    invocationName: string | null;
    configuration: ApprovalInputValue;
  }[];
  policySources: readonly ApprovalInputValue[];
};

export class ApprovalPolicyError extends Error {
  status = 422;
  code = "approval_policy_failed";
}

export function requireApprovalPrompt<T extends { active_version_id?: string | null; content?: string | null }>(
  prompt: T | null | undefined,
  scope: string,
  promptType: string,
) {
  if (!prompt?.active_version_id || !prompt.content?.trim()) {
    throw new ApprovalPolicyError(`Active ${scope} ${promptType} prompt content is required`);
  }
  return prompt;
}

function canonicalNumber(value: number) {
  const json = JSON.stringify(value);
  if (!/[eE]/.test(json)) return json;
  const [coefficient, exponentText] = json.toLowerCase().split("e");
  const exponent = Number(exponentText);
  const negative = coefficient.startsWith("-");
  const unsigned = negative ? coefficient.slice(1) : coefficient;
  const [whole, fraction = ""] = unsigned.split(".");
  const digits = whole + fraction;
  const point = whole.length + exponent;
  const expanded = point <= 0
    ? `0.${"0".repeat(-point)}${digits}`
    : point >= digits.length
      ? `${digits}${"0".repeat(point - digits.length)}`
      : `${digits.slice(0, point)}.${digits.slice(point)}`;
  return negative ? `-${expanded}` : expanded;
}

function stableJson(value: ApprovalInputValue): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as { readonly [key: string]: ApprovalInputValue };
    return `{${Object.keys(object).sort(utf8Compare).map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
  }
  return typeof value === "number" ? canonicalNumber(value) : JSON.stringify(value);
}

const utf8Compare = (left: string, right: string) => Buffer.from(left).compare(Buffer.from(right));
const byCanonicalValue = <T extends ApprovalInputValue>(left: T, right: T) => utf8Compare(stableJson(left), stableJson(right));

export function canonicalApprovedInput(input: ApprovedInputSnapshot) {
  return {
    plan: input.plan,
    ticket: input.ticket,
    project: { configVersion: input.project.configVersion, config: input.project.config },
    models: input.models,
    prompts: input.prompts
      .map((prompt) => ({ ...prompt, provenance: [...prompt.provenance].sort(byCanonicalValue) }))
      .sort(byCanonicalValue),
    skills: [...input.skills]
      .map((skill) => ({ ...skill, sources: [...skill.sources].sort(utf8Compare) }))
      .sort(byCanonicalValue),
    policySources: [...input.policySources].sort(byCanonicalValue),
  } satisfies ApprovalInputValue;
}

export function approvedInputHash(input: ApprovedInputSnapshot) {
  return createHash("sha256").update(stableJson(canonicalApprovedInput(input))).digest("hex");
}

export function buildApprovedInputSnapshot(input: ApprovedInputSnapshot) {
  return { materialInput: canonicalApprovedInput(input), inputHash: approvedInputHash(input) };
}

export class ApprovalConflictError extends Error {
  status = 409;
  code = "approval_conflict";
  constructor(public currentSnapshotId: string | null) {
    super("the ticket or current plan changed before the approval decision completed");
  }
}

type QueryClient = { query: (text: string, values?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

export async function approvePlanDecision(client: QueryClient, input: {
  ticketId: string;
  planVersionId: string;
  expectedTicketVersion: Date | string;
  expectedStatus: string;
  expectedSnapshotId?: string | null;
  approvedInput: ApprovedInputSnapshot;
  decidedBy: string | null;
  skillSnapshotId: string | null;
  metadata?: ApprovalInputValue;
}) {
  const built = buildApprovedInputSnapshot(input.approvedInput);
  const approvedInputSnapshot = (await client.query(
    `INSERT INTO approved_input_snapshots
     (ticket_id,plan_version_id,material_input_json,input_hash,created_by,metadata_json)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [input.ticketId, input.planVersionId, built.materialInput, built.inputHash, input.decidedBy, input.metadata ?? {}],
  )).rows[0];
  const promptVersions = Object.fromEntries(input.approvedInput.prompts.flatMap((prompt) =>
    prompt.provenance.map((source) => [`${source.scope}.${source.promptType}`, source.versionId]),
  ));
  const ticket = (await client.query(
    `UPDATE tickets t SET approved_plan_version_id=$2,approved_plan_hash=$3,
       approved_ticket_version=$4,approved_project_config_version=$5,
       approved_model_config_json=$6,approved_skill_snapshot_id=$7,
       approved_prompt_versions_json=$8,approved_input_snapshot_id=$9,
       plan_approved_at=now(),status='Plan Approved',updated_at=now()
     WHERE t.id=$1 AND t.status=$10
       AND t.approved_input_snapshot_id IS NOT DISTINCT FROM $11::uuid
       AND t.updated_at=$4::timestamptz
       AND EXISTS (SELECT 1 FROM plans p WHERE p.ticket_id=t.id AND p.current_version_id=$2)
     RETURNING t.*`,
    [input.ticketId, input.planVersionId, input.approvedInput.plan.contentHash, input.expectedTicketVersion,
      input.approvedInput.project.configVersion, input.approvedInput.models, input.skillSnapshotId,
      promptVersions, approvedInputSnapshot.id, input.expectedStatus, input.expectedSnapshotId ?? null],
  )).rows[0];
  if (!ticket) {
    const current = (await client.query("SELECT approved_input_snapshot_id FROM tickets WHERE id=$1", [input.ticketId])).rows[0];
    throw new ApprovalConflictError(current?.approved_input_snapshot_id ?? null);
  }
  const decision = (await client.query(
    `INSERT INTO plan_approval_decisions
     (ticket_id,plan_version_id,approved_input_snapshot_id,decision,decided_by,metadata_json)
     VALUES ($1,$2,$3,'approved',$4,$5) RETURNING *`,
    [input.ticketId, input.planVersionId, approvedInputSnapshot.id, input.decidedBy, input.metadata ?? {}],
  )).rows[0];
  return { ticket, approvedInputSnapshot, decision };
}

export async function rejectPlanDecision(client: QueryClient, input: {
  ticketId: string;
  planVersionId: string;
  expectedTicketVersion: Date | string;
  expectedStatus: string;
  expectedSnapshotId: string | null;
  decidedBy: string | null;
  metadata?: ApprovalInputValue;
}) {
  const ticket = (await client.query(
    `UPDATE tickets t SET status='Rejected',approved_plan_version_id=NULL,
       approved_plan_hash=NULL,approved_ticket_version=NULL,approved_project_config_version=NULL,
       approved_model_config_json=NULL,approved_skill_snapshot_id=NULL,
       approved_prompt_versions_json=NULL,approved_input_snapshot_id=NULL,
       plan_approved_at=NULL,updated_at=now()
     WHERE t.id=$1 AND t.status=$4
       AND t.approved_input_snapshot_id IS NOT DISTINCT FROM $5::uuid
       AND t.updated_at=$3::timestamptz
       AND EXISTS (SELECT 1 FROM plans p WHERE p.ticket_id=t.id AND p.current_version_id=$2)
     RETURNING t.*`,
    [input.ticketId, input.planVersionId, input.expectedTicketVersion, input.expectedStatus, input.expectedSnapshotId],
  )).rows[0];
  if (!ticket) {
    const current = (await client.query("SELECT approved_input_snapshot_id FROM tickets WHERE id=$1", [input.ticketId])).rows[0];
    throw new ApprovalConflictError(current?.approved_input_snapshot_id ?? null);
  }
  const decision = (await client.query(
    `INSERT INTO plan_approval_decisions
     (ticket_id,plan_version_id,decision,decided_by,metadata_json)
     VALUES ($1,$2,'rejected',$3,$4) RETURNING *`,
    [input.ticketId, input.planVersionId, input.decidedBy, input.metadata ?? {}],
  )).rows[0];
  return { ticket, decision };
}

export async function requestPlanRevisionDecision(client: QueryClient, input: {
  ticketId: string;
  planVersionId: string;
  expectedTicketVersion: Date | string;
  expectedStatus: string;
  expectedSnapshotId: string | null;
}) {
  const ticket = (await client.query(
    `UPDATE tickets t SET status='Plan Revision Requested',approved_plan_version_id=NULL,
       approved_plan_hash=NULL,approved_ticket_version=NULL,approved_project_config_version=NULL,
       approved_model_config_json=NULL,approved_skill_snapshot_id=NULL,
       approved_prompt_versions_json=NULL,approved_input_snapshot_id=NULL,
       plan_approved_at=NULL,updated_at=now()
     WHERE t.id=$1 AND t.status=$4
       AND t.approved_input_snapshot_id IS NOT DISTINCT FROM $5::uuid
       AND t.updated_at=$3::timestamptz
       AND EXISTS (SELECT 1 FROM plans p WHERE p.ticket_id=t.id AND p.current_version_id=$2)
     RETURNING t.*`,
    [input.ticketId, input.planVersionId, input.expectedTicketVersion, input.expectedStatus, input.expectedSnapshotId],
  )).rows[0];
  if (!ticket) {
    const current = (await client.query("SELECT approved_input_snapshot_id FROM tickets WHERE id=$1", [input.ticketId])).rows[0];
    throw new ApprovalConflictError(current?.approved_input_snapshot_id ?? null);
  }
  return ticket;
}
