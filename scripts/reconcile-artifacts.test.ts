import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({ query: vi.fn(), end: vi.fn() }));

vi.mock("../packages/database/src/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../packages/database/src/index.ts")>()),
  pool: database,
}));

const previousDataDir = process.env.DCC_DATA_DIR;
const previousDataRoot = process.env.DCC_DATA_ROOT;
let temporary = "";

afterEach(async () => {
  database.query.mockReset();
  database.end.mockReset();
  delete process.env.DCC_DATA_DIR;
  delete process.env.DCC_DATA_ROOT;
  if (previousDataDir !== undefined) process.env.DCC_DATA_DIR = previousDataDir;
  if (previousDataRoot !== undefined) process.env.DCC_DATA_ROOT = previousDataRoot;
  if (temporary) await rm(temporary, { recursive: true, force: true });
});

it("reconciles primary and legacy artifacts only from their registered roots", async () => {
  temporary = await mkdtemp(join(tmpdir(), "dcc-reconcile-roots-"));
  const primaryRoot = join(temporary, "primary");
  const legacyBase = join(temporary, "legacy-base");
  const legacyRoot = join(legacyBase, "data");
  await Promise.all([mkdir(join(primaryRoot, "logs"), { recursive: true }), mkdir(join(legacyRoot, "logs"), { recursive: true })]);
  await Promise.all([
    writeFile(join(primaryRoot, "logs", "primary.log"), "primary bytes"),
    writeFile(join(legacyRoot, "logs", "legacy.log"), "legacy bytes"),
    writeFile(join(primaryRoot, "logs", "legacy-missing.log"), "wrong-root bytes"),
  ]);
  process.env.DCC_DATA_DIR = primaryRoot;
  process.env.DCC_DATA_ROOT = legacyBase;
  const records = [
    { id: "11111111-1111-4111-8111-111111111111", storage_path: "logs/primary.log", storage_root: "primary", status: "staged", expires_at: null },
    { id: "22222222-2222-4222-8222-222222222222", storage_path: "logs/legacy.log", storage_root: "legacy", status: "staged", expires_at: null },
    { id: "33333333-3333-4333-8333-333333333333", storage_path: "logs/legacy-missing.log", storage_root: "legacy", status: "finalized", expires_at: null },
  ];
  const finalized = new Map<string, string>();
  const abandoned: string[] = [];
  database.query.mockImplementation(async (sql: string, values?: unknown[]) => {
    if (sql.startsWith("SELECT")) return { rows: records };
    if (sql.includes("status='finalized'")) finalized.set(values![0] as string, values![1] as string);
    if (sql.includes("status='abandoned'")) abandoned.push(values![0] as string);
    return { rowCount: 1, rows: [] };
  });

  await import("./reconcile-artifacts.ts");

  expect(finalized).toEqual(new Map([
    [records[0].id, createHash("sha256").update("primary bytes").digest("hex")],
    [records[1].id, createHash("sha256").update("legacy bytes").digest("hex")],
  ]));
  expect(abandoned).toEqual([records[2].id]);
  expect(database.end).toHaveBeenCalledOnce();
});
