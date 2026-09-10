import { inTransaction, pool } from "@dcc/database";
import {
  enqueueNotification, lockTicketActor, reporterTicket, requireProjectAccess, ticketForActor,
  type ReporterTicket, type SubmissionFields, type TicketActor,
} from "@dcc/domain";
import { standardFields } from "./pages/shared.ts";
import { attachmentsForActor, setTicketAttachments, type AttachmentSelection } from "./ticket-uploads.ts";

const columns = ["title", "description", "category", "priority", "source_url", "environment", "expected_behavior", "actual_behavior", "reproduction_steps"] as const;
const reserved = new Set([
  "id", "ticket_number", "form_id", "project_id", "status", "created_by_user_id", "submitter_name", "submitter_email",
  "submission_revision", "submission_updated_at", "submitter_deleted_at", "submitter_deleted_by", "custom_values_json",
  "ai_configuration_mode", "default_model", "default_reasoning_level", "planning_model", "planning_reasoning_level",
  "execution_model", "execution_reasoning_level", "repair_model", "repair_reasoning_level", "approved_plan_version_id",
  ...columns,
]);
export const standardSubmissionFields = [
  ...standardFields,
  { field_key: "priority", field_type: "dropdown", required: false, options_json: ["critical", "high", "medium", "low"], validation_json: {} },
  { field_key: "expected_behavior", field_type: "long_text", required: false, options_json: [], validation_json: { max_length: 10000 } },
  { field_key: "actual_behavior", field_type: "long_text", required: false, options_json: [], validation_json: { max_length: 10000 } },
  { field_key: "reproduction_steps", field_type: "long_text", required: false, options_json: [], validation_json: { max_length: 10000 } },
  { field_key: "screenshots", field_type: "image_upload", required: false, options_json: [], validation_json: {} },
];

function fail(message: string, status = 422, fields?: Record<string, string>): never {
  throw Object.assign(new Error(message), { status, ...(fields ? { fields } : {}) });
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("request body must be an object");
  return value as Record<string, unknown>;
}

function allowOnly(input: Record<string, unknown>, allowed: readonly string[]) {
  const unknown = Object.keys(input).find((key) => !allowed.includes(key));
  if (unknown) fail(`unknown field: ${unknown}`);
}

async function fieldsFor(client: any, formId: string | null) {
  if (!formId) return standardSubmissionFields;
  const rows = (await client.query("SELECT * FROM form_fields WHERE form_id=$1 ORDER BY position,created_at", [formId])).rows;
  return rows.length ? rows : standardSubmissionFields;
}

export async function getSubmissionFields(actor: TicketActor, ref?: string) {
  if (!ref) return standardSubmissionFields.filter((field) => submissionFieldIsEditable(field));
  const ticket = await ticketForActor(pool, actor, ref);
  if (!ticket) fail("ticket not found", 404);
  return (await fieldsFor(pool, ticket.form_id)).filter((field: any) => submissionFieldIsEditable(field));
}

export async function listSubmissionAttachments(actor: TicketActor, ref: string) {
  const ticket = await ticketForActor(pool, actor, ref);
  if (!ticket) fail("ticket not found", 404);
  return (await pool.query(
    `SELECT a.id,u.original_name,u.media_type,u.size_bytes FROM attachments a
     JOIN uploads u ON u.id=a.upload_id WHERE a.ticket_id=$1 ORDER BY a.created_at`,
    [ticket.id],
  )).rows;
}

function editableFields(fields: any[]) {
  return fields.filter((field) => !["hidden", "static", "image_upload"].includes(field.field_type)
    && field.field_key !== "project_id" && field.field_key !== "submitter_email" && !reserved.has(field.field_key));
}

function submissionFieldIsEditable(field: any) {
  return !["hidden", "static", "image_upload"].includes(field.field_type)
    && !["project_id", "submitter_name", "submitter_email"].includes(field.field_key)
    && (columns.includes(field.field_key) || !reserved.has(field.field_key));
}

function submissionFields(fields: any[]) {
  return fields.filter((field) => !["hidden", "static", "image_upload"].includes(field.field_type)
    && !["project_id", "submitter_name", "submitter_email"].includes(field.field_key));
}

