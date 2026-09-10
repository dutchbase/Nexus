import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const databaseUrl = process.env.DCC_TEST_DATABASE_URL;
process.env.DCC_PROCESS_ROLE = "worker";
process.env.DATABASE_URL = databaseUrl ?? "postgres://unused:unused@127.0.0.1:1/unused";
const integration = databaseUrl ? describe : describe.skip;
const { pool } = await import("@dcc/database");
const { migrate } = await import("../../../packages/database/src/migrate.ts");
const { expireUnclaimedUploads } = await import("./ticket-upload-maintenance.ts");

integration("ticket upload maintenance", () => {
  let root = "", project = "", user = "";
  beforeAll(async () => {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await migrate({ connectionString: databaseUrl! });
    root = await mkdtemp(path.join(tmpdir(), "nexus-upload-cleanup-"));
    user = (await pool.query("INSERT INTO users(username,password_hash,role) VALUES('cleanup-user','x','reporter') RETURNING id")).rows[0].id;
    project = (await pool.query("INSERT INTO projects(slug,name,repository_path) VALUES('cleanup','Cleanup','/tmp/cleanup') RETURNING id")).rows[0].id;
  });
  afterAll(async () => pool.end());

  async function stale(relativePath: string, ticketId: string | null = null) {
    const upload = (await pool.query(`INSERT INTO uploads(storage_path,media_type,size_bytes,owner_user_id,project_id,claim_expires_at)
      VALUES($1,'image/png',8,$2,$3,now()-interval '24 hours') RETURNING id`, [relativePath, user, project])).rows[0].id;
    await pool.query("INSERT INTO artifacts(id,storage_path,artifact_type,status,sha256,finalized_at,upload_id) VALUES(gen_random_uuid(),$2,'upload','finalized',repeat('a',64),now(),$1)", [upload, relativePath]);
    await pool.query("INSERT INTO attachments(upload_id,ticket_id) VALUES($1,$2)", [upload, ticketId]);
    return upload;
  }

  test("abandons and removes expired unclaimed bytes while retaining database evidence", async () => {
    await writeFile(path.join(root, "old.png"), "old");
    const id = await stale("old.png");
    await expect(expireUnclaimedUploads(pool, { primary: root, legacy: root })).resolves.toBe(1);
    expect((await pool.query("SELECT claim_expires_at,status FROM uploads JOIN artifacts ON artifacts.upload_id=uploads.id WHERE uploads.id=$1", [id])).rows[0])
      .toMatchObject({ claim_expires_at: null, status: "abandoned" });
    await expect(readFile(path.join(root, "old.png"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("unsafe paths stay retryable and are never passed outside the controlled root", async () => {
    const id = await stale("../outside.png");
    await expect(expireUnclaimedUploads(pool, { primary: root, legacy: root })).resolves.toBe(0);
    expect((await pool.query("SELECT claim_expires_at FROM uploads WHERE id=$1", [id])).rows[0].claim_expires_at).not.toBeNull();
  });
});
