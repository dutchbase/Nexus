import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, test } from "vitest";
import { getGithubPolicyEnforcementMode, isPlaceholderRepositoryPath, normalizeAgentStartPath, validateAgentStartPath, validateProject } from "./index.ts";

const execGit = promisify(execFile);
const tempDirs: string[] = [];

async function initRepo() {
  const dir = await mkdtemp(join(tmpdir(), "dcc-git-status-"));
  tempDirs.push(dir);
  await execGit("git", ["init", "-b", "main", dir]);
  await execGit("git", ["-C", dir, "config", "user.email", "test@example.com"]);
  await execGit("git", ["-C", dir, "config", "user.name", "Test"]);
  return dir;
}

async function commitFile(dir: string, name: string, content: string) {
  await writeFile(join(dir, name), content);
  await execGit("git", ["-C", dir, "add", name]);
  await execGit("git", ["-C", dir, "commit", "-m", `add ${name}`]);
}

describe("planning agent start path", () => {
  it("normalizes blank input to no configured path", async () => {
    expect(normalizeAgentStartPath("  ")).toBeNull();
    expect(normalizeAgentStartPath("/workspace/planning")).toBe("/workspace/planning");
    await expect(validateAgentStartPath("   ")).resolves.toEqual([]);
  });

  it("accepts an absolute readable directory and rejects invalid configured paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "dcc-start-path-"));
    const directory = join(root, "planning");
    await mkdir(directory);

    await expect(validateAgentStartPath(directory)).resolves.toEqual([]);
    await expect(validateAgentStartPath("relative/path")).resolves.toEqual(["planning agent start path must be absolute"]);
    await expect(validateAgentStartPath(join(root, "missing"))).resolves.toEqual(["planning agent start path is not a readable and searchable directory"]);
  });

  it("rejects a non-string configured path", async () => {
    await expect(validateAgentStartPath(123 as never)).resolves.toEqual(["planning agent start path must be a string"]);
  });

  it.skipIf(process.platform === "win32")("rejects a directory that cannot be searched", async () => {
    const root = await mkdtemp(join(tmpdir(), "dcc-start-path-"));
    const directory = join(root, "not-searchable");
    await mkdir(directory);
    await chmod(directory, 0o600);

    await expect(validateAgentStartPath(directory)).resolves.toEqual(["planning agent start path is not a readable and searchable directory"]);
  });
});

test("defaults to auto when config_json has no github_policy key", () => {
  expect(getGithubPolicyEnforcementMode({})).toBe("auto");
  expect(getGithubPolicyEnforcementMode(null)).toBe("auto");
  expect(getGithubPolicyEnforcementMode(undefined)).toBe("auto");
});

test("reads a valid enforcement value", () => {
  expect(getGithubPolicyEnforcementMode({ github_policy: { enforcement: "required" } })).toBe("required");
  expect(getGithubPolicyEnforcementMode({ github_policy: { enforcement: "optional" } })).toBe("optional");
});

