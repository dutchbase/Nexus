import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { reconcileArtifacts } from "./artifacts.ts";

describe("artifact reconciliation final wave", () => {
  it("reaps an old, unregistered controlled staging file without touching active records", async () => {
    const root = await mkdtemp(join(tmpdir(), "dcc-artifact-orphan-"));
    const orphanId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const activeId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    try {
      const staging = join(root, ".staged");
      await writeFile(join(staging, orphanId), "orphan").catch(async () => {
        const { mkdir } = await import("node:fs/promises");
        await mkdir(staging, { recursive: true });
        await writeFile(join(staging, orphanId), "orphan");
      });
      await writeFile(join(staging, activeId), "active");
      const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
      await utimes(join(staging, orphanId), old, old);

      await reconcileArtifacts({
        root,
        records: [{ id: activeId, storage_path: "logs/active.log", status: "staged", expires_at: new Date(Date.now() + 60_000) }],
        finalize: async () => {},
        abandon: async () => {},
      });

      await expect(import("node:fs/promises").then(({ access }) => access(join(staging, orphanId)))).rejects.toThrow();
      await expect(import("node:fs/promises").then(({ readFile }) => readFile(join(staging, activeId), "utf8"))).resolves.toBe("active");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
