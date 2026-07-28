import { escapeHtml, fieldsFor, pool, standardFields } from "./shared.ts";
import type { PageResult, Session } from "./shared.ts";

export async function render(url: URL, _session: Session, _metrics: Record<string, number>): Promise<PageResult> {
  const formPageMatch = url.pathname.match(/^\/admin\/forms\/([^/]+)$/);
  if (formPageMatch) {
    const form = (await pool.query("SELECT * FROM forms WHERE id::text=$1 OR slug=$1", [decodeURIComponent(formPageMatch[1])])).rows[0];
    if (!form) return { status: 404, title: "Form not found", body: "<h1>Form not found</h1>" };
    const fields = await fieldsFor(form.id);
    const body = `<div class="eyebrow">Configure · Form builder</div><h1>${escapeHtml(form.name)}</h1><div class="toolbar"><span class="status">${escapeHtml(form.status)}</span><a class="button" href="/f/${escapeHtml(form.slug)}">Preview public form</a></div>
      <div class="grid two"><section class="card"><div class="card-head">Settings</div><div class="card-body"><dl><dt>Public title</dt><dd>${escapeHtml(form.title)}</dd><dt>Slug</dt><dd class="mono">${escapeHtml(form.slug)}</dd><dt>Description</dt><dd>${escapeHtml(form.description)}</dd><dt>Project binding</dt><dd>${form.fixed_project_id ? "Fixed project" : "Submitter selects"}</dd></dl></div></section>
      <section class="card"><div class="card-head">Fields</div><div class="card-body">${fields.map((field) => `<div class="note"><strong>${escapeHtml(field.label)}</strong><div class="mono">${escapeHtml(field.field_key)} · ${escapeHtml(field.field_type)}${field.required ? " · required" : ""}</div></div>`).join("")}</div></section></div>`;
    return { status: 200, title: form.name, body };
  }
  if (url.pathname === "/admin/forms") {
    const forms = (await pool.query("SELECT f.*,count(ff.id)::integer field_count FROM forms f LEFT JOIN form_fields ff ON ff.form_id=f.id GROUP BY f.id ORDER BY f.name")).rows;
    const body = `<div class="eyebrow">Configure</div><h1>Forms</h1><div class="grid two">${forms.map((form) => `<a class="card" href="/admin/forms/${escapeHtml(form.slug)}"><div class="card-body"><span class="status">${escapeHtml(form.status)}</span><h2>${escapeHtml(form.name)}</h2><p>${escapeHtml(form.title)}</p><span>${form.field_count || standardFields.length} fields</span></div></a>`).join("")}</div>`;
    return { status: 200, title: "Forms", body };
  }
  return null;
}
