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
  skills: readonly { slug: string; version: string | null; contentHash: string; sources: readonly string[] }[];
  policySources: readonly ApprovalInputValue[];
};

function stableJson(value: ApprovalInputValue): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as { readonly [key: string]: ApprovalInputValue };
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const byCanonicalValue = <T extends ApprovalInputValue>(left: T, right: T) => stableJson(left).localeCompare(stableJson(right));

export function canonicalApprovedInput(input: ApprovedInputSnapshot) {
  return {
    plan: input.plan,
    ticket: input.ticket,
    project: { configVersion: input.project.configVersion, config: input.project.config },
    models: input.models,
    prompts: [...input.prompts]
      .sort((left, right) => left.phase.localeCompare(right.phase))
      .map((prompt) => ({ ...prompt, provenance: [...prompt.provenance].sort(byCanonicalValue) })),
    skills: [...input.skills]
      .map((skill) => ({ ...skill, sources: [...skill.sources].sort() }))
      .sort(byCanonicalValue),
    policySources: [...input.policySources].sort(byCanonicalValue),
  } satisfies ApprovalInputValue;
}

export function approvedInputHash(input: ApprovedInputSnapshot) {
  return createHash("sha256").update(stableJson(canonicalApprovedInput(input))).digest("hex");
}