test("falls back to auto on an invalid/unexpected value", () => {
  expect(getGithubPolicyEnforcementMode({ github_policy: { enforcement: "bogus" } })).toBe("auto");
  expect(getGithubPolicyEnforcementMode({ github_policy: "not-an-object" })).toBe("auto");
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("git status categorization", () => {
  test("modified tracked file is categorized as modified, unstaged", async () => {
    const dir = await initRepo();
    await commitFile(dir, "file.txt", "hello\n");
    await writeFile(join(dir, "file.txt"), "changed\n");

    const result = await validateProject({ repositoryPath: dir, defaultBranch: "main", requireRemote: false });
    if (!result.ok) throw new Error("expected ok:true, got " + JSON.stringify(result));
    expect(result.changedFileDetail).toContainEqual({ path: "file.txt", status: "modified", staged: false });
  });

  test("staged modification is categorized as modified, staged", async () => {
    const dir = await initRepo();
    await commitFile(dir, "file.txt", "hello\n");
    await writeFile(join(dir, "file.txt"), "changed\n");
    await execGit("git", ["-C", dir, "add", "file.txt"]);

    const result = await validateProject({ repositoryPath: dir, defaultBranch: "main", requireRemote: false });
    if (!result.ok) throw new Error("expected ok:true, got " + JSON.stringify(result));
    expect(result.changedFileDetail).toContainEqual({ path: "file.txt", status: "modified", staged: true });
  });

  test("untracked file is categorized as untracked", async () => {
    const dir = await initRepo();
    await commitFile(dir, "committed.txt", "hi\n");
    await writeFile(join(dir, "new-file.txt"), "new\n");

    const result = await validateProject({ repositoryPath: dir, defaultBranch: "main", requireRemote: false });
    if (!result.ok) throw new Error("expected ok:true, got " + JSON.stringify(result));
    expect(result.changedFileDetail).toContainEqual({ path: "new-file.txt", status: "untracked", staged: false });
  });

  test("deleted tracked file is categorized as deleted", async () => {
    const dir = await initRepo();
    await commitFile(dir, "gone.txt", "bye\n");
    await rm(join(dir, "gone.txt"));

    const result = await validateProject({ repositoryPath: dir, defaultBranch: "main", requireRemote: false });
    if (!result.ok) throw new Error("expected ok:true, got " + JSON.stringify(result));
    expect(result.changedFileDetail).toContainEqual({ path: "gone.txt", status: "deleted", staged: false });
  });

  test("renamed staged file is categorized as renamed", async () => {
    const dir = await initRepo();
    await commitFile(dir, "renamed-from.txt", "content preserved across the rename\n");
    await execGit("git", ["-C", dir, "mv", "renamed-from.txt", "renamed-to.txt"]);

    const result = await validateProject({ repositoryPath: dir, defaultBranch: "main", requireRemote: false });
    if (!result.ok) throw new Error("expected ok:true, got " + JSON.stringify(result));
    expect(result.changedFileDetail).toContainEqual({ path: "renamed-to.txt", status: "renamed", staged: true });
  });

  test("unresolved merge conflict is categorized as conflicted, distinct from ordinary modifications", async () => {
    const dir = await initRepo();
    await commitFile(dir, "conflict.txt", "base\n");
    await execGit("git", ["-C", dir, "checkout", "-b", "feature"]);
    await writeFile(join(dir, "conflict.txt"), "feature change\n");
    await execGit("git", ["-C", dir, "commit", "-am", "feature change"]);
    await execGit("git", ["-C", dir, "checkout", "main"]);
    await writeFile(join(dir, "conflict.txt"), "main change\n");
    await execGit("git", ["-C", dir, "commit", "-am", "main change"]);
    await execGit("git", ["-C", dir, "merge", "feature"]).catch(() => {});

    const result = await validateProject({ repositoryPath: dir, defaultBranch: "main", requireRemote: false });
    if (!result.ok) throw new Error("expected ok:true, got " + JSON.stringify(result));
    expect(result.changedFileDetail).toContainEqual({ path: "conflict.txt", status: "conflicted", staged: false });
  });

  test("multiple dirty-state types in one repo are all grouped correctly", async () => {
    const dir = await initRepo();
    await commitFile(dir, "modified.txt", "original\n");
    await writeFile(join(dir, "modified.txt"), "changed\n");
    await writeFile(join(dir, "untracked.txt"), "new\n");
    await writeFile(join(dir, "added.txt"), "added\n");
    await execGit("git", ["-C", dir, "add", "added.txt"]);

    const result = await validateProject({ repositoryPath: dir, defaultBranch: "main", requireRemote: false });
    if (!result.ok) throw new Error("expected ok:true, got " + JSON.stringify(result));
    const statuses = result.changedFileDetail.map((entry) => entry.status).sort();
    expect(statuses).toEqual(["added", "modified", "untracked"].sort());
  });

  // Without `-z`, git C-quotes these: `"a b.txt"` and `"caf\303\251.txt"`,
  // which the diagnostics list would render verbatim instead of the names the
  // user would have to type to resolve them.
  test("paths with spaces and non-ASCII characters keep their real names", async () => {
    const dir = await initRepo();
    await commitFile(dir, "seed.txt", "hi\n");
    await writeFile(join(dir, "a b.txt"), "x\n");
    await writeFile(join(dir, "café.txt"), "x\n");

    const result = await validateProject({ repositoryPath: dir, defaultBranch: "main", requireRemote: false });
    if (!result.ok) throw new Error("expected ok:true, got " + JSON.stringify(result));
    expect(result.changedFileDetail.map((entry) => entry.path).sort()).toEqual(["a b.txt", "café.txt"]);
    expect(result.changedFiles.sort()).toEqual(["a b.txt", "café.txt"]);
  });

  test("a rename reports only the new path, not the consumed original record", async () => {
    const dir = await initRepo();
    await commitFile(dir, "old name.txt", "hello\n");
    await execGit("git", ["-C", dir, "mv", "old name.txt", "new name.txt"]);

    const result = await validateProject({ repositoryPath: dir, defaultBranch: "main", requireRemote: false });
    if (!result.ok) throw new Error("expected ok:true, got " + JSON.stringify(result));
    expect(result.changedFileDetail).toEqual([{ path: "new name.txt", status: "renamed", staged: true }]);
  });

  test("clean repository returns an empty changedFileDetail and valid:true", async () => {
    const dir = await initRepo();
    await commitFile(dir, "file.txt", "hello\n");

    const result = await validateProject({ repositoryPath: dir, defaultBranch: "main", requireRemote: false });
    if (!result.ok) throw new Error("expected ok:true, got " + JSON.stringify(result));
    expect(result.changedFileDetail).toEqual([]);
    expect(result.valid).toBe(true);
  });
});

describe("isPlaceholderRepositoryPath", () => {
  it("flags the known va-jobs-platform seed placeholder", () => {
    expect(isPlaceholderRepositoryPath("/PLACEHOLDER/set-a-real-local-clone-path-for-va-jobs-platform")).toBe(true);
  });
  it("flags any /PLACEHOLDER/ prefixed path, case-insensitively", () => {
    expect(isPlaceholderRepositoryPath("/placeholder/anything-else")).toBe(true);
    expect(isPlaceholderRepositoryPath("/PLACEHOLDER/anything-else")).toBe(true);
  });
  it("flags empty, whitespace-only, and nullish paths", () => {
    expect(isPlaceholderRepositoryPath("")).toBe(true);
    expect(isPlaceholderRepositoryPath("   ")).toBe(true);
    expect(isPlaceholderRepositoryPath(null)).toBe(true);
    expect(isPlaceholderRepositoryPath(undefined)).toBe(true);
  });
  it("does not flag a real absolute path", () => {
    expect(isPlaceholderRepositoryPath("/home/deploy/projects/va-jobs-platform")).toBe(false);
  });
});

describe("validateProject placeholder rejection", () => {
  it("returns errorCode placeholder_path without ever calling stat/realpath on a placeholder path", async () => {
    const result = await validateProject({ repositoryPath: "/PLACEHOLDER/set-a-real-local-clone-path-for-va-jobs-platform", defaultBranch: "master" });
    expect(result).toEqual({ ok: false, errorCode: "placeholder_path", message: "repository path is a placeholder and has not been configured" });
  });
  it("returns errorCode path_not_configured for an empty repositoryPath", async () => {
    const result = await validateProject({ repositoryPath: "", defaultBranch: "master" });
    expect(result).toEqual({ ok: false, errorCode: "path_not_configured", message: "repository path is not configured" });
  });
});

describe("inspection failure handling", () => {
  test("nonexistent repository path returns ok:false, errorCode:'path_missing', not repository_dirty", async () => {
    const result = await validateProject({ repositoryPath: "/nonexistent/path/dcc-test-" + Date.now(), defaultBranch: "main" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorCode).toBe("path_missing");
  });

  test("a directory that exists but is not a git repository returns errorCode:'not_a_repo'", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dcc-not-a-repo-"));
    tempDirs.push(dir);

    const result = await validateProject({ repositoryPath: dir, defaultBranch: "main" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorCode).toBe("not_a_repo");
  });
});

describe("validateProject real-path regression (no false positives)", () => {
  it("does not flag a real, existing directory as a placeholder", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const exec = promisify(execFile);
    const dir = await mkdtemp(join(tmpdir(), "dcc-real-repo-"));
    try {
      await exec("git", ["-C", dir, "init", "-q"]);
      await exec("git", ["-C", dir, "commit", "--allow-empty", "-q", "-m", "init"]);
      await exec("git", ["-C", dir, "branch", "-m", "master"]);
      const result = await validateProject({ repositoryPath: dir, defaultBranch: "master", requireRemote: false });
      expect(result.ok).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("path changes are picked up on the next call -- no caching inside validateProject", async () => {
    const first = await validateProject({ repositoryPath: "/PLACEHOLDER/anything", defaultBranch: "master" });
    expect(first).toMatchObject({ ok: false, errorCode: "placeholder_path" });
    const second = await validateProject({ repositoryPath: "/definitely/does/not/exist/on/this/machine", defaultBranch: "master" });
    expect(second).toMatchObject({ ok: false, errorCode: "path_missing" });
  });
});
