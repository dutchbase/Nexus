import { beforeEach, expect, test, vi } from "vitest";

const events: string[] = [];
const removeArtifactFile = vi.fn(async () => { events.push("remove"); });
const tx = { query: vi.fn() };
let commitError: Error | null = null;

vi.mock("@dcc/database", () => ({
  inTransaction: async (callback: (client: typeof tx) => unknown) => {
    events.push("begin");
    const result = await callback(tx);
    if (commitError) throw commitError;
    events.push("commit");
    return result;
  },
  removeArtifactFile,
}));

const { expireUnclaimedUploads } = await import("./ticket-upload-maintenance.ts");

beforeEach(() => {
  events.length = 0;
  commitError = null;
  removeArtifactFile.mockClear();
  tx.query.mockReset();
});

test("commits abandonment before deleting bytes", async () => {
  const db = { query: vi.fn(async (sql: string) => {
    if (sql.includes("SELECT u.id")) return { rows: [{ id: "upload" }] };
    events.push("clear");
    return { rows: [], rowCount: 1 };
  }) };
  tx.query.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM attachments")) return { rows: [{ id: "attachment", ticket_id: null }] };
    if (sql.includes("FROM uploads")) return { rows: [{ id: "upload" }] };
    if (sql.includes("FROM artifacts")) return { rows: [{ id: "artifact", storage_root: "primary", storage_path: "uploads/image.png" }] };
    events.push("abandon");
    return { rows: [], rowCount: 1 };
  });

  await expect(expireUnclaimedUploads(db as any, { primary: "/data", legacy: "/legacy" })).resolves.toBe(1);
  expect(events).toEqual(["begin", "abandon", "commit", "remove", "clear"]);
});

test("a claim won during candidate scanning prevents cleanup", async () => {
  const db = { query: vi.fn().mockResolvedValue({ rows: [{ id: "upload" }] }) };
  tx.query.mockResolvedValueOnce({ rows: [{ id: "attachment", ticket_id: "ticket" }] });

  await expect(expireUnclaimedUploads(db as any, { primary: "/data", legacy: "/legacy" })).resolves.toBe(0);
  expect(removeArtifactFile).not.toHaveBeenCalled();
});

test("does not delete bytes when the abandonment transaction fails to commit", async () => {
  const db = { query: vi.fn().mockResolvedValue({ rows: [{ id: "upload" }] }) };
  tx.query
    .mockResolvedValueOnce({ rows: [{ id: "attachment", ticket_id: null }] })
    .mockResolvedValueOnce({ rows: [{ id: "upload" }] })
    .mockResolvedValueOnce({ rows: [{ id: "artifact", storage_root: "primary", storage_path: "uploads/image.png" }] })
    .mockResolvedValueOnce({ rows: [], rowCount: 1 });
  commitError = new Error("commit failed");

  await expect(expireUnclaimedUploads(db as any, { primary: "/data", legacy: "/legacy" })).rejects.toThrow("commit failed");
  expect(removeArtifactFile).not.toHaveBeenCalled();
});
