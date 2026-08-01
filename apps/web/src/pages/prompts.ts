import { allowedTemplateVariables, escapeHtml, pool, renderMarkdown } from "./shared.ts";
import type { PageResult, Session } from "./shared.ts";

export async function render(url: URL, _session: Session, _metrics: Record<string, number>): Promise<PageResult> {
  if (url.pathname === "/admin/prompts") {
    const prompts = (await pool.query(
      `SELECT pf.*,p.name project_name,pv.version active_version
       FROM prompt_files pf LEFT JOIN projects p ON p.id=pf.project_id
       LEFT JOIN prompt_versions pv ON pv.id=pf.active_version_id
       WHERE pf.scope='global'
       ORDER BY pf.scope,p.name,pf.prompt_type`,
    )).rows;
    const body = `<div class="eyebrow">Configure</div><h1>Prompts</h1><p>Global prompts apply to every project. Add per-project overrides from a project's Prompts tab.</p>
      <section class="card"><div class="list-head" style="display:grid;grid-template-columns:minmax(200px,2fr) 1fr 1fr;gap:12px;padding:10px 18px;border-bottom:1px solid var(--border);background:var(--surface2)"><span style="font-size:10px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--text3)">Prompt type</span><span style="font-size:10px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--text3)">Active version</span><span style="font-size:10px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--text3);justify-self:end">Status</span></div>
      ${prompts.length > 0 ? prompts.map((prompt) =>
        `<a class="prompt-list-row" href="/admin/prompts/${prompt.id}" style="display:grid;grid-template-columns:minmax(200px,2fr) 1fr 1fr;gap:12px;padding:13px 18px;border-bottom:1px solid var(--border);align-items:center;text-decoration:none;cursor:pointer">
          <div style="min-width:0"><strong>${escapeHtml(prompt.prompt_type)}</strong></div>
          <span style="font-size:13px;color:var(--text2)">${prompt.active_version ? `v${prompt.active_version}` : "—"}</span>
          <span class="status ${prompt.active_version ? "ok" : "muted"}" style="justify-self:end">${prompt.active_version ? "Active" : "Inactive"}</span>
        </a>`,
      ).join("") : `<div style="padding:48px 20px;text-align:center;color:var(--text3);font-size:13.5px">No prompt documents yet. Create them through the prompt API.</div>`}
      </section>`;
    return { status: 200, title: "Prompts", body };
  }
  const promptPageMatch = url.pathname.match(/^\/admin\/prompts\/([0-9a-f-]+)$/i);
  if (promptPageMatch) {
    const prompt = (await pool.query(
      `SELECT pf.*,p.name project_name,pv.content active_content,pv.version active_version
       FROM prompt_files pf LEFT JOIN projects p ON p.id=pf.project_id
       LEFT JOIN prompt_versions pv ON pv.id=pf.active_version_id WHERE pf.id=$1`,
      [promptPageMatch[1]],
    )).rows[0];
    if (!prompt) return { status: 404, title: "Prompt not found", body: "<h1>Prompt not found</h1>" };
    const versions = (await pool.query(
      `SELECT pv.*,u.username FROM prompt_versions pv LEFT JOIN users u ON u.id=pv.created_by
       WHERE pv.prompt_file_id=$1 ORDER BY pv.version DESC`,
      [prompt.id],
    )).rows;
    const body = `<div class="eyebrow">Configure · ${escapeHtml(prompt.scope)}${prompt.project_name ? ` · ${escapeHtml(prompt.project_name)}` : ""}</div><h1>${escapeHtml(prompt.prompt_type)} prompt</h1>
      <div class="grid two"><section class="card"><div class="card-head">Markdown editor</div><div class="card-body">
        <form data-prompt-editor data-prompt-id="${prompt.id}"><label class="field"><span>Content</span><textarea name="content" rows="22">${escapeHtml(prompt.active_content)}</textarea></label>
        <p class="mono">Allowed variables: ${[...allowedTemplateVariables].map((item) => `{{${escapeHtml(item)}}}`).join(", ")}</p>
        <button class="button primary" type="submit">Save and activate version</button><button class="button" type="button" data-deactivate>Deactivate</button><p class="error" role="alert"></p></form>
      </div></section><section class="card"><div class="card-head">Rendered preview</div><div class="card-body" data-markdown-preview>${renderMarkdown(prompt.active_content ?? "")}</div></section></div>
      <section class="card"><div class="card-head">Version history</div><div class="card-body">${versions.map((version) =>
        `<p><strong>v${version.version}</strong>${version.id === prompt.active_version_id ? " · active" : ""} · ${escapeHtml(version.username ?? "system")} · <span class="mono">${escapeHtml(version.content_hash.slice(0, 12))}</span>
        <button class="button" data-restore-version="${version.id}">Restore as new version</button>${prompt.active_version_id && prompt.active_version_id !== version.id ? ` <a href="/api/admin/prompts/${prompt.id}/diff?from=${version.id}&to=${prompt.active_version_id}">Diff with active</a>` : ""}</p>`,
      ).join("") || "<p>No versions yet.</p>"}</div></section>`;
    return { status: 200, title: prompt.id, body };
  }
  return null;
}
