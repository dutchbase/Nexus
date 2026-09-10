import type { Session } from "../session.ts";
import { escapeHtml, formControls } from "../ui.ts";
import { getSubmission, getSubmissionFields, listSubmissionAttachments, listSubmissionProjects, listSubmissions } from "../ticket-submissions.ts";

const actor = (session: Session) => ({ userId: session.user_id, role: session.role });
const date = (value: string) => new Date(value).toLocaleString("nl-NL");
const safeFields = (fields: any[]) => fields.filter((field) => !["static", "hidden", "image_upload"].includes(field.field_type) && !["project_id", "submitter_name", "submitter_email"].includes(field.field_key));
const fieldData = (fields: any[]) => escapeHtml(JSON.stringify(safeFields(fields).map(({ field_key, field_type }) => ({ field_key, field_type }))));

async function list(url: URL, session: Session) {
  const projects = await listSubmissionProjects(actor(session));
  const selected = url.searchParams.get("project_id") ?? "";
  const search = url.searchParams.get("search") ?? "";
  const selectedProject = projects.some((project) => project.id === selected) ? selected : undefined;
  const tickets = await listSubmissions(actor(session), { project_id: selectedProject, search: search || undefined });
  const enabled = projects.filter((project) => project.enabled);
  const fields = await getSubmissionFields(actor(session));
  const projectOptions = projects.map((project) => `<option value="${escapeHtml(project.id)}"${selectedProject === project.id ? " selected" : ""}>${escapeHtml(project.name)}${project.enabled ? "" : " (disabled)"}</option>`).join("");
  const createOptions = enabled.map((project) => `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name)}</option>`).join("");
  const rows = tickets.map((ticket) => `<a class="ticket-row" href="/tickets/${encodeURIComponent(ticket.ticket_number)}"><span class="mono">${escapeHtml(ticket.ticket_number)}</span><strong>${escapeHtml(ticket.title)}</strong><span>${escapeHtml(ticket.project_name)}</span><time datetime="${escapeHtml(ticket.submission_updated_at)}">${date(ticket.submission_updated_at)}</time></a>`).join("") || "<p>No tickets found.</p>";
  const noProjects = projects.length ? "" : '<p class="status warn">No projects assigned. Ask your Nexus administrator for access.</p>';
  const create = enabled.length ? `<details class="card"><summary class="card-head">Add ticket</summary><form class="card-body" data-ticket-form data-create data-fields="${fieldData(fields)}"><label class="field"><span>Project</span><select name="project_id" required>${createOptions}</select></label>${formControls(fields, [], {}, "reporter")}<button class="button primary" type="submit">Add ticket</button><p class="error" role="alert"></p></form></details>` : "";
  return { status: 200, title: "Tickets", body: `<div class="page-head"><div><h1><a href="/tickets">Tickets</a></h1><p>Tickets in your assigned projects.</p></div></div>${noProjects}<form method="get" class="filters"><label class="field"><span>Project</span><select name="project_id"><option value="">All assigned projects</option>${projectOptions}</select></label><label class="field"><span>Search</span><input name="search" value="${escapeHtml(search)}"></label><button class="button" type="submit">Filter</button></form>${create}<section class="card"><div class="card-head">Tickets</div>${rows}</section>` };
}

async function detail(ref: string, session: Session) {
  const ticket = await getSubmission(actor(session), ref);
  if (!ticket) return { status: 404, title: "Ticket not found", body: "<h1>Ticket not found</h1>" };
  const [fields, attachments] = await Promise.all([getSubmissionFields(actor(session), ref), listSubmissionAttachments(actor(session), ref)]);
  const filtered = safeFields(fields);
  const values = { ...ticket.submission, ...ticket };
  const labels = new Map(filtered.map((field) => [field.field_key, field.label]));
  const standard = ["description", "category", "priority", "source_url", "environment", "expected_behavior", "actual_behavior", "reproduction_steps"];
  const details = [...standard.map((key) => [labels.get(key) ?? key.replaceAll("_", " "), (ticket as any)[key]]), ...Object.entries(ticket.submission).filter(([key]) => labels.has(key)).map(([key, value]) => [labels.get(key), value])]
    .filter(([, value]) => value !== null && value !== undefined && value !== "" && (!Array.isArray(value) || value.length))
    .map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd style="white-space:pre-wrap">${escapeHtml(Array.isArray(value) ? value.join(", ") : typeof value === "boolean" ? value ? "Yes" : "No" : value)}</dd>`).join("");
  const images = attachments.map((attachment: any) => { const href = `/attachments/${escapeHtml(attachment.id)}`; return `<figure><a href="${href}" target="_blank" rel="noopener"><img loading="lazy" src="${href}" alt="${escapeHtml(attachment.original_name ?? "attachment")}" style="max-width:100%;max-height:420px;object-fit:contain"></a><figcaption>${escapeHtml(attachment.original_name ?? "attachment")} · <a href="${href}?download=1">Download original</a></figcaption></figure>`; }).join("") || "<p>No images attached.</p>";
  const deletion = ticket.can_delete ? `<button class="button" type="button" data-delete-ticket>Delete</button><dialog data-delete-dialog data-ticket-id="${escapeHtml(ticket.id)}"><h2>Delete this ticket from the ticket portal?</h2><p>Nexus keeps the admin record and operational history.</p><p class="error" role="alert"></p><button class="button" type="button" data-cancel-delete>Cancel</button> <button class="button" type="button" data-confirm-delete>Delete</button></dialog>` : "";
  return { status: 200, title: ticket.ticket_number, body: `<p><a href="/tickets">← Tickets</a></p><div class="page-head"><div><span class="mono">${escapeHtml(ticket.ticket_number)}</span><h1>${escapeHtml(ticket.title)}</h1><p>${escapeHtml(ticket.project_name)} · submission updated ${date(ticket.submission_updated_at)}</p></div>${deletion}</div><section class="card"><div class="card-head">Original submission</div><div class="card-body"><dl>${details}</dl></div></section><section class="card"><div class="card-head">Edit submission</div><form class="card-body" data-ticket-form data-ticket-id="${escapeHtml(ticket.id)}" data-fields="${fieldData(fields)}"><input type="hidden" name="submission_revision" value="${ticket.submission_revision}">${formControls(fields, [], values, "reporter")}<button class="button primary" type="submit">Save changes</button><p class="error" role="alert"></p></form></section><section class="card"><div class="card-head">Images</div><div class="card-body">${images}</div></section>` };
}

export const reporterTicketsPage = {
  async render(url: URL, session: Session): Promise<{ status: number; title: string; body: string } | null> {
    if (url.pathname === "/tickets") return list(url, session);
    const match = url.pathname.match(/^\/tickets\/([^/]+)$/);
    return match ? detail(decodeURIComponent(match[1]), session) : null;
  },
};
