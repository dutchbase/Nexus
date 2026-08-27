import { expect, test } from "vitest";
import { PRODUCTION_PROMOTION_ALLOWLIST, findAllowlistEntry } from "./production-promotion-allowlist.ts";

test("va-jobs-platform is on the allowlist with the exact required repo/branch pair", () => {
  const entry = PRODUCTION_PROMOTION_ALLOWLIST.find((e) => e.projectSlug === "va-jobs-platform");
  expect(entry).toMatchObject({ owner: "dutchbase", repo: "va-jobs-platform", sourceBranch: "master", targetBranch: "production" });
});

test("findAllowlistEntry returns null for a project row not on the list", () => {
  const result = findAllowlistEntry("some-other-project", { id: "x", slug: "some-other-project" });
  expect(result).toBeNull();
});

test("findAllowlistEntry matches by slug even if the DB row's owner/repo were tampered with", () => {
  // The allowlist entry — not the DB row — is the source of truth for owner/repo/branches.
  const result = findAllowlistEntry("va-jobs-platform", { id: "x", slug: "va-jobs-platform" });
  expect(result?.owner).toBe("dutchbase");
});
