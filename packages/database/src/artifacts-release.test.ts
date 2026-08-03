import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { finalizeArtifact, readStagedArtifact, reconcileArtifacts, stageArtifact } from "./artifacts.ts";

describe("release artifact recovery", () => {
  it("serves an active staged log and still finalizes it", async () => {
    const root = await mkdtemp(join(tmpdir(), "dcc-active-log-"));
    try {
      const staged = await stageArtifact({
        root, id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", storagePath: "logs/run.log", content: Buffer.from("live output"),
      });
      await expect(readStagedArtifact(root, staged.id).then((content) => content.toString("utf8"))).resolves.toBe("live output");
      await expect(finalizeArtifact(staged)).resolves.toMatchObject({ id: staged.id });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a staged finalized file recoverable when finalization persistence fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "dcc-finalize-retry-"));
    const id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    try {
      const staged = await stageArtifact({ root, id, storagePath: "logs/retry.log", content: Buffer.from("retry") });
      await finalizeArtifact(staged);
      const abandoned: string[] = [];
      await reconcileArtifacts({
        root, records: [{ id, storage_path: staged.relativePath, status: "staged", expires_at: new Date(Date.now() + 60_000) }],
        finalize: async () => { throw new Error("database unavailable"); },
        abandon: async (artifactId) => { abandoned.push(artifactId); },
      });
      expect(abandoned).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