function validateField(field: any, value: unknown): string | undefined {
  const empty = value === undefined || value === null || value === "" || (Array.isArray(value) && !value.length) || (field.field_type === "checkbox" && value === false);
  if (field.required && empty) return "required";
  if (value === undefined || value === null || value === "") return;
  if (field.field_type === "checkbox") return typeof value === "boolean" ? undefined : "invalid value";
  if (field.field_type === "multi_select") {
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return "invalid value";
  } else if (typeof value !== "string") return "invalid value";
  if (["dropdown", "radio", "multi_select", "category_selector", "environment_selector"].includes(field.field_type)) {
    const options = Array.isArray(field.options_json) ? field.options_json : [];
    if (Array.isArray(value) ? value.some((item) => !options.includes(item)) : !options.includes(value)) return "invalid option";
  }
  if (typeof value === "string") {
    const max = Math.min(Number(field.validation_json?.max_length ?? (field.field_type === "long_text" ? 10000 : 500)), 10000);
    if (value.length > max) return "too long";
    if (field.field_type === "url") {
      try { if (!/^https?:$/.test(new URL(value).protocol)) return "invalid URL"; } catch { return "invalid URL"; }
    }
  }
}

function validated(inputValue: unknown, fields: any[], partial: boolean) {
  const input = object(inputValue);
  allowOnly(input, [...columns, "submission", "attachment_upload_ids", ...(partial ? ["submission_revision"] : ["project_id"])]);
  const submission = input.submission === undefined ? {} : object(input.submission);
  const declared = new Map(editableFields(fields).map((field) => [field.field_key, field]));
  const errors: Record<string, string> = {};
  for (const [key, value] of Object.entries(submission)) {
    const field = declared.get(key);
    if (!field) errors[key] = "unknown field";
    else if (!(typeof value === "string" || typeof value === "boolean" || (Array.isArray(value) && value.every((item) => typeof item === "string")))) errors[key] = "invalid value";
  }
  for (const field of submissionFields(fields)) {
    const source = columns.includes(field.field_key as any) ? input : submission;
    if (partial && !(field.field_key in source)) continue;
    const error = validateField(field, source[field.field_key]);
    if (error) errors[field.field_key] = error;
  }
  for (const key of columns) {
    if (partial && !(key in input)) continue;
    const value = input[key];
    if (value !== null && typeof value !== "string") errors[key] = "invalid value";
    if ((key === "title" || key === "description") && (typeof value !== "string" || !value.trim())) errors[key] = "required";
    const max = key === "title" ? 200 : 10000;
    if (typeof value === "string" && value.length > max) errors[key] = "too long";
    if (key === "source_url" && typeof value === "string" && value) {
      try { if (!/^https?:$/.test(new URL(value).protocol)) errors[key] = "invalid URL"; } catch { errors[key] = "invalid URL"; }
    }
  }
  const priority = input.priority;
  const configuredPriorities = fields.find((field) => field.field_key === "priority")?.options_json;
  if (priority != null && priority !== "" && !(Array.isArray(configuredPriorities) ? configuredPriorities : ["critical", "high", "medium", "low"]).includes(priority)) errors.priority = "invalid option";
  if (Object.keys(errors).length) fail("validation failed", 422, errors);
  return { input, submission };
}

async function audit(client: any, actor: TicketActor, action: string, id: string, before: unknown, after: unknown) {
  await client.query(
    `INSERT INTO audit_events(actor_type,actor_id,action,entity_type,entity_id,before_json,after_json)
     VALUES ($1,$2,$3,'ticket',$4,$5,$6)`,
    [actor.role, actor.userId, action, id, before, after],
  );
}

export async function listSubmissionProjects(actor: TicketActor): Promise<{ id: string; name: string; slug: string; enabled: boolean }[]> {
  const sql = actor.role === "admin"
    ? "SELECT id,name,slug,enabled FROM projects ORDER BY name,id"
    : `SELECT p.id,p.name,p.slug,p.enabled FROM projects p JOIN project_memberships m ON m.project_id=p.id
       WHERE m.user_id=$1 ORDER BY p.name,p.id`;
  return (await pool.query(sql, actor.role === "admin" ? [] : [actor.userId])).rows;
}

