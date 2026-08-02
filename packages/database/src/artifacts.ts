import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export type ArtifactRecord = {
  id: string;
  storage_path: string;
  status: "staged" | "finalized" | "abandoned";
  expires_at: Date | string | null;
};

export type StagedArtifact = {
  id: string;
  root: string;
  relativePath: string;
  stagedPath: string;
  storagePath: string;
};

type ArtifactLocation = "missing" | "present" | "unsafe";

function isWithin(root: string, target: string) {
  const relative = path.relative(root, target);
  return relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function artifactDataRoot(defaultRoot: string, environment: Partial<Pick<NodeJS.ProcessEnv, "DCC_DATA_DIR" | "DCC_DATA_ROOT">> = process.env) {
  return path.resolve(environment.DCC_DATA_DIR ?? path.join(environment.DCC_DATA_ROOT ?? defaultRoot, "data"));
}

export function legacyArtifactDataRoot(defaultRoot: string, environment: Partial<Pick<NodeJS.ProcessEnv, "DCC_DATA_ROOT">> = process.env) {
  return path.resolve(environment.DCC_DATA_ROOT ?? defaultRoot, "data");
}

export function artifactPath(root: string, relativePath: string) {
  if (path.isAbsolute(relativePath)) throw new Error("artifact path escapes controlled root");
  const controlledRoot = path.resolve(root);
  const target = path.resolve(controlledRoot, relativePath);
  if (!isWithin(controlledRoot, target)) throw new Error("artifact path escapes controlled root");
  return target;
}

function stagedPath(root: string, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("invalid artifact id");
  return artifactPath(root, path.join(".staged", id));
}

async function location(root: string, target: string): Promise<ArtifactLocation> {
  try {
    const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(target)]);
    return isWithin(realRoot, realTarget) ? "present" : "unsafe";
  } catch (error: any) {
    if (error?.code === "ENOENT") return "missing";
    throw error;
  }
}

async function safeDirectory(root: string, target: string) {
  const controlledRoot = path.resolve(root);
  await mkdir(controlledRoot, { recursive: true });
  await mkdir(path.dirname(target), { recursive: true });
  const [realRoot, realDirectory] = await Promise.all([realpath(controlledRoot), realpath(path.dirname(target))]);
  if (!isWithin(realRoot, realDirectory) && realRoot !== realDirectory) throw new Error("artifact path escapes controlled root");
}

async function removeArtifact(root: string, target: string) {
  if (await location(root, target) === "present") await rm(target, { force: true });
}

export async function readStagedArtifact(root: string, id: string) {
  return readArtifact(root, path.join(".staged", id));
}

export async function readArtifact(root: string, relativePath: string) {
  const target = artifactPath(root, relativePath);
  const current = await location(root, target);
  if (current !== "present") throw new Error(current === "unsafe" ? "artifact path escapes controlled root" : "artifact is missing");
  return readFile(target);
}

export async function stageArtifact(input: {
  root: string;
  id: string;
  storagePath: string;
  content: Buffer;
}): Promise<StagedArtifact> {
  const storagePath = artifactPath(input.root, input.storagePath);
  const stagingPath = stagedPath(input.root, input.id);
  await Promise.all([safeDirectory(input.root, storagePath), safeDirectory(input.root, stagingPath)]);
  await writeFile(stagingPath, input.content, { flag: "wx" });
  return { id: input.id, root: path.resolve(input.root), relativePath: input.storagePath, stagedPath: stagingPath, storagePath };
}

export async function finalizeArtifact(staged: StagedArtifact) {
  const destination = await location(staged.root, staged.storagePath);
  if (destination === "present") throw new Error("artifact destination already exists");
  if (destination === "unsafe" || await location(staged.root, staged.stagedPath) !== "present") {
    throw new Error("artifact path escapes controlled root");
  }
  await safeDirectory(staged.root, staged.storagePath);
  const content = await readArtifact(staged.root, path.join(".staged", staged.id));
  const sha256 = createHash("sha256").update(content).digest("hex");
  await rename(staged.stagedPath, staged.storagePath);
  return { id: staged.id, storagePath: staged.storagePath, sha256 };
}

export async function reconcileArtifacts(input: {
  root: string;
  records: ArtifactRecord[];
  finalize: (id: string, sha256: string) => Promise<void>;
  abandon: (id: string) => Promise<void>;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  for (const record of input.records) {
    if (record.status === "abandoned") continue;
    const expiresAt = record.expires_at ? new Date(record.expires_at) : null;
    let storagePath: string;
    let pendingPath: string;
    try {
      storagePath = artifactPath(input.root, record.storage_path);
      pendingPath = stagedPath(input.root, record.id);
    } catch {
      await input.abandon(record.id);
      continue;
    }
    const stored = await location(input.root, storagePath);
    if (stored === "unsafe") {
      await input.abandon(record.id);
      continue;
    }
    if (record.status === "staged" && stored === "present") {
      try {
        await input.finalize(record.id, createHash("sha256").update(await readArtifact(input.root, record.storage_path)).digest("hex"));
      } catch {
        // The bytes are intact at the finalized location; retry database finalization later.
      }
      continue;
    }
    if (record.status === "finalized") {
      if (stored !== "present") await input.abandon(record.id);
      continue;
    }
    if (expiresAt && expiresAt <= now) {
      await removeArtifact(input.root, pendingPath);
      await input.abandon(record.id);
      continue;
    }
    if (await location(input.root, pendingPath) !== "present") await input.abandon(record.id);
  }

  const registered = new Set(input.records.map((record) => record.id));
  const stagingRoot = artifactPath(input.root, ".staged");
  try {
    for (const entry of await readdir(stagingRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !/^[0-9a-f-]{36}$/i.test(entry.name) || registered.has(entry.name)) continue;
      const candidate = stagedPath(input.root, entry.name);
      const age = now.getTime() - (await stat(candidate)).mtime.getTime();
      if (age >= 60 * 60 * 1000) await removeArtifact(input.root, candidate);
    }
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
}
