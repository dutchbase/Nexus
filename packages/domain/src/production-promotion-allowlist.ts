export type ProductionPromotionAllowlistEntry = {
  projectSlug: string; // matches projects.slug
  owner: string; // "dutchbase"
  repo: string; // "va-jobs-platform"
  sourceBranch: string; // "master"
  targetBranch: string; // "production"
  allowForce: boolean; // whether the promote-force route may act on this project
};

export const PRODUCTION_PROMOTION_ALLOWLIST: readonly ProductionPromotionAllowlistEntry[] = [
  { projectSlug: "va-jobs-platform", owner: "dutchbase", repo: "va-jobs-platform", sourceBranch: "master", targetBranch: "production", allowForce: true },
];

export function findAllowlistEntry(projectSlugOrId: string, projectRow: { slug: string; id: string }): ProductionPromotionAllowlistEntry | null {
  return PRODUCTION_PROMOTION_ALLOWLIST.find((entry) => entry.projectSlug === projectRow.slug || entry.projectSlug === projectSlugOrId) ?? null;
}

export type ProductionPromotionTarget = {
  owner: string | null | undefined;
  repo: string | null | undefined;
  sourceBranch: string | null | undefined;
  targetBranch: string | null | undefined;
};

// The allowlist entry — not the projects row — is the source of truth for
// which repository and branches a production promotion may ever touch.
// github_owner, github_repository, default_branch and config_json (which
// carries deployment.production_branch) are all editable through
// PATCH /api/admin/projects/:id, so the live values have to be compared back
// against the entry on every promotion rather than trusted. Returns the names
// of the fields that disagree; an empty array means the row still describes
// exactly the allowlisted repository and branch pair.
export function allowlistMismatches(
  entry: ProductionPromotionAllowlistEntry,
  target: ProductionPromotionTarget,
): string[] {
  const mismatched: string[] = [];
  if (target.owner !== entry.owner) mismatched.push("github_owner");
  if (target.repo !== entry.repo) mismatched.push("github_repository");
  if (target.sourceBranch !== entry.sourceBranch) mismatched.push("default_branch");
  if (target.targetBranch !== entry.targetBranch) mismatched.push("production_branch");
  return mismatched;
}
