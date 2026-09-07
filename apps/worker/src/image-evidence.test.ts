import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { materializeImageEvidence } from "./image-evidence.ts";

const directories: string[] = [];
afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("materializeImageEvidence", () => {
  it("copies only approved attachments from their recorded artifact roots", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dcc-evidence-test-"));
    directories.push(root);
    const primary = path.join(root, "primary");
    const legacy = path.join(root, "legacy");
    const destination = path.join(root, "run", "evidence");
    await Promise.all([mkdir(path.join(primary, "uploads"), { recursive: true }), mkdir(path.join(legacy, "uploads"), { recursive: true })]);
    const png = Buffer.from("approved png bytes");
    const jpg = Buffer.from("approved jpeg bytes");
    await Promise.all([
      writeFile(path.join(primary, "uploads", "approved.png"), png),
      writeFile(path.join(legacy, "uploads", "approved.jpg"), jpg),
      writeFile(path.join(primary, "uploads", "unrelated.png"), "must stay inaccessible"),
    ]);

    const files = await materializeImageEvidence({
      evidence: [
        { attachment_id: "a1", upload_id: "u1", artifact_id: "ar1", storage_root: "primary", storage_path: "uploads/approved.png", original_name: "screen.png", media_type: "image/png", size_bytes: png.length, sha256: createHash("sha256").update(png).digest("hex") },
        { attachment_id: "a2", upload_id: "u2", artifact_id: "ar2", storage_root: "legacy", storage_path: "uploads/approved.jpg", original_name: "photo.jpg", media_type: "image/jpeg", size_bytes: jpg.length, sha256: createHash("sha256").update(jpg).digest("hex") },
      ],
      roots: { primary, legacy },
      destination,
    });

    expect(files.map((file) => path.basename(file.path))).toEqual(["image-001.png", "image-002.jpg"]);
    expect(await Promise.all(files.map((file) => readFile(file.path)))).toEqual([png, jpg]);
    expect(await readdir(destination)).toEqual(["image-001.png", "image-002.jpg"]);
  });

  it("rejects evidence whose bytes no longer match the approved snapshot", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dcc-evidence-test-"));
    directories.push(root);
    const primary = path.join(root, "primary");
    await mkdir(path.join(primary, "uploads"), { recursive: true });
    await writeFile(path.join(primary, "uploads", "changed.png"), "changed");

    await expect(materializeImageEvidence({
      evidence: [{ attachment_id: "a1", upload_id: "u1", artifact_id: "ar1", storage_root: "primary", storage_path: "uploads/changed.png", original_name: null, media_type: "image/png", size_bytes: 7, sha256: "0".repeat(64) }],
      roots: { primary, legacy: path.join(root, "legacy") },
      destination: path.join(root, "run", "evidence"),
    })).rejects.toThrow("image evidence integrity check failed");
  });
});
