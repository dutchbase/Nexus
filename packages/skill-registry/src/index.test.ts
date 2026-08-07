import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { materializeSkillBundle, resolveSkills, SkillResolutionError, skillsForPhase, snapshotSkillSet, validateFilesystemPath, type ResolvedSkill } from "./index.ts";

const directories: string[] = [];

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "skill-registry-"));
  directories.push(root);
  await mkdir(path.join(root, "local"), { recursive: true });
  await mkdir(path.join(root, "vendor", "upstream"), { recursive: true });
  await writeFile(path.join(root, "local", "SKILL.md"), "# Local\n");
  await writeFile(path.join(root, "vendor", "upstream", "SKILL.md"), "# Upstream\n");
  return root;
}

afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

test("anchors relative skill roots to the repository when the worker changes cwd", async () => {
  const originalCwd = process.cwd();
  const originalSkillsRoot = process.env.DCC_SKILLS_ROOT;
  try {
    process.env.DCC_SKILLS_ROOT = ".";
    process.chdir(path.join(originalCwd, "apps", "worker"));

    const snapshot = await snapshotSkillSet([{
      id: "writing-plans", slug: "writing-plans", name: "Writing Plans",
      filesystem_path: "skills/vendor/superpowers/writing-plans/SKILL.md", enabled: true, version: null,
      resolution_sources: ["phase_required"],
    }], ["planning"]);

    expect(Buffer.from(snapshot.skills[0]?.files.find((file) => file.path === "SKILL.md")?.content_base64 ?? "", "base64").toString("utf8")).toContain("# Writing Plans");
  } finally {
    process.chdir(originalCwd);
    if (originalSkillsRoot === undefined) delete process.env.DCC_SKILLS_ROOT;
    else process.env.DCC_SKILLS_ROOT = originalSkillsRoot;
  }
});

test("snapshots phase metadata, keeps legacy skills in every phase, and materializes local and vendored skills", async () => {
  const root = await fixture();
  const skills: ResolvedSkill[] = [
    {
      id: "local", slug: "local", name: "Local", filesystem_path: "local/SKILL.md", enabled: true, version: null,
      resolution_sources: ["global_mandatory"], configuration_json: {}, source_type: "workspace_global",
    },
    {
      id: "upstream", slug: "upstream", name: "Upstream", filesystem_path: "vendor/upstream/SKILL.md", enabled: true, version: "v1",
      resolution_sources: ["phase_required"], configuration_json: { phases: ["planning"] }, source_type: "vendored",
    },
  ];

  const snapshot = await snapshotSkillSet(skills, ["planning", "execution"], root);

  expect(snapshot.skills.map((skill) => ({ slug: skill.slug, phases: skill.phases, plugin: skill.plugin_name, invocation: skill.invocation_name }))).toEqual([
    { slug: "local", phases: ["planning", "execution", "repair"], plugin: null, invocation: "local" },
    { slug: "upstream", phases: ["planning"], plugin: "superpowers", invocation: "superpowers:upstream" },
  ]);
  expect(skillsForPhase(snapshot.skills, "execution").map((skill) => skill.slug)).toEqual(["local"]);

  const bundle = await materializeSkillBundle("00000000-0000-0000-0000-000000000001", skillsForPhase(snapshot.skills, "planning"), root);

  expect(bundle.additionalDirectory).toBe(path.join(root, "data", "skill-bundles", "00000000-0000-0000-0000-000000000001"));
  expect(bundle.pluginDirectories).toEqual([
    path.join(bundle.additionalDirectory, "plugins", "dcc-local"),
    path.join(bundle.additionalDirectory, "plugins", "superpowers"),
  ]);
  await expect(readFile(path.join(bundle.pluginDirectories[0], ".claude-plugin", "plugin.json"), "utf8")).resolves.toContain('"name": "dcc-local"');
  await expect(readFile(path.join(bundle.pluginDirectories[0], "skills", "local", "SKILL.md"), "utf8")).resolves.toBe("# Local\n");
  await expect(readFile(path.join(bundle.additionalDirectory, ".claude", "skills", "local", "SKILL.md"), "utf8")).resolves.toBe("# Local\n");
  await expect(readFile(path.join(bundle.pluginDirectories[1], ".claude-plugin", "plugin.json"), "utf8")).resolves.toContain('"name": "superpowers"');
  await expect(readFile(path.join(bundle.pluginDirectories[1], "skills", "upstream", "SKILL.md"), "utf8")).resolves.toBe("# Upstream\n");
});

