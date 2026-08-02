import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
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

function isWithin(root: string, target: string) {
  const relative = path.relative(root, target);
  return relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
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

async function safeDirectory(root: string, target: string) {
  const controlledRoot = path.resolve(root);
  await mkdir(controlledRoot, { recursive: true });
  await mkdir(path.dirname(target), { recursive: true });
  const [realRoot, realDirectory] = await Promise.all([realpath(controlledRoot), realpath(path.dirname(target))]);
  if (!isWithin(realRoot, realDirectory) && realRoot !== realDirectory) throw new Error("artifact path escapes controlled root");
}

async function exists(target: string) {
  try {
    await lstat(target);
    return true;
  } catch (error: any) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
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
  if (await exists(staged.storagePath)) throw new Error("artifact destination already exists");
  const content = await readFile(staged.stagedPath);
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
    if (expiresAt && expiresAt <= now) {
      await Promise.all([rm(pendingPath, { force: true }), rm(storagePath, { force: true })]);
      await input.abandon(record.id);
      continue;
    }
    if (record.status === "finalized") {
      if (!await exists(storagePath)) await input.abandon(record.id);
      continue;
    }
    if (await exists(storagePath)) {
      await input.finalize(record.id, createHash("sha256").update(await readFile(storagePath)).digest("hex"));
    } else if (!await exists(pendingPath)) {
      await input.abandon(record.id);
    }
  }
}
