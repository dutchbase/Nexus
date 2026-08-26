import { escapeHtml, fieldsFor, pool, standardFields } from "./shared.ts";
import type { PageResult, Session } from "./shared.ts";

export const fieldTypeLabels: [string, string][] = [
  ["short_text", "Short text"], ["long_text", "Long text"], ["email", "E-mail"], ["url", "URL"],
  ["number", "Number"], ["dropdown", "Dropdown"], ["radio", "Radio"], ["checkbox", "Checkbox"],
  ["multi_select", "Multi-select"], ["project_selector", "Project selector"], ["category_selector", "Category selector"],
  ["environment_selector", "Environment selector"], ["image_upload", "Image upload"], ["hidden", "Hidden field"],
  ["static", "Static text"],
];
const optionTypes = new Set(["dropdown", "radio", "multi_select", "category_selector", "environment_selector"]);

export const previewField = (field: { field_type: string; label: string; required: boolean }) =>
  field.field_type === "image_upload"
    ? `<label class="field"><span>${escapeHtml(field.label)}${field.required ? " *" : ""}</span><input type="file" disabled accept="image/png,image/jpeg" multiple><small>PNG of JPG · max 5 bestanden · max 5 MB per bestand</small></label>`
    : `<label class="field"><span>${escapeHtml(field.label)}${field.required ? " *" : ""}</span><input disabled placeholder="${escapeHtml(fieldTypeLabels.find(([value]) => value === field.field_type)?.[1] ?? field.field_type)}"></label>`;

