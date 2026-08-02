import { reviewedHeadShaForMerge } from "@dcc/domain";
import { skillsForPhase, type SkillPhase, type SnapshottedSkill } from "@dcc/skill-registry";

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
