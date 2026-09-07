import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const [mode, primaryRoot, legacyRoot, ledgerPath, sourcePrimary, sourceLegacy] = process.argv.slice(2);
if (!new Set(["capture", "restore"]).has(mode) || !primaryRoot || !legacyRoot || !ledgerPath) {
  throw new Error("usage: verify-artifact-registry.mjs capture|restore PRIMARY LEGACY LEDGER [SOURCE_PRIMARY SOURCE_LEGACY]");
}

let input = "";
for await (const chunk of process.stdin) input += chunk;
const rows = input.split("\n").filter(Boolean).map((line) => JSON.parse(line));
const directoryTypes = new Set(["worktree", "conflict_worktree"]);
const fileTypes = new Set(["upload", "execution_log"]);
const roots = { primary: path.resolve(primaryRoot), legacy: path.resolve(legacyRoot) };
const sourceRoots = sourcePrimary && sourceLegacy
  ? { primary: path.resolve(sourcePrimary), legacy: path.resolve(sourceLegacy) }
  : undefined;

function targetFor(row, selectedRoots) {
  if (!(row.storage_root in selectedRoots) || typeof row.storage_path !== "string" || typeof row.id !== "string") {
    throw new Error(`invalid artifact registry row: ${row.id ?? "unknown"}`);
  }
  const relative = row.status === "staged" ? path.join(".staged", row.id) : row.storage_path;
  const root = selectedRoots[row.storage_root];
  const target = path.resolve(root, relative);
  if (target === root || !target.startsWith(root + path.sep)) throw new Error(`artifact path escapes backup root: ${row.id}`);
  try {
    const physicalRoot = realpathSync(root);
    const physicalTarget = realpathSync(target);
    if (physicalTarget === physicalRoot || !physicalTarget.startsWith(physicalRoot + path.sep)) {
      throw new Error(`artifact path escapes backup root: ${row.id}`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return target;
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function entry(target, kind, id) {
  let stat;
  try { stat = lstatSync(target); }
  catch { throw new Error(`registered artifact is missing: ${id}`); }
  if (stat.isSymbolicLink() || (kind === "file" ? !stat.isFile() : !stat.isDirectory())) {
    throw new Error(`registered artifact has unsafe type: ${id}`);
  }
}

function normalized(row) {
  if (!fileTypes.has(row.artifact_type) && !directoryTypes.has(row.artifact_type)) {
    throw new Error(`unsupported artifact type: ${row.id}`);
  }
  if (row.status !== "staged" && row.status !== "finalized") throw new Error(`unsupported artifact status: ${row.id}`);
  return {
    id: row.id,
    storage_path: row.storage_path,
    storage_root: row.storage_root,
    artifact_type: row.artifact_type,
    status: row.status,
    sha256: row.sha256 ?? null,
  };
}

const current = rows.map(normalized).sort((a, b) => a.id.localeCompare(b.id));
if (new Set(current.map((row) => row.id)).size !== current.length) throw new Error("artifact registry contains duplicate ids");

if (mode === "capture") {
  if (!sourceRoots) throw new Error("capture requires source roots");
  const ledger = [];
  for (const row of current) {
    const copied = targetFor(row, roots);
    if (row.status === "staged") {
      entry(copied, "file", row.id);
      ledger.push(row);
      continue;
    }
    if (directoryTypes.has(row.artifact_type)) {
      const source = targetFor(row, sourceRoots);
      entry(source, "directory", row.id);
      entry(copied, "directory", row.id);
      const top = realpathSync(execFileSync("git", ["-C", source, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim());
      if (top !== realpathSync(source)) throw new Error(`registered worktree is not a Git root: ${row.id}`);
      const commit = execFileSync("git", ["-C", source, "rev-parse", "--verify", "HEAD^{commit}"], { encoding: "utf8" }).trim();
      if (digest(commit) !== row.sha256) throw new Error(`registered worktree commit mismatch: ${row.id}`);
      rmSync(path.join(copied, ".git"), { recursive: true, force: true });
      ledger.push({ ...row, commit });
      continue;
    }
    entry(copied, "file", row.id);
    if (digest(readFileSync(copied)) !== row.sha256) throw new Error(`registered artifact hash mismatch: ${row.id}`);
    ledger.push(row);
  }
  writeFileSync(ledgerPath, JSON.stringify({ version: 1, artifacts: ledger }) + "\n", { flag: "wx" });
} else {
  const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
  if (ledger.version !== 1 || !Array.isArray(ledger.artifacts)) throw new Error("backup artifact registry ledger is invalid");
  const expected = ledger.artifacts.map(({ commit: _commit, ...row }) => normalized(row)).sort((a, b) => a.id.localeCompare(b.id));
  if (JSON.stringify(current) !== JSON.stringify(expected)) throw new Error("restored artifact registry does not match the backup payload");
  const byId = new Map(ledger.artifacts.map((row) => [row.id, row]));
  for (const row of current) {
    const target = targetFor(row, roots);
    if (row.status === "staged") {
      entry(target, "file", row.id);
    } else if (directoryTypes.has(row.artifact_type)) {
      entry(target, "directory", row.id);
      if (lstatSync(target).isSymbolicLink() || digest(byId.get(row.id).commit ?? "") !== row.sha256) {
        throw new Error(`restored worktree identity mismatch: ${row.id}`);
      }
      try { lstatSync(path.join(target, ".git")); throw new Error(`restored worktree contains live Git metadata: ${row.id}`); }
      catch (error) { if (error?.code !== "ENOENT") throw error; }
    } else {
      entry(target, "file", row.id);
      if (digest(readFileSync(target)) !== row.sha256) throw new Error(`restored artifact hash mismatch: ${row.id}`);
    }
  }
}
