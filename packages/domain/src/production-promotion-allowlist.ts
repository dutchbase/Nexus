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