describe("skill bundles", () => {
  test("creates an empty bundle root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dcc-skill-bundle-"));
    directories.push(root);
    const bundle = await materializeSkillBundle("00000000-0000-0000-0000-000000000000", [], root);
    await expect(access(bundle.additionalDirectory)).resolves.toBeUndefined();
  });
});

describe("approval skill policy", () => {
  const skill = {
    id: "secure", slug: "secure", name: "Secure", filesystem_path: "secure/SKILL.md",
    enabled: true, version: "1", configuration_json: {},
  };

  test("rejects exclusion of an automatic skill when ticket overrides are disabled", () => {
    expect(() => resolveSkills([
      { skill, skillId: skill.id, source: "project_automatic", allowTicketOverride: false },
      { skill, skillId: skill.id, source: "ticket_excluded" },
    ], "project", "planning")).toThrow(SkillResolutionError);
  });

  test("excludes an automatic skill when ticket overrides are enabled", () => {
    expect(resolveSkills([
      { skill, skillId: skill.id, source: "project_automatic", allowTicketOverride: true },
      { skill, skillId: skill.id, source: "ticket_excluded" },
    ], "project", "planning")).toEqual([]);
  });

  test("does not mistake an explicit selection for an override", () => {
    expect(resolveSkills([
      { skill, skillId: skill.id, source: "project_automatic", allowTicketOverride: false },
      { skill, skillId: skill.id, source: "ticket_selected" },
    ], "project", "planning")[0]?.resolution_sources).toEqual(["project_automatic", "ticket_selected"]);
  });

  test("does not allow a ticket exclusion to remove a required project skill", () => {
    expect(resolveSkills([
      { skill, skillId: skill.id, source: "project_required", allowTicketOverride: true },
      { skill, skillId: skill.id, source: "ticket_excluded" },
    ], "project", "planning")[0]?.resolution_sources).toEqual(["project_required"]);
  });

  test.each([
    [null, "missing"],
    [{ ...skill, enabled: false }, "disabled"],
    [{ ...skill, configuration_json: { allowed_phases: ["execution"] } }, "incompatible"],
  ])("fails closed when a required skill is %s", (requiredSkill, reason) => {
    expect(() => resolveSkills([
      { skill: requiredSkill, skillId: skill.id, slug: skill.slug, source: "project_required" },
    ], "project", "planning")).toThrow(`Skill "secure" is ${reason}`);
  });
});

describe("validateFilesystemPath", () => {
  test.each(["personal_claude", "external_directory"])(
    "requires an absolute path for source type %s",
    (sourceType) => {
      expect(validateFilesystemPath(sourceType, "home/deploy/.claude/skills/example/SKILL.md")).toMatch(/must be an absolute path/);
      expect(validateFilesystemPath(sourceType, "/home/deploy/.claude/skills/example/SKILL.md")).toBeNull();
    },
  );

  test.each(["project_local", "repository"])(
    "rejects an absolute path for source type %s",
    (sourceType) => {
      expect(validateFilesystemPath(sourceType, "/home/deploy/.claude/skills/example/SKILL.md")).toMatch(/must be relative/);
      expect(validateFilesystemPath(sourceType, "skills/vendor/example/SKILL.md")).toBeNull();
    },
  );

  describe("workspace_global (ambiguous: may live in-repo under skills/, or be a truly external path)", () => {
    test("accepts an absolute path", () => {
      expect(validateFilesystemPath("workspace_global", "/home/deploy/.claude/skills/example/SKILL.md")).toBeNull();
    });

    test("accepts a repo-relative path under skills/ (matches this repo's skills/global/ convention)", () => {
      expect(validateFilesystemPath("workspace_global", "skills/global/ponytail/SKILL.md")).toBeNull();
    });

    test("rejects a relative path outside skills/ — the exact shape of the real incident", () => {
      expect(validateFilesystemPath("workspace_global", "home/deploy/.claude/skills/localos-skeleton-management/SKILL.md")).toMatch(/must be either an absolute path/);
    });
  });

  test("allows an unset or empty path (validated later when the skill is actually resolved)", () => {
    expect(validateFilesystemPath("workspace_global", null)).toBeNull();
    expect(validateFilesystemPath("workspace_global", undefined)).toBeNull();
    expect(validateFilesystemPath("workspace_global", "")).toBeNull();
  });

  test("treats an unrecognized source type as repo-relative", () => {
    expect(validateFilesystemPath("some_future_type", "/absolute/path/SKILL.md")).toMatch(/must be relative/);
  });

  test("rejects a non-string filesystem_path instead of throwing", () => {
    expect(validateFilesystemPath("workspace_global", 123 as unknown as string)).toMatch(/must be a string/);
  });
});
