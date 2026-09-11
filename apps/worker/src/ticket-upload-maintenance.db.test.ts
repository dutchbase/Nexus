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

  async function stale(relativePath: string, ticketId: string | null = null, deadline: string | null = "-24 hours", storageRoot = "primary") {
    const upload = (await pool.query(`INSERT INTO uploads(storage_path,media_type,size_bytes,owner_user_id,project_id,claim_expires_at)
      VALUES($1,'image/png',8,$2,$3,CASE WHEN $4::text IS NULL THEN NULL ELSE now()+($4)::interval END) RETURNING id`, [relativePath, user, project, deadline])).rows[0].id;
    await pool.query("INSERT INTO artifacts(id,storage_root,storage_path,artifact_type,status,sha256,finalized_at,upload_id) VALUES(gen_random_uuid(),$3,$2,'upload','finalized',repeat('a',64),now(),$1)", [upload, relativePath, storageRoot]);
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

  test("excludes claimed, legacy null-deadline, snapshot-retained, and deleted-ticket uploads", async () => {
    const tickets = (await pool.query(`INSERT INTO tickets(ticket_number,project_id,title,status,submitter_deleted_at) VALUES
      ('DCC-CLEANUP-ACTIVE',$1,'Active','Submitted',NULL),('DCC-CLEANUP-DELETED',$1,'Deleted','Submitted',now()) RETURNING id ORDER BY ticket_number`, [project])).rows;
    const claimed = await stale("claimed.png", tickets[0].id);
    const deleted = await stale("deleted.png", tickets[1].id);
    const legacy = await stale("legacy.png", null, null, "legacy");
    const snapshotRetained = await stale("snapshot.png", null, null);
    const snapshotTicket = (await pool.query("INSERT INTO tickets(ticket_number,project_id,title,status) VALUES('DCC-SNAPSHOT',$1,'Snapshot','Triage') RETURNING id", [project])).rows[0].id;
    const plan = (await pool.query("INSERT INTO plans(ticket_id) VALUES($1) RETURNING id", [snapshotTicket])).rows[0].id;
    const version = (await pool.query("INSERT INTO plan_versions(plan_id,version,content_markdown,content_hash) VALUES($1,1,'Plan',encode(digest('Plan','sha256'),'hex')) RETURNING id", [plan])).rows[0].id;
    const material = { ticket: { imageEvidence: [{ upload_id: snapshotRetained }] } };
    await pool.query(`INSERT INTO approved_input_snapshots(ticket_id,plan_version_id,material_input_json,input_hash)
      VALUES($1,$2,$3,encode(digest(canonical_jsonb($3::jsonb),'sha256'),'hex'))`, [snapshotTicket, version, material]);

    await expect(expireUnclaimedUploads(pool, { primary: root, legacy: root })).resolves.toBe(0);
    expect((await pool.query("SELECT id,claim_expires_at FROM uploads WHERE id=ANY($1::uuid[]) ORDER BY id", [[claimed, deleted, legacy, snapshotRetained]])).rows).toHaveLength(4);
    expect(Number((await pool.query("SELECT count(*) FROM artifacts WHERE upload_id=ANY($1::uuid[]) AND status='finalized'", [[claimed, deleted, legacy, snapshotRetained]])).rows[0].count)).toBe(4);
  });

  test("retries file deletion and only clears the deadline after success", async () => {
    const id = await stale("retry.png");
    await expect(expireUnclaimedUploads(pool, { primary: root, legacy: root })).resolves.toBe(0);
    expect((await pool.query("SELECT claim_expires_at,status FROM uploads JOIN artifacts ON artifacts.upload_id=uploads.id WHERE uploads.id=$1", [id])).rows[0])
      .toMatchObject({ status: "abandoned" });
    expect((await pool.query("SELECT claim_expires_at FROM uploads WHERE id=$1", [id])).rows[0].claim_expires_at).not.toBeNull();

    await writeFile(path.join(root, "retry.png"), "retry");
    await expect(expireUnclaimedUploads(pool, { primary: root, legacy: root })).resolves.toBe(1);
    expect((await pool.query("SELECT claim_expires_at FROM uploads WHERE id=$1", [id])).rows[0].claim_expires_at).toBeNull();
  });
});
