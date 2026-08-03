import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { artifactDataRoot, readArtifact, reconcileArtifacts, stageArtifact } from "./artifacts.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root() {
  const directory = await mkdtemp(join(tmpdir(), "dcc-artifact-round1-"));
  roots.push(directory);
  return directory;
}

describe("artifact lifecycle corrections", () => {
  it("uses one data-root precedence rule for web, worker, and reconciliation", () => {
    expect(artifactDataRoot("/repo", { DCC_DATA_DIR: "/shared-data", DCC_DATA_ROOT: "/ignored" })).toBe("/shared-data");
    expect(artifactDataRoot("/repo", { DCC_DATA_DIR: "./data" })).toBe("/repo/data");
    expect(artifactDataRoot("/repo", { DCC_DATA_ROOT: "/state" })).toBe("/state/data");
    expect(artifactDataRoot("/repo", { DCC_DATA_ROOT: "." })).toBe("/repo/data");
    expect(artifactDataRoot("/repo", {})).toBe("/repo/data");
  });

  it("recovers an expired staged row when rename completed before the crash", async () => {
    const dataRoot = await root();
    const staged = await stageArtifact({
      root: dataRoot, id: "66666666-6666-4666-8666-666666666666", storagePath: "logs/recovered.log", content: Buffer.from("recover"),
    });
    await rename(staged.stagedPath, staged.storagePath);
    const finalized: string[] = [];
    const abandoned: string[] = [];

    await reconcileArtifacts({
      root: dataRoot,
      records: [{ id: staged.id, storage_path: staged.relativePath, status: "staged", expires_at: new Date(0) }],
      finalize: async (id) => { finalized.push(id); },
      abandon: async (id) => { abandoned.push(id); },
    });

    expect(finalized).toEqual([staged.id]);
    expect(abandoned).toEqual([]);
    await expect(readFile(staged.storagePath, "utf8")).resolves.toBe("recover");
  });

  it("abandons and refuses a registry path that reaches outside through a symlink", async () => {
    const dataRoot = await root();
    const outside = await root();
    const secret = join(outside, "secret.log");
    await writeFile(secret, "outside");
    await mkdir(join(dataRoot, "logs"));
    await symlink(secret, join(dataRoot, "logs", "escape.log"));
    const abandoned: string[] = [];

    await reconcileArtifacts({
      root: dataRoot,
      records: [{ id: "77777777-7777-4777-8777-777777777777", storage_path: "logs/escape.log", status: "finalized", expires_at: null }],
      finalize: async () => { throw new Error("not reached"); },
      abandon: async (id) => { abandoned.push(id); },
    });

    expect(abandoned).toEqual(["77777777-7777-4777-8777-777777777777"]);
    await expect(readArtifact(dataRoot, "logs/escape.log")).rejects.toThrow("artifact path escapes controlled root");
    await expect(readFile(secret, "utf8")).resolves.toBe("outside");
  });
});
