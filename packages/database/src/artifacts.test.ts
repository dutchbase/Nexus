import { mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { finalizeArtifact, reconcileArtifacts, stageArtifact } from "./artifacts.ts";

let root = "";

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = "";
});

describe("artifact lifecycle", () => {
  it("stages under the controlled root, finalizes atomically, and records a SHA-256", async () => {
    root = await mkdtemp(join(tmpdir(), "dcc-artifacts-"));
    const staged = await stageArtifact({
      root,
      id: "11111111-1111-4111-8111-111111111111",
      storagePath: "uploads/example.txt",
      content: Buffer.from("hello"),
    });

    expect(await readFile(staged.stagedPath, "utf8")).toBe("hello");
    const finalized = await finalizeArtifact(staged);

    expect(finalized.storagePath).toBe(join(root, "uploads", "example.txt"));
    expect(finalized.sha256).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    await expect(readFile(finalized.storagePath, "utf8")).resolves.toBe("hello");
    await expect(readFile(staged.stagedPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects paths that escape the controlled root", async () => {
    root = await mkdtemp(join(tmpdir(), "dcc-artifacts-"));

    await expect(stageArtifact({
      root,
      id: "22222222-2222-4222-8222-222222222222",
      storagePath: "../outside.txt",
      content: Buffer.from("no"),
    })).rejects.toThrow("artifact path escapes controlled root");
  });

  it("reconciles a rename crash and abandons missing or expired active artifacts", async () => {
    root = await mkdtemp(join(tmpdir(), "dcc-artifacts-"));
    const renamed = await stageArtifact({
      root,
      id: "33333333-3333-4333-8333-333333333333",
      storagePath: "logs/renamed.log",
      content: Buffer.from("hello"),
    });
    await rename(renamed.stagedPath, renamed.storagePath);
    const expired = await stageArtifact({
      root,
      id: "55555555-5555-4555-8555-555555555555",
      storagePath: "uploads/expired.png",
      content: Buffer.from("expired"),
    });
    const records = [
      { id: renamed.id, storage_path: "logs/renamed.log", status: "staged" as const, expires_at: null },
      { id: "44444444-4444-4444-8444-444444444444", storage_path: "logs/missing.log", status: "finalized" as const, expires_at: null },
      { id: expired.id, storage_path: expired.relativePath, status: "staged" as const, expires_at: new Date(0) },
    ];
    const finalized: Array<{ id: string; sha256: string }> = [];
    const abandoned: string[] = [];

    await reconcileArtifacts({
      root,
      records,
      finalize: async (id, sha256) => { finalized.push({ id, sha256 }); },
      abandon: async (id) => { abandoned.push(id); return true; },
    });

    expect(finalized).toEqual([{
      id: renamed.id,
      sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    }]);
    expect(abandoned).toEqual(["44444444-4444-4444-8444-444444444444", expired.id]);
    await expect(readFile(expired.stagedPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