export async function listSubmissions(actor: TicketActor, filter: { project_id?: string; search?: string; offset?: number }): Promise<ReporterTicket[]> {
  const params: unknown[] = [];
  const where = ["t.submitter_deleted_at IS NULL"];
  if (actor.role === "reporter") { params.push(actor.userId); where.push(`EXISTS(SELECT 1 FROM project_memberships m WHERE m.project_id=t.project_id AND m.user_id=$${params.length})`); }
  if (filter.project_id) { params.push(filter.project_id); where.push(`t.project_id=$${params.length}`); }
  if (filter.search) { params.push(`%${filter.search}%`); where.push(`(t.ticket_number ILIKE $${params.length} OR t.title ILIKE $${params.length} OR COALESCE(t.description,'') ILIKE $${params.length})`); }
  params.push(Math.max(0, Number.isInteger(filter.offset) ? Number(filter.offset) : 0));
  const rows = (await pool.query(
    `SELECT t.*,p.name project_name FROM tickets t JOIN projects p ON p.id=t.project_id
     WHERE ${where.join(" AND ")} ORDER BY t.submission_updated_at DESC,t.id DESC LIMIT 50 OFFSET $${params.length}`,
    params,
  )).rows;
  return Promise.all(rows.map(async (row: any) => reporterTicket(row, actor, await fieldsFor(pool, row.form_id))));
}

export async function getSubmission(actor: TicketActor, ref: string): Promise<ReporterTicket | null> {
  const row = await ticketForActor(pool, actor, ref);
  return row ? reporterTicket({ ...row, attachments: await attachmentsForActor(pool, actor, ref) }, actor, await fieldsFor(pool, row.form_id)) : null;
}

