import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { reconcileArtifacts } from "./artifacts.ts";

describe("artifact reconciliation final wave", () => {
  it("leaves records unchanged while their storage root is unavailable", async () => {
    const parent = await mkdtemp(join(tmpdir(), "dcc-artifact-offline-"));
    const abandoned: string[] = [];
    try {
      await reconcileArtifacts({
        root: join(parent, "unmounted"),
        records: [{ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", storage_path: "logs/final.log", status: "finalized", expires_at: null }],
        finalize: async () => {},
        abandon: async (id) => { abandoned.push(id); },
      });
      expect(abandoned).toEqual([]);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("does not abandon a missing staged path before its lease expires", async () => {
    const root = await mkdtemp(join(tmpdir(), "dcc-artifact-active-"));
    const abandoned: string[] = [];
    try {
      await reconcileArtifacts({
        root,
        records: [{ id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", storage_path: "logs/active.log", status: "staged", expires_at: new Date(Date.now() + 60_000) }],
        finalize: async () => {},
        abandon: async (id) => { abandoned.push(id); },
      });
      expect(abandoned).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps an expired staged file when another finalizer won the database transition", async () => {
    const root = await mkdtemp(join(tmpdir(), "dcc-artifact-race-"));
    const id = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    try {
      const staging = join(root, ".staged");
      await (await import("node:fs/promises")).mkdir(staging, { recursive: true });
      await writeFile(join(staging, id), "racing bytes");
      await reconcileArtifacts({
        root,
        records: [{ id, storage_path: "logs/racing.log", status: "staged", expires_at: new Date(0) }],
        finalize: async () => {},
        abandon: async () => false,
      });
      await expect((await import("node:fs/promises")).readFile(join(staging, id), "utf8")).resolves.toBe("racing bytes");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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
