import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { artifactDataRoot, finalizeArtifact, inTransaction, stageArtifact } from "@dcc/database";
import { lockTicketActor, requireProjectAccess, type QueryClient, type TicketActor, type TicketAttachment } from "@dcc/domain";

export type AttachmentSelection = Record<string, string[]>;
export type UploadScope = { kind: "public"; formId: string } | { kind: "authenticated"; actor: TicketActor; projectId: string };

const dataRoot = artifactDataRoot(resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", ".."));
const maximumBytes = 5 * 1024 * 1024;

function fail(message: string, status = 422, extra?: object): never {
  throw Object.assign(new Error(message), { status, ...extra });
}

async function bodyBuffer(request: IncomingMessage, maximum: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximum) fail("upload too large", 413);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function sniffImage(buffer: Buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { mediaType: "image/png", extension: ".png" };
  if (buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return { mediaType: "image/jpeg", extension: ".jpg" };
  return null;
}

async function reserveAuthenticatedUpload(scope: Extract<UploadScope, { kind: "authenticated" }>) {
  return inTransaction(async (client) => {
    await lockTicketActor(client, scope.actor);
    await requireProjectAccess(client, scope.actor, scope.projectId);
    const project = (await client.query("SELECT enabled FROM projects WHERE id=$1", [scope.projectId])).rows[0];
    if (!project?.enabled) fail("project is disabled", 422);
    const quota = (await client.query(
      `SELECT count(*)::integer count,coalesce(ceil(extract(epoch FROM min(created_at)+interval '1 hour'-now()))::integer,0) reset_seconds
       FROM authenticated_upload_attempts WHERE user_id=$1 AND created_at>now()-interval '1 hour'`, [scope.actor.userId],
    )).rows[0];
    if (Number(quota.count) >= 30) fail("upload rate limit exceeded", 429, { retryAfterSeconds: Math.max(1, Number(quota.reset_seconds)) });
    await client.query("INSERT INTO authenticated_upload_attempts(user_id) VALUES($1)", [scope.actor.userId]);
  });
}

export async function storeTicketUpload(request: IncomingMessage, scope: UploadScope): Promise<{ upload_id: string }> {
  if (scope.kind === "authenticated") await reserveAuthenticatedUpload(scope);
  const contentType = request.headers["content-type"] ?? "";
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)?.slice(1).find(Boolean);
  if (!boundary) fail("multipart form data required", 400);
  const raw = await bodyBuffer(request, maximumBytes + 64 * 1024);
  const headerEnd = raw.indexOf(Buffer.from("\r\n\r\n"));
  const end = headerEnd < 0 ? -1 : raw.indexOf(Buffer.from(`\r\n--${boundary}`), headerEnd + 4);
  if (headerEnd < 0 || end < 0) fail("invalid upload", 400);
  const bytes = raw.subarray(headerEnd + 4, end);
  if (!bytes.length || bytes.length > maximumBytes) fail("upload too large", 413);
  const image = sniffImage(bytes);
  if (!image) fail("only PNG and JPEG images are accepted", 415);
  const artifactId = randomUUID();
  const staged = await stageArtifact({ root: dataRoot, id: artifactId, storagePath: `uploads/${artifactId}${image.extension}`, content: bytes });
  let registered = false;
  try {
    const supplied = /filename="([^"]*)"/i.exec(raw.subarray(0, headerEnd).toString("utf8"))?.[1];
    const originalName = supplied ? supplied.replace(/[\\/\0-\x1f\x7f]/g, "_").slice(0, 255) : null;
    const uploadId = await inTransaction(async (client) => {
      if (scope.kind === "authenticated") {
        await lockTicketActor(client, scope.actor);
        await requireProjectAccess(client, scope.actor, scope.projectId);
        if (!(await client.query("SELECT id FROM projects WHERE id=$1 AND enabled=true", [scope.projectId])).rowCount) fail("project is disabled", 422);
      } else if (!(await client.query("SELECT id FROM forms WHERE id=$1 AND status='published'", [scope.formId])).rowCount) fail("form not found", 404);
      const values = scope.kind === "public" ? [scope.formId, null, null] : [null, scope.actor.userId, scope.projectId];
      const upload = (await client.query(
        `INSERT INTO uploads(storage_path,original_name,media_type,size_bytes,form_id,owner_user_id,project_id,claim_expires_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '1 hour') RETURNING id`,
        [staged.relativePath, originalName, image.mediaType, bytes.length, ...values],
      )).rows[0];
      await client.query(`INSERT INTO artifacts(id,storage_path,artifact_type,status,expires_at,upload_id)
        VALUES($1,$2,'upload','staged',now()+interval '1 hour',$3)`, [artifactId, staged.relativePath, upload.id]);
      await client.query("INSERT INTO attachments(upload_id) VALUES($1) RETURNING id", [upload.id]);
      return upload.id as string;
    });
    registered = true;
    await inTransaction(async (client) => {
      if (!(await client.query("SELECT id FROM artifacts WHERE id=$1 AND status='staged' FOR UPDATE", [artifactId])).rowCount) throw new Error("artifact is no longer staged");
      const finalized = await finalizeArtifact(staged);
      if (!(await client.query("UPDATE artifacts SET status='finalized',sha256=$2,finalized_at=now(),expires_at=NULL WHERE id=$1 AND status='staged'", [artifactId, finalized.sha256])).rowCount) throw new Error("artifact is no longer staged");
    });
    return { upload_id: uploadId };
  } catch (error) {
    if (!registered) await rm(staged.stagedPath, { force: true });
    throw error;
  }
}

