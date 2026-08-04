import { expect, it, vi } from "vitest";
import { reclaimExpiredWorktrees } from "./cleanup-worktrees.ts";

function database(rows: any[]) {
  const query = vi.fn(async (sql: string) => {
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
    if (sql.includes("FOR UPDATE SKIP LOCKED")) return { rows: rows.splice(0, 1), rowCount: 1 };
    if (sql.includes("UPDATE execution_attempts")) return { rows: [], rowCount: 1 };
    throw new Error(`unexpected query: ${sql}`);
  });
  return { query, connect: async () => ({ query, release: vi.fn() }) };
}

it("does not reclaim a source attempt referenced by a live repair", async () => {
  const db = database([]);
  const remove = vi.fn();
  await expect(reclaimExpiredWorktrees({ db, dataRoot: "/data", remove })).resolves.toBe(0);
  const selection = db.query.mock.calls.find(([sql]) => sql.includes("FOR UPDATE SKIP LOCKED"))?.[0] as string;
  expect(selection).toContain("source_execution_attempt_id");
  expect(remove).not.toHaveBeenCalled();
});

it("claims an expired non-live worktree before removing and reclaiming it", async () => {
  const db = database([{ id: "attempt", worktree_path: "/data/worktrees/acme/DCC-1/1", repository_path: "/repo" }]);
  const remove = vi.fn(async () => undefined);
  await expect(reclaimExpiredWorktrees({ db, dataRoot: "/data", remove })).resolves.toBe(1);
  expect(remove).toHaveBeenCalledWith("/repo", "/data", "/data/worktrees/acme/DCC-1/1");
  const calls = db.query.mock.calls.map(([sql]) => sql as string);
  expect(calls.findIndex((sql) => sql.includes("FOR UPDATE SKIP LOCKED"))).toBeLessThan(calls.findIndex((sql) => sql.includes("UPDATE execution_attempts")));
});