export async function render(url: URL, _session: Session, _metrics: Record<string, number>): Promise<PageResult> {
  if (url.pathname === "/admin/forms") {
    const forms = (await pool.query(
      `SELECT f.*,count(DISTINCT ff.id)::integer field_count,count(DISTINCT t.id)::integer submission_count,p.name project_name
       FROM forms f LEFT JOIN form_fields ff ON ff.form_id=f.id LEFT JOIN tickets t ON t.form_id=f.id LEFT JOIN projects p ON p.id=f.fixed_project_id
       GROUP BY f.id,p.name ORDER BY f.name`,
    )).rows;
    const body = `<div class="eyebrow">Public intake</div><h1>Forms</h1><div class="toolbar"><a class="button primary" href="/admin/forms/new">+ New form</a></div>
      ${forms.length ? `<div class="grid two">${forms.map((form) => `<a class="card" href="/admin/forms/${escapeHtml(form.slug)}"><div class="card-body">
        <span class="status">${escapeHtml(form.status)}</span>
        <h2 style="font-family:'Cormorant Garamond',serif;font-size:21px;margin:8px 0 2px">${escapeHtml(form.name)}</h2>
        <p class="mono" style="color:var(--text3);font-size:12px">feedback.example.com/f/${escapeHtml(form.slug)}</p>
        <p style="display:flex;justify-content:space-between;margin:10px 0 0"><span>${form.field_count || standardFields.length} fields · ${form.submission_count} submissions</span><span style="color:var(--text3)">${escapeHtml(form.project_name || "Submitter selects")}</span></p>
      </div></a>`).join("")}</div>` : "<p>No forms yet. Create one to start collecting public feedback.</p>"}`;
    return { status: 200, title: "Forms", body };
  }
  if (url.pathname === "/admin/forms/new") {
    const projects = (await pool.query("SELECT id,name FROM projects ORDER BY name")).rows;
    const body = `<div class="eyebrow">Public intake</div><h1>New form</h1>
      <section class="card"><div class="card-head">Form details</div><div class="card-body">
      <form data-new-form-form>
        <label class="field"><span>Internal name</span><input name="name" required></label>
        <label class="field"><span>Slug</span><input name="slug" required placeholder="auto-generated from name"></label>
        <label class="field"><span>Public title</span><input name="title" required></label>
        <label class="field"><span>Project binding</span><select name="fixed_project_id"><option value="">Submitter selects</option>${projects.map((project) => `<option value="${project.id}">Fixed · ${escapeHtml(project.name)}</option>`).join("")}</select></label>
        <p class="error" role="alert"></p>
        <button class="button primary" type="submit">Create form</button>
      </form></div></section>`;
    return { status: 200, title: "New form", body };
  }
  const formPageMatch = url.pathname.match(/^\/admin\/forms\/([^/]+)$/);
  if (formPageMatch) {
    const form = (await pool.query("SELECT * FROM forms WHERE id::text=$1 OR slug=$1", [decodeURIComponent(formPageMatch[1])])).rows[0];
    if (!form) return { status: 404, title: "Form not found", body: "<h1>Form not found</h1>" };
    const fields = await fieldsFor(form.id);
    const settings = form.settings_json || {};
    const projects = (await pool.query("SELECT id,name FROM projects ORDER BY name")).rows;
    const panel = (index: number, content: string) => `<div role="tabpanel" id="panel-${index}" aria-labelledby="tab-${index}"${index === 0 ? "" : " hidden"}>${content}</div>`;

    const fieldsPanel = `<div class="grid" style="grid-template-columns:minmax(0,1fr) 306px" data-fields-app data-form-id="${form.id}">
      <section class="card"><div class="card-head">Fields</div><div class="card-body" data-field-list></div>
        <div class="card-body" style="border-top:1px solid var(--border)"><button class="button" type="button" style="border-style:dashed" data-add-field>+ Add field</button></div></section>
      <section class="card"><div class="card-head">Field settings</div><div class="card-body" data-field-settings><p>Select a field to edit.</p></div></section>
      <p class="error" role="alert" data-fields-error></p>
    </div>
    <script type="application/json" data-fields-json>${JSON.stringify(fields).replace(/</g, "\\u003c")}</script>
    <script type="application/json" data-field-types>${JSON.stringify(fieldTypeLabels).replace(/</g, "\\u003c")}</script>`;

    const settingsPanel = `<section class="card"><div class="card-head">Form settings</div><div class="card-body">
      <form data-form-settings>
        <label class="field"><span>Internal name</span><input name="name" value="${escapeHtml(form.name)}" required></label>
        <label class="field"><span>Public title</span><input name="title" value="${escapeHtml(form.title)}" required></label>
        <label class="field"><span>Slug</span><input name="slug" value="${escapeHtml(form.slug)}" required class="mono"></label>
        <label class="field"><span>Project binding</span><select name="fixed_project_id"><option value=""${!form.fixed_project_id ? " selected" : ""}>Submitter selects (all ${projects.length})</option>${projects.map((project) => `<option value="${project.id}"${form.fixed_project_id === project.id ? " selected" : ""}>Fixed · ${escapeHtml(project.name)}</option>`).join("")}</select></label>
        <label class="field"><span>Rate limit (submissions / IP / hour)</span><input name="rate_limit" type="number" min="1" value="${escapeHtml(settings.rate_limit ?? 15)}"></label>
        <label class="field"><span>CAPTCHA</span><select name="captcha_mode" disabled><option value="honeypot" selected>Honeypot (built-in)</option></select></label>
        <label class="field"><span>Completion message</span><textarea name="completion_message" rows="4">${escapeHtml(settings.completion_message ?? "")}</textarea></label>
        <label style="display:flex;gap:9px;align-items:center;font-size:13px;margin:10px 0"><input type="checkbox" name="notify_on_submission"${settings.notify_on_submission !== false ? " checked" : ""}> Notify on submission</label>
        <label style="display:flex;gap:9px;align-items:center;font-size:13px;margin:10px 0"><input type="checkbox" name="allow_image_attachments"${settings.allow_image_attachments !== false ? " checked" : ""}> Allow image attachments</label>
        <p class="error" role="alert"></p>
        <button class="button primary" type="submit">Save settings</button>
      </form></div></section>`;

    const previewPanel = `<div style="background:var(--surface2);padding:32px 16px;border-radius:6px"><div class="card public" style="max-width:620px;margin:0 auto;border-top:3px solid var(--primary)"><div class="card-body">
      <div class="eyebrow">Feedback</div><h1>${escapeHtml(form.title)}</h1><p>${escapeHtml(form.description ?? "")}</p>
      <div class="grid two">${fields.filter((field) => field.field_type !== "static").map(previewField).join("")}</div>
      <br><button class="button primary" disabled>Melding versturen</button>
    </div></div></div>`;

    const body = `<p><a href="/admin/forms">← Forms</a></p><div class="eyebrow mono">feedback.example.com/f/${escapeHtml(form.slug)}</div>
      <h1>${escapeHtml(form.name)}</h1>
      <div class="toolbar"><span class="status">${escapeHtml(form.status)}</span>
        <a class="button" href="/f/${escapeHtml(form.slug)}" target="_blank" rel="noopener">Open public form ↗</a>
        <button class="button primary" type="button" data-publish-toggle data-form-id="${form.id}" data-status="${escapeHtml(form.status)}">${form.status === "published" ? "Unpublish" : "Publish changes"}</button></div>
      <div class="tabs" role="tablist">${["Fields", "Settings", "Preview"].map((label, index) => `<button type="button" role="tab" id="tab-${index}" aria-controls="panel-${index}" aria-selected="${index === 0}">${label}</button>`).join("")}</div>
      ${[fieldsPanel, settingsPanel, previewPanel].map((content, index) => panel(index, content)).join("")}`;
    return { status: 200, title: form.slug, body };
  }
  return null;
}