export function checkedAttachmentSelection(selection: unknown, validFieldKeys: string[]): AttachmentSelection {
  if (!selection || typeof selection !== "object" || Array.isArray(selection)) fail("invalid attachments");
  const allowed = new Set(validFieldKeys);
  const all: string[] = [];
  for (const [field, ids] of Object.entries(selection as Record<string, unknown>)) {
    if (!allowed.has(field) || !Array.isArray(ids) || ids.length > 5 || ids.some((id) => typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id))) fail("invalid attachments");
    all.push(...ids);
  }
  if (new Set(all).size !== all.length) fail("upload used more than once");
  return selection as AttachmentSelection;
}

export async function setTicketAttachments(client: QueryClient, actor: TicketActor, ticket: any, selection: AttachmentSelection, validFieldKeys: string[]): Promise<void> {
  const checked = checkedAttachmentSelection(selection, validFieldKeys);
  const requested = Object.values(checked).flat();
  const existing = (await client.query("SELECT id,upload_id,field_key FROM attachments WHERE ticket_id=$1 FOR UPDATE", [ticket.id])).rows;
  const retained = new Set(existing.filter((row: any) => requested.includes(row.upload_id)).map((row: any) => row.upload_id));
  const claims = requested.filter((id) => !retained.has(id));
  if (claims.length) {
    await client.query("SELECT id,upload_id FROM attachments WHERE upload_id=ANY($1::uuid[]) AND ticket_id IS NULL FOR UPDATE", [claims]);
    await client.query("SELECT id FROM uploads WHERE id=ANY($1::uuid[]) FOR UPDATE", [claims]);
    await client.query("SELECT id FROM artifacts WHERE upload_id=ANY($1::uuid[]) FOR UPDATE", [claims]);
    const allowed = (await client.query(
      `SELECT a.upload_id FROM attachments a JOIN uploads u ON u.id=a.upload_id JOIN artifacts ar ON ar.upload_id=u.id
       WHERE a.upload_id=ANY($1::uuid[]) AND a.ticket_id IS NULL AND u.owner_user_id=$2 AND u.project_id=$3 AND u.form_id IS NULL
         AND u.created_at>now()-interval '1 hour' AND u.claim_expires_at>now() AND ar.status='finalized'
         AND u.media_type IN ('image/png','image/jpeg') AND u.size_bytes<=5242880 FOR UPDATE OF a`,
      [claims, actor.userId, ticket.project_id],
    )).rows.map((row: any) => row.upload_id);
    if (allowed.length !== claims.length || claims.some((id) => !allowed.includes(id))) fail("upload unavailable");
  }
  for (const [field, ids] of Object.entries(checked)) {
    await client.query("DELETE FROM attachments WHERE ticket_id=$1 AND field_key=$2 AND NOT (upload_id=ANY($3::uuid[]))", [ticket.id, field, ids]);
    for (const id of ids.filter((uploadId) => !retained.has(uploadId))) {
      const claimed = await client.query("UPDATE attachments SET ticket_id=$1,field_key=$2 WHERE upload_id=$3 AND ticket_id IS NULL", [ticket.id, field, id]);
      if ((claimed as any).rowCount !== 1) throw new Error("upload claim changed while locked");
      await client.query("UPDATE uploads SET claim_expires_at=NULL WHERE id=$1", [id]);
    }
    await client.query("UPDATE attachments SET field_key=$2 WHERE ticket_id=$1 AND upload_id=ANY($3::uuid[])", [ticket.id, field, ids]);
  }
}

