import { reviewedHeadShaForMerge } from "@dcc/domain";
import { skillsForPhase, type SkillPhase, type SnapshottedSkill } from "@dcc/skill-registry";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

export function executionRoot(configured = path.join(tmpdir(), "dcc-execution")) {
  const root = path.resolve(configured);
  const relative = path.relative(homedir(), root);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    throw new Error("execution root must be outside the host home");
  }
  return root;
}

export function approvedPhaseSkills(
  snapshot: { ticket_id?: string; skills_json?: SnapshottedSkill[] } | null,
  ticketId: string,
  phase: SkillPhase,
) {
  if (!snapshot || snapshot.ticket_id !== ticketId || !Array.isArray(snapshot.skills_json)) {
    throw new Error("approved skill snapshot is unavailable");
  }
  return skillsForPhase(snapshot.skills_json, phase);
}

export function assertApprovedSkillSnapshot(
  approved: readonly {
    readonly id: string; readonly slug: string; readonly version: string | null; readonly contentHash: string;
    readonly sources: readonly string[]; readonly filesystemPath: string; readonly phase: string;
    readonly phases: readonly string[]; readonly pluginName: string | null; readonly invocationName: string | null;
    readonly configuration: unknown;
  }[],
  snapshot: { skills_json?: SnapshottedSkill[]; content_hash?: string } | null,
) {
  const fail = () => { throw new Error("approved skill snapshot integrity check failed"); };
  if (!snapshot || !Array.isArray(snapshot.skills_json) || typeof snapshot.content_hash !== "string") {
    throw new Error("approved skill snapshot integrity check failed");
  }
  const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
  const stored = snapshot.skills_json;
  const rebuilt = stored.map((skill) => {
    if (!Array.isArray(skill.files) || !Array.isArray(skill.resolution_sources)) fail();
    const files = skill.files.map((file) => {
      if (typeof file.path !== "string" || typeof file.content_base64 !== "string" || typeof file.content_hash !== "string") fail();
      const bytes = Buffer.from(file.content_base64, "base64");
      if (bytes.toString("base64") !== file.content_base64 || hash(bytes) !== file.content_hash) fail();
      return { path: file.path, content_base64: file.content_base64, content_hash: file.content_hash };
    });
    if (hash(JSON.stringify(files)) !== skill.content_hash) fail();
    return {
      skill_id: skill.skill_id,
      slug: skill.slug,
      version: skill.version,
      filesystem_path: skill.filesystem_path,
      resolution_sources: skill.resolution_sources,
      phase: skill.phase,
      ...(skill.phases === undefined ? {} : { phases: skill.phases }),
      ...(skill.plugin_name === undefined ? {} : { plugin_name: skill.plugin_name }),
      ...(skill.invocation_name === undefined ? {} : { invocation_name: skill.invocation_name }),
      ...(skill.configuration_json === undefined ? {} : { configuration_json: skill.configuration_json }),
      files,
      content_hash: skill.content_hash,
    };
  });
  if (hash(JSON.stringify(rebuilt)) !== snapshot.content_hash) fail();
  const normalize = (skills: readonly any[]) => skills
    .map((skill) => {
      if (!Array.isArray(skill.sources) || !Array.isArray(skill.phases)) fail();
      return { ...skill, sources: [...skill.sources].sort(), phases: [...skill.phases].sort() };
    })
    .sort((left, right) => left.slug.localeCompare(right.slug));
  const actual = normalize(stored.map((skill) => ({
    id: skill.skill_id, slug: skill.slug, version: skill.version, contentHash: skill.content_hash,
    sources: skill.resolution_sources, filesystemPath: skill.filesystem_path, phase: skill.phase,
    phases: skill.phases ?? [skill.phase], pluginName: skill.plugin_name ?? null,
    invocationName: skill.invocation_name ?? null, configuration: skill.configuration_json ?? {},
  })));
  if (JSON.stringify(normalize(approved)) !== JSON.stringify(actual)) {
    fail();
  }
}

export function approvedExecutionInput(snapshot: {
  id: string;
  inputHash: string;
  materialInput: any;
}, phase: "execution" | "repair", details: {
  worktreePath: string;
  branchName: string;
  baseCommit: string | null;
  currentDiff?: string;
  validationOutput?: unknown;
  administratorFeedback?: string;
}) {
  const material = snapshot.materialInput;
  const config = material?.project?.config;
  const ai = material?.models?.[phase];
  const prompt = material?.prompts?.find((item: any) => item.phase === phase);
  if (!config?.enabled || !config.repositoryPath || !config.defaultBranch || !ai?.model || !ai.reasoningLevel || !prompt?.content) {
    throw new Error("approved execution input is incomplete");
  }
  const runtime = [
    "## Runtime worktree details", `\`\`\`json\n${JSON.stringify({ path: details.worktreePath, branch: details.branchName, base_commit: details.baseCommit }, null, 2)}\n\`\`\``,
  ];
  if (phase === "repair") runtime.push(
    "## Current worktree diff", details.currentDiff ?? "",
    "## Failed validation output", `\`\`\`json\n${JSON.stringify(details.validationOutput ?? {}, null, 2)}\n\`\`\``,
    "## Administrator feedback", details.administratorFeedback ?? "",
  );
  return {
    approvedInputSnapshotId: snapshot.id,
    inputHash: snapshot.inputHash,
    project: {
      config_version: material.project.configVersion,
      config_json: config.configuration ?? {},
      slug: config.slug,
      name: config.name,
      description: config.description,
      enabled: config.enabled,
      repository_path: config.repositoryPath,
      agent_start_path: config.agentStartPath ?? config.repositoryPath,
      default_branch: config.defaultBranch,
      github_owner: config.githubOwner,
      github_repository: config.githubRepository,
    },
    ai: { model: ai.model, reasoning_level: ai.reasoningLevel },
    promptVersionIds: Object.fromEntries(prompt.provenance.map((source: any) => [`${source.scope}.${source.promptType}`, source.versionId])),
    content: `${prompt.content.trimEnd()}\n\n${runtime.join("\n\n")}\n`,
  };
}

export function assertExecutionPublicationGate(repairing: boolean, usedAgent: boolean) {
  if (!repairing && !usedAgent) throw new Error("execution did not invoke Agent tool");
}

export function reviewedMergeBinding(
  mode: "review_only" | "review_and_merge",
  verdict: "approved" | "rejected",
  reviewedHeadSha: string,
  reviewedBaseBranch: string,
  reviewedBaseSha: string,
) {
  const expectedHeadSha = reviewedHeadShaForMerge(mode, verdict, reviewedHeadSha);
  return expectedHeadSha ? { expectedHeadSha, expectedBaseBranch: reviewedBaseBranch, expectedBaseSha: reviewedBaseSha } : null;
}

export function prReviewSnapshotInput(input: {
  projectId: string;
  content: string;
  model: string;
  reasoningLevel: string;
  promptVersionIds: Record<string, string>;
  pullRequestId: string;
  reviewedHeadSha: string;
  reviewedBaseBranch: string;
  reviewedBaseSha: string;
}) {
  return {
    ticketId: null,
    projectId: input.projectId,
    phase: "pr-review" as const,
    content: input.content,
    model: input.model,
    reasoningLevel: input.reasoningLevel,
    metadata: {
      promptVersionIds: input.promptVersionIds,
      pullRequestId: input.pullRequestId,
      reviewedHeadSha: input.reviewedHeadSha,
      reviewedBaseBranch: input.reviewedBaseBranch,
      reviewedBaseSha: input.reviewedBaseSha,
    },
  };
}
