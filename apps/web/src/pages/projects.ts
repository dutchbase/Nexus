import { escapeHtml, pool } from "./shared.ts";
import type { PageResult, Session } from "./shared.ts";

export async function render(url: URL, _session: Session, _metrics: Record<string, number>): Promise<PageResult> {
  if (url.pathname === "/admin/projects") {
    const projects = (await pool.query("SELECT * FROM projects ORDER BY name")).rows;
    const body = `<div class="eyebrow">Configure</div><h1>Projects</h1><div class="grid two">${projects.map((project) =>
      `<a class="card" href="/admin/projects/${escapeHtml(project.slug)}"><div class="card-body"><span class="status">${escapeHtml(project.health_status)}</span><h2>${escapeHtml(project.name)}</h2><span class="mono">${escapeHtml(project.repository_path ?? "")}</span></div></a>`,
    ).join("")}</div>`;
    return { status: 200, title: "Projects", body };
  }
  const projectPageMatch = url.pathname.match(/^\/admin\/projects\/([^/]+)$/);
  if (projectPageMatch) {
    const project = (await pool.query("SELECT * FROM projects WHERE id::text=$1 OR slug=$1", [decodeURIComponent(projectPageMatch[1])])).rows[0];
    if (!project) return { status: 404, title: "Project not found", body: "<h1>Project not found</h1>" };
    const dirty = project.health_status === "repository_dirty";
    const body = `<div class="eyebrow">Configure · Project</div><h1>${escapeHtml(project.name)}</h1><p><span class="status">${escapeHtml(project.health_status)}</span></p>
      ${dirty ? '<div class="banner-danger"><strong>Repository dirty</strong> — the checkout has uncommitted changes. Planning and execution are blocked until it is clean; the checkout is never reset automatically.</div>' : ""}
      <section class="card"><div class="card-head">Repository</div><div class="card-body"><dl>
        <dt>Slug</dt><dd class="mono">${escapeHtml(project.slug)}</dd>
        <dt>Repository path</dt><dd class="mono">${escapeHtml(project.repository_path ?? "")}</dd>
        <dt>Default branch</dt><dd class="mono">${escapeHtml(project.default_branch ?? "")}</dd>
        <dt>GitHub</dt><dd class="mono">${escapeHtml(project.github_owner ?? "")}/${escapeHtml(project.github_repository ?? "")}</dd>
      </dl></div></section>`;
    return { status: 200, title: project.name, body };
  }
  return null;
}