export async function setPublicTicketAttachments(client: QueryClient, formId: string, ticketId: string, selection: AttachmentSelection, validFieldKeys: string[]): Promise<void> {
  const checked = checkedAttachmentSelection(selection, validFieldKeys);
  const requested = Object.values(checked).flat();
  if (!requested.length) return;
  await client.query("SELECT id,upload_id FROM attachments WHERE upload_id=ANY($1::uuid[]) AND ticket_id IS NULL FOR UPDATE", [requested]);
  await client.query("SELECT id FROM uploads WHERE id=ANY($1::uuid[]) FOR UPDATE", [requested]);
  await client.query("SELECT id FROM artifacts WHERE upload_id=ANY($1::uuid[]) FOR UPDATE", [requested]);
  const allowed = (await client.query(
    `SELECT a.upload_id FROM attachments a JOIN uploads u ON u.id=a.upload_id JOIN artifacts ar ON ar.upload_id=u.id
     WHERE a.upload_id=ANY($1::uuid[]) AND a.ticket_id IS NULL AND u.owner_user_id IS NULL AND u.project_id IS NULL AND u.form_id=$2
       AND u.created_at>now()-interval '1 hour' AND (u.claim_expires_at IS NULL OR u.claim_expires_at>now()) AND ar.status='finalized'
       AND u.media_type IN ('image/png','image/jpeg') AND u.size_bytes<=5242880 FOR UPDATE OF a`,
    [requested, formId],
  )).rows.map((row: any) => row.upload_id);
  if (allowed.length !== requested.length || requested.some((id) => !allowed.includes(id))) fail("upload unavailable");
  for (const [field, ids] of Object.entries(checked)) for (const id of ids) {
    if ((await client.query("UPDATE attachments SET ticket_id=$1,field_key=$2 WHERE upload_id=$3 AND ticket_id IS NULL", [ticketId, field, id]) as any).rowCount !== 1) throw new Error("upload claim changed while locked");
    await client.query("UPDATE uploads SET claim_expires_at=NULL WHERE id=$1", [id]);
  }
}

export async function attachmentsForActor(client: QueryClient, actor: TicketActor, ref: string): Promise<TicketAttachment[]> {
  const access = actor.role === "admin" ? "" : "AND EXISTS(SELECT 1 FROM project_memberships m WHERE m.project_id=t.project_id AND m.user_id=$2)";
  const values = actor.role === "admin" ? [ref] : [ref, actor.userId];
  return (await client.query(
    `SELECT a.id,a.upload_id,coalesce(a.field_key,'screenshots') field_key,u.original_name,u.media_type,u.size_bytes,'/attachments/'||a.id AS url
     FROM attachments a JOIN uploads u ON u.id=a.upload_id JOIN tickets t ON t.id=a.ticket_id
     WHERE (t.id::text=$1 OR t.ticket_number=$1) AND t.submitter_deleted_at IS NULL ${access} ORDER BY a.created_at,a.id`, values,
  )).rows;
}
