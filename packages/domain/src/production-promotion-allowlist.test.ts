import { expect, test } from "vitest";
import { PRODUCTION_PROMOTION_ALLOWLIST, allowlistMismatches, findAllowlistEntry } from "./production-promotion-allowlist.ts";

const vaJobsPlatform = PRODUCTION_PROMOTION_ALLOWLIST.find((entry) => entry.projectSlug === "va-jobs-platform")!;
const matchingRow = { owner: "dutchbase", repo: "va-jobs-platform", sourceBranch: "master", targetBranch: "production" };

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

test("allowlistMismatches reports nothing when the project row still matches the entry", () => {
  expect(allowlistMismatches(vaJobsPlatform, matchingRow)).toEqual([]);
});

test("allowlistMismatches names every field the project row disagrees on", () => {
  expect(allowlistMismatches(vaJobsPlatform, { ...matchingRow, repo: "some-other-repo" })).toEqual(["github_repository"]);
  expect(allowlistMismatches(vaJobsPlatform, { ...matchingRow, owner: "attacker" })).toEqual(["github_owner"]);
  expect(allowlistMismatches(vaJobsPlatform, { ...matchingRow, sourceBranch: "main" })).toEqual(["default_branch"]);
  expect(allowlistMismatches(vaJobsPlatform, { ...matchingRow, targetBranch: "master" })).toEqual(["production_branch"]);
  expect(allowlistMismatches(vaJobsPlatform, { owner: "a", repo: "b", sourceBranch: "c", targetBranch: "d" }))
    .toEqual(["github_owner", "github_repository", "default_branch", "production_branch"]);
});

test("allowlistMismatches treats a null/missing project field as a mismatch", () => {
  expect(allowlistMismatches(vaJobsPlatform, { ...matchingRow, owner: null })).toEqual(["github_owner"]);
  expect(allowlistMismatches(vaJobsPlatform, { ...matchingRow, targetBranch: undefined })).toEqual(["production_branch"]);
});