export async function createSubmission(actor: TicketActor, inputValue: SubmissionFields & { project_id: string; attachment_upload_ids?: AttachmentSelection }): Promise<ReporterTicket> {
  return inTransaction(async (client) => {
    await lockTicketActor(client, actor);
    const preliminary = object(inputValue);
    if (typeof preliminary.project_id !== "string") fail("project_id is required");
    await requireProjectAccess(client, actor, preliminary.project_id);
    const project = (await client.query("SELECT id,enabled FROM projects WHERE id=$1", [preliminary.project_id])).rows[0];
    if (!project?.enabled) fail("project is disabled", 422);
    const fields = await fieldsFor(client, null);
    const { input, submission } = validated(inputValue, fields, false);
    const selection = input.attachment_upload_ids === undefined ? {} : object(input.attachment_upload_ids) as AttachmentSelection;
    const number = (await client.query("SELECT nextval('ticket_number_sequence') AS number")).rows[0].number;
    const ticket = (await client.query(
      `INSERT INTO tickets(ticket_number,project_id,title,description,category,priority,source_url,environment,
       expected_behavior,actual_behavior,reproduction_steps,status,created_by_user_id,custom_values_json)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [`DCC-${number}`, input.project_id, String(input.title).trim(), String(input.description).trim(), input.category || null,
        input.priority || null, input.source_url || null, input.environment || null, input.expected_behavior || null,
        input.actual_behavior || null, input.reproduction_steps || null, actor.role === "reporter" ? "Submitted" : "Triage", actor.userId, submission],
    )).rows[0];
    await setTicketAttachments(client, actor, ticket, selection, fields.filter((field: any) => field.field_type === "image_upload").map((field: any) => field.field_key));
    await client.query(
      `INSERT INTO ticket_status_history(ticket_id,previous_status,new_status,reason,actor_type,actor_id)
       VALUES($1,NULL,$2,$3,$4,$5)`,
      [ticket.id, ticket.status, actor.role === "reporter" ? "Submitted by reporter" : "Created by admin", actor.role, actor.userId],
    );
    await audit(client, actor, "ticket.create", ticket.id, null, ticket);
    await enqueueNotification(client, "ticket.created", ticket.id, ticket.id);
    return reporterTicket({ ...ticket, project_name: (await client.query("SELECT name FROM projects WHERE id=$1", [ticket.project_id])).rows[0].name,
      attachments: await attachmentsForActor(client, actor, ticket.id) }, actor, fields);
  });
}

export async function updateSubmission(actor: TicketActor, ref: string, inputValue: Partial<SubmissionFields> & { submission_revision: number; attachment_upload_ids?: AttachmentSelection }): Promise<ReporterTicket> {
  return inTransaction(async (client) => {
    await lockTicketActor(client, actor);
    const before = await ticketForActor(client, actor, ref, true);
    if (!before) fail("ticket not found", 404);
    const fields = await fieldsFor(client, before.form_id);
    const { input, submission } = validated(inputValue, fields, true);
    const selection = input.attachment_upload_ids === undefined ? undefined : object(input.attachment_upload_ids) as AttachmentSelection;
    if (!Number.isInteger(input.submission_revision) || Number(input.submission_revision) < 1) fail("submission_revision is required");
    if (Number(input.submission_revision) !== Number(before.submission_revision)) fail("ticket changed since it was loaded", 409);
    const custom = { ...(before.custom_values_json ?? {}), ...submission };
    const candidate: any = { ...before, ...Object.fromEntries(columns.filter((key) => key in input).map((key) => [key, input[key]])), custom_values_json: custom };
    const fullErrors: Record<string, string> = {};
    if (!String(candidate.title ?? "").trim()) fullErrors.title = "required";
    if (!String(candidate.description ?? "").trim()) fullErrors.description = "required";
    for (const field of submissionFields(fields)) {
      const value = columns.includes(field.field_key as any) ? candidate[field.field_key] : custom[field.field_key];
      const error = validateField(field, value);
      const previous = columns.includes(field.field_key as any) ? before[field.field_key] : (before.custom_values_json ?? {})[field.field_key];
      if (error && !(error === "invalid option" && JSON.stringify(value) === JSON.stringify(previous))) fullErrors[field.field_key] = error;
    }
    if (Object.keys(fullErrors).length) fail("validation failed", 422, fullErrors);
    const contentChanged = columns.some((key) => key in input && candidate[key] !== before[key]) || JSON.stringify(custom) !== JSON.stringify(before.custom_values_json ?? {});
    const imageKeys = fields.filter((field: any) => field.field_type === "image_upload").map((field: any) => field.field_key);
    const currentAttachments = selection === undefined && !fields.some((field: any) => field.field_type === "image_upload" && field.required)
      ? [] : await attachmentsForActor(client, actor, before.id);
    for (const field of fields.filter((item: any) => item.field_type === "image_upload" && item.required)) {
      const ids = selection && field.field_key in selection
        ? selection[field.field_key]
        : currentAttachments.filter((attachment) => attachment.field_key === field.field_key).map((attachment) => attachment.upload_id);
      if (!ids?.length) fail("validation failed", 422, { [field.field_key]: "required" });
    }
    const attachmentChanged = selection !== undefined && Object.entries(selection).some(([key, ids]) =>
      JSON.stringify([...ids].sort()) !== JSON.stringify(currentAttachments.filter((a) => a.field_key === key).map((a) => a.upload_id).sort()));
    if (!contentChanged && !attachmentChanged) return reporterTicket({ ...before, attachments: await attachmentsForActor(client, actor, before.id) }, actor, fields);
    const entries: [string, unknown][] = columns.filter((key) => key in input).map((key) => [key, candidate[key]]);
    entries.push(["custom_values_json", custom]);
    const updated = (await client.query(
      `UPDATE tickets SET ${entries.map(([key], index) => `${key}=$${index + 2}`).join(",")},
       submission_revision=submission_revision+1,submission_updated_at=now(),updated_at=now()
       WHERE id=$1 AND submission_revision=$${entries.length + 2} RETURNING *`,
      [before.id, ...entries.map(([, value]) => value), input.submission_revision],
    )).rows[0];
    if (!updated) fail("ticket changed since it was loaded", 409);
    if (selection !== undefined) await setTicketAttachments(client, actor, before, selection, imageKeys);
    if (("source_url" in input && input.source_url !== before.source_url) || attachmentChanged) await client.query("SELECT mark_ticket_plan_potentially_stale($1)", [before.id]);
    await audit(client, actor, "ticket.submission.update", before.id, before, updated);
    return reporterTicket({ ...updated, project_name: before.project_name, attachments: await attachmentsForActor(client, actor, before.id) }, actor, fields);
  });
}

export async function deleteOwnSubmission(actor: TicketActor, ref: string): Promise<void> {
  if (actor.role !== "reporter") fail("only reporters can delete their submissions", 403);
  await inTransaction(async (client) => {
    await lockTicketActor(client, actor);
    const ticket = (await client.query(
      `SELECT t.* FROM tickets t WHERE (t.id::text=$1 OR t.ticket_number=$1)
       AND EXISTS(SELECT 1 FROM project_memberships m WHERE m.project_id=t.project_id AND m.user_id=$2)
       FOR UPDATE OF t`, [ref, actor.userId],
    )).rows[0];
    if (!ticket) fail("ticket not found", 404);
    if (ticket.created_by_user_id !== actor.userId) fail("only the creator can delete this ticket", 403);
    if (ticket.submitter_deleted_at) return;
    const updated = (await client.query(
      "UPDATE tickets SET submitter_deleted_at=now(),submitter_deleted_by=$2 WHERE id=$1 RETURNING *",
      [ticket.id, actor.userId],
    )).rows[0];
    await audit(client, actor, "ticket.submitter.delete", ticket.id, ticket, updated);
  });
}
