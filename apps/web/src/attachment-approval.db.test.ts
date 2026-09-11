import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

const databaseUrl = process.env.DCC_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const root = await mkdtemp(join(tmpdir(), "nexus-attachment-approval-"));
process.env.DCC_PROCESS_ROLE = "web";
process.env.DATABASE_URL = databaseUrl ?? "postgres://unused:unused@127.0.0.1:1/unused";
process.env.DCC_DATA_DIR = root;

const { inTransaction, pool } = await import("@dcc/database");
const { buildApprovedInputSnapshot, checkPlanApprovalGate, lockTicketActor } = await import("@dcc/domain");
const { migrate } = await import("../../../packages/database/src/migrate.ts");
const { setTicketAttachments } = await import("./ticket-uploads.ts");
const { adminHtml, readUploadArtifact } = await import("./server.ts");

integration("captured image approval evidence", () => {
  let adminId = "", reporterId = "", projectId = "", ticketId = "", planVersionId = "";

  beforeAll(async () => {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await migrate({ connectionString: databaseUrl! });
    const users = (await pool.query(`INSERT INTO users(username,password_hash,role) VALUES
      ('artifact-admin','x','admin'),('artifact-reporter','x','reporter') RETURNING id,role`)).rows;
    adminId = users.find((row: any) => row.role === "admin").id;
    reporterId = users.find((row: any) => row.role === "reporter").id;
    projectId = (await pool.query("INSERT INTO projects(slug,name,repository_path) VALUES('artifact-approval','Artifact approval','/tmp/artifact-approval') RETURNING id")).rows[0].id;
    await pool.query("INSERT INTO project_memberships(user_id,project_id) VALUES($1,$2)", [reporterId, projectId]);
    ticketId = (await pool.query("INSERT INTO tickets(ticket_number,project_id,title,description,status,created_by_user_id) VALUES('DCC-ARTIFACT',$1,'Captured image','Evidence','Plan Ready for Review',$2) RETURNING id", [projectId, reporterId])).rows[0].id;
    const prompt = "captured prompt";
    const promptId = (await pool.query("INSERT INTO prompt_snapshots(ticket_id,project_id,phase,content,content_hash,model,reasoning_level,metadata_json) VALUES($1,$2,'planning',$3,$4,'sonnet','high','{}') RETURNING id", [ticketId, projectId, prompt, createHash("sha256").update(prompt).digest("hex")])).rows[0].id;
    const runId = (await pool.query("INSERT INTO agent_runs(ticket_id,project_id,run_type,status,prompt_snapshot_id,metadata_json) VALUES($1,$2,'planning','completed',$3,'{}') RETURNING id", [ticketId, projectId, promptId])).rows[0].id;
    const planId = (await pool.query("INSERT INTO plans(ticket_id,planning_session_id) VALUES($1,gen_random_uuid()) RETURNING id", [ticketId])).rows[0].id;
    const markdown = "# Approved plan";
    planVersionId = (await pool.query("INSERT INTO plan_versions(plan_id,version,content_markdown,content_hash,prompt_snapshot_id,agent_run_id) VALUES($1,1,$2,$3,$4,$5) RETURNING id", [planId, markdown, createHash("sha256").update(markdown).digest("hex"), promptId, runId])).rows[0].id;
    await pool.query("UPDATE plans SET current_version_id=$2 WHERE id=$1", [planId, planVersionId]);
  });

  afterAll(async () => {
    await pool.end();
    await rm(root, { recursive: true, force: true });
  });

  async function upload(name: string, bytes: Buffer) {
    const storagePath = `uploads/${name}.png`;
    await mkdir(join(root, "uploads"), { recursive: true });
    await writeFile(join(root, storagePath), bytes);
    const uploadId = (await pool.query("INSERT INTO uploads(storage_path,original_name,media_type,size_bytes,owner_user_id,project_id,claim_expires_at) VALUES($1,$2,'image/png',$3,$4,$5,now()+interval '1 hour') RETURNING id", [storagePath, `${name}.png`, bytes.length, reporterId, projectId])).rows[0].id;
    const artifact = (await pool.query("INSERT INTO artifacts(id,storage_path,artifact_type,status,sha256,finalized_at,upload_id) VALUES(gen_random_uuid(),$1,'upload','finalized',$2,now(),$3) RETURNING id,storage_root,storage_path,status,sha256", [storagePath, createHash("sha256").update(bytes).digest("hex"), uploadId])).rows[0];
    const attachmentId = (await pool.query("INSERT INTO attachments(upload_id,field_key) VALUES($1,'screenshots') RETURNING id", [uploadId])).rows[0].id;
    return { uploadId, attachmentId, artifact, bytes };
  }

  test("replacement invalidates future execution while captured artifact bytes remain readable", async () => {
    const imageA = await upload("approval-a", Buffer.from("image-a"));
    await inTransaction(async (client) => {
      await lockTicketActor(client, { userId: reporterId, role: "reporter" });
      await setTicketAttachments(client, { userId: reporterId, role: "reporter" }, { id: ticketId, project_id: projectId }, { screenshots: [imageA.uploadId] }, ["screenshots"]);
    });
    const evidenceA = (await pool.query(`SELECT a.id attachment_id,u.id upload_id,ar.id artifact_id,ar.storage_root,ar.storage_path,u.original_name,u.media_type,u.size_bytes,ar.sha256
      FROM attachments a JOIN uploads u ON u.id=a.upload_id JOIN artifacts ar ON ar.upload_id=u.id WHERE a.ticket_id=$1`, [ticketId])).rows;
    const planHash = createHash("sha256").update("# Approved plan").digest("hex");
    const captured = buildApprovedInputSnapshot({
      plan: { versionId: planVersionId, version: 1, contentHash: planHash },
      ticket: { imageEvidence: evidenceA }, project: { configVersion: 1 }, models: {}, prompts: [], skills: [], policySources: [],
    } as any);
    const snapshotId = (await pool.query("INSERT INTO approved_input_snapshots(ticket_id,plan_version_id,material_input_json,input_hash,created_by) VALUES($1,$2,$3,$4,$5) RETURNING id", [ticketId, planVersionId, captured.materialInput, captured.inputHash, adminId])).rows[0].id;
    await pool.query("UPDATE tickets SET status='Plan Approved',approved_plan_version_id=$2,approved_plan_hash=$3,approved_input_snapshot_id=$4 WHERE id=$1", [ticketId, planVersionId, planHash, snapshotId]);
    const attemptId = (await pool.query("INSERT INTO execution_attempts(ticket_id,plan_version_id,attempt_number,validation_status) VALUES($1,$2,1,'queued') RETURNING id", [ticketId, planVersionId])).rows[0].id;
    await pool.query("INSERT INTO jobs(type,status,payload_json,idempotency_key) VALUES('execution.run','queued',$1,$2)", [{ ticket_id: ticketId, execution_attempt_id: attemptId, approved_input_snapshot_id: snapshotId }, `captured-image:${attemptId}`]);
    expect(await checkPlanApprovalGate(pool, ticketId)).toMatchObject({ valid: true, approvedInputSnapshot: { id: snapshotId, inputHash: captured.inputHash } });

    const imageB = await upload("approval-b", Buffer.from("image-b"));
    await inTransaction(async (client) => {
      await lockTicketActor(client, { userId: reporterId, role: "reporter" });
      await setTicketAttachments(client, { userId: reporterId, role: "reporter" }, { id: ticketId, project_id: projectId }, { screenshots: [imageB.uploadId] }, ["screenshots"]);
      await client.query("SELECT mark_ticket_plan_potentially_stale($1)", [ticketId]);
    });
    const evidenceB = (await pool.query(`SELECT a.id attachment_id,u.id upload_id,ar.id artifact_id,ar.storage_root,ar.storage_path,u.original_name,u.media_type,u.size_bytes,ar.sha256
      FROM attachments a JOIN uploads u ON u.id=a.upload_id JOIN artifacts ar ON ar.upload_id=u.id WHERE a.ticket_id=$1`, [ticketId])).rows;
    const current = buildApprovedInputSnapshot({ ...(captured.materialInput as any), ticket: { ...(captured.materialInput as any).ticket, imageEvidence: evidenceB } });
    expect(current.inputHash).not.toBe(captured.inputHash);
    expect(await checkPlanApprovalGate(pool, ticketId)).toMatchObject({ valid: false, code: "plan_potentially_stale" });
    expect((await pool.query("SELECT payload_json FROM jobs WHERE idempotency_key=$1", [`captured-image:${attemptId}`])).rows[0].payload_json)
      .toMatchObject({ execution_attempt_id: attemptId, approved_input_snapshot_id: snapshotId });
    expect((await pool.query("SELECT ticket_id FROM attachments WHERE upload_id=$1", [imageA.uploadId])).rows[0]).toBeUndefined();

    const capturedArtifact = (captured.materialInput as any).ticket.imageEvidence[0];
    const artifactA = (await pool.query("SELECT ar.id artifact_id,ar.status artifact_status,ar.storage_root,ar.storage_path artifact_storage_path,ar.sha256 artifact_sha256,u.storage_path upload_storage_path FROM artifacts ar JOIN uploads u ON u.id=ar.upload_id WHERE ar.id=$1", [capturedArtifact.artifact_id])).rows[0];
    await expect(readUploadArtifact(artifactA)).resolves.toEqual(imageA.bytes);

    const token = "attachment-get-token";
    await pool.query("INSERT INTO admin_sessions(user_id,token_hash,csrf_token_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')", [adminId, createHash("sha256").update(token).digest("hex"), "x"]);
    const before = (await pool.query("SELECT status,sha256,finalized_at FROM artifacts WHERE id=$1", [imageB.artifact.id])).rows[0];
    const response: any = { writeHead: vi.fn(), end: vi.fn() };
    await adminHtml({ method: "GET", headers: { cookie: `dcc_session=${token}` } } as any, response, new URL(`http://test/admin/attachments/${imageB.attachmentId}`));
    expect(response.writeHead).toHaveBeenCalledWith(200, expect.anything());
    expect(response.end).toHaveBeenCalledWith(imageB.bytes);
    expect((await pool.query("SELECT status,sha256,finalized_at FROM artifacts WHERE id=$1", [imageB.artifact.id])).rows[0]).toEqual(before);
    expect(Number((await pool.query("SELECT count(*) FROM artifacts")).rows[0].count)).toBe(2);
  });
});
