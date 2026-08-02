import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { importSuperpowers } from "./update-superpowers.ts";
import { buildAgentContentCatalog, readImportedAgentContentCatalog, syncAgentContent } from "./sync-agent-content.ts";

const directories: string[] = [];
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "superpowers-content-"));
  directories.push(root);
  const checkout = join(root, "checkout");
  await mkdir(join(checkout, "skills", "writing-plans"), { recursive: true });
  await mkdir(join(checkout, "skills", "test-driven-development"), { recursive: true });
  await writeFile(join(checkout, "package.json"), JSON.stringify({ version: "4.1.0", license: "MIT" }));
  await writeFile(join(checkout, "LICENSE"), "MIT License\n");
  await writeFile(join(checkout, "skills", "writing-plans", "SKILL.md"), "---\nname: writing-plans\ndescription: Plans work\n---\n# Plans\n");
  await writeFile(join(checkout, "skills", "test-driven-development", "SKILL.md"), "---\nname: test-driven-development\ndescription: Tests first\n---\n# TDD\n");
  execFileSync("git", ["init", "--quiet", "--initial-branch=release", checkout]);
  execFileSync("git", ["-C", checkout, "add", "."]);
  execFileSync("git", ["-C", checkout, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--quiet", "-m", "release"]);
  execFileSync("git", ["-C", checkout, "tag", "-a", "v4.1.0", "-m", "release"]);
  return { root, checkout };
}

afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe("Superpowers content", () => {
  it("imports only the manifest allowlist and replaces stale vendored files deterministically", async () => {
    const { root, checkout } = await fixture();
    const manifest = {
      superpowers: {
        repository: "obra/superpowers", tag: "v4.1.0",
        source: { type: "git", license: "MIT" },
        skills: { planning: ["writing-plans"], execution: ["test-driven-development"], repair: [], inspiration_only: [] },
      },
    };
    const destination = join(root, "skills", "vendor", "superpowers");
    await mkdir(join(destination, "stale"), { recursive: true });
    await writeFile(join(destination, "stale", "SKILL.md"), "stale");

    const first = await importSuperpowers({ manifest, checkout, destination, repositoryRoot: root });
    const second = await importSuperpowers({ manifest, checkout, destination, repositoryRoot: root });

    expect(first).toEqual(second);
    expect(first.skills.map((skill) => skill.slug)).toEqual(["test-driven-development", "writing-plans"]);
    await expect(readFile(join(destination, "stale", "SKILL.md"))).rejects.toThrow();
    await expect(readFile(join(destination, "writing-plans", "SKILL.md"), "utf8")).resolves.toContain("# Plans");
    expect(JSON.parse(await readFile(join(destination, "catalog.json"), "utf8"))).toEqual(first);
  });

  it("rejects a same-version checkout whose HEAD is not the pinned tag", async () => {
    const { root, checkout } = await fixture();
    await writeFile(join(checkout, "README.md"), "not the tagged release\n");
    execFileSync("git", ["-C", checkout, "add", "README.md"]);
    execFileSync("git", ["-C", checkout, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--quiet", "-m", "not release"]);
    const manifest = { superpowers: { repository: "obra/superpowers", tag: "v4.1.0", source: { type: "git", license: "MIT" }, skills: { planning: ["writing-plans"] } } };

    await expect(importSuperpowers({ manifest, checkout, destination: join(root, "skills", "vendor", "superpowers"), repositoryRoot: root })).rejects.toThrow("pinned tag");
  });

  it("rejects a destination outside the vendor root before deleting files", async () => {
    const { root, checkout } = await fixture();
    const manifest = { superpowers: { repository: "obra/superpowers", tag: "v4.1.0", source: { type: "git", license: "MIT" }, skills: { planning: ["writing-plans"] } } };
    await writeFile(join(root, "keep.txt"), "keep\n");

    await expect(importSuperpowers({ manifest, checkout, destination: root, repositoryRoot: root })).rejects.toThrow("vendor root");
    await expect(readFile(join(root, "keep.txt"), "utf8")).resolves.toBe("keep\n");
  });

  it("uses the configured vendor path and rejects a stale imported catalog", async () => {
    const { root, checkout } = await fixture();
    await mkdir(join(root, "prompts", "global"), { recursive: true });
    await writeFile(join(root, "prompts", "global", "base.md"), "source prompt\n");
    const manifest = {
      superpowers: {
        repository: "obra/superpowers", tag: "v4.1.0", vendor_path: "skills/vendor/release",
        source: { type: "git", license: "MIT" }, skills: { planning: ["writing-plans"] },
      },
    };
    const destination = join(root, "skills", "vendor", "release");
    const catalog = await importSuperpowers({ manifest, checkout, destination, repositoryRoot: root });

    await expect(readImportedAgentContentCatalog({ root, manifest })).resolves.toMatchObject({ source: catalog.source });
    await writeFile(join(destination, "catalog.json"), JSON.stringify({ ...catalog, source: { ...catalog.source, tag: "v4.0.0" } }));
    await expect(readImportedAgentContentCatalog({ root, manifest })).rejects.toThrow("catalog source");
  });

  it("retains a manual active prompt when its tracked source hash is unchanged", async () => {
    const { root } = await fixture();
    await mkdir(join(root, "prompts", "global"), { recursive: true });
    await writeFile(join(root, "prompts", "global", "base.md"), "source prompt\n");
    const catalog = await buildAgentContentCatalog({ root, manifest: { superpowers: { tag: "v4.1.0" } }, skills: [] });
    const queries: string[] = [];
    const client = {
      async query(sql: string) {
        queries.push(sql);
        if (sql.includes("FROM agent_content")) return { rows: [{ sync: { catalog_hash: "old", prompt_hashes: { base: catalog.prompt_hashes.base } } }] };
        if (sql.includes("FROM prompt_files")) return { rows: [{ id: "prompt-1", active_version_id: "manual", content_hash: hash("manual prompt") }] };
        return { rows: [] };
      },
    };

    const result = await syncAgentContent(client, catalog);

    expect(result).toMatchObject({ promptsUpdated: 0, promptsPreserved: 1 });
    expect(queries.some((sql) => sql.startsWith("UPDATE prompt_files"))).toBe(false);
    expect(queries.some((sql) => sql.includes("INSERT INTO agent_content"))).toBe(true);
  });

  it("publishes a new immutable prompt version when the tracked source changes", async () => {
    const { root } = await fixture();
    await mkdir(join(root, "prompts", "global"), { recursive: true });
    await writeFile(join(root, "prompts", "global", "base.md"), "changed source\n");
    const catalog = await buildAgentContentCatalog({ root, manifest: { superpowers: { tag: "v4.1.0" } }, skills: [] });
    const calls: { sql: string; values?: unknown[] }[] = [];
    const client = {
      async query(sql: string, values?: unknown[]) {
        calls.push({ sql, values });
        if (sql.includes("FROM agent_content")) return { rows: [{ sync: { prompt_hashes: { base: hash("old source") } } }] };
        if (sql.includes("FROM prompt_files")) return { rows: [{ id: "prompt-1", active_content_hash: hash("manual prompt") }] };
        if (sql.includes("COALESCE(max(version)")) return { rows: [{ version: 2 }] };
        if (sql.includes("INSERT INTO prompt_versions")) return { rows: [{ id: "version-2" }] };
        return { rows: [] };
      },
    };

    expect(await syncAgentContent(client, catalog)).toMatchObject({ promptsUpdated: 1 });
    expect(calls.find((call) => call.sql.includes("INSERT INTO prompt_versions"))?.values).toContain("changed source\n");
    expect(calls.some((call) => call.sql.startsWith("UPDATE prompt_files"))).toBe(true);
  });

  it("disables removed Superpowers registry rows", async () => {
    const { root } = await fixture();
    await mkdir(join(root, "prompts", "global"), { recursive: true });
    await writeFile(join(root, "prompts", "global", "base.md"), "source prompt\n");
    const catalog = await buildAgentContentCatalog({ root, manifest: { superpowers: { tag: "v4.1.0" } }, skills: [] });
    const calls: { sql: string; values?: unknown[] }[] = [];
    const client = {
      async query(sql: string, values?: unknown[]) {
        calls.push({ sql, values });
        if (sql.includes("FROM agent_content")) return { rows: [{ sync: { prompt_hashes: catalog.prompt_hashes } }] };
        return { rows: [] };
      },
    };

    await syncAgentContent(client, catalog);

    expect(calls.find((call) => call.sql.startsWith("UPDATE skills SET enabled=false"))?.values).toEqual([[]]);
  });
});
