import { escapeHtml, pool } from "./shared.ts";
import type { PageResult, Session } from "./shared.ts";

export async function render(url: URL, _session: Session, _metrics: Record<string, number>): Promise<PageResult> {
  if (url.pathname !== "/admin/skills") return null;
  const skills = (await pool.query("SELECT * FROM skills ORDER BY category,name")).rows;
  const body = `<div class="eyebrow">Configure</div><h1>Skills</h1><p>Central registry of workspace, project, personal, repository, and external skills.</p>
      <section class="card"><div class="list-head skills-head"><span>Skill</span><span>Description</span><span>Category</span><span>Source</span><span>Version</span><span>State</span></div>
      ${skills.map((skill) => `<div class="ticket-row skills-row"><strong>/${escapeHtml(skill.slug)}</strong><span>${escapeHtml(skill.description)}</span><span>${escapeHtml(skill.category)}</span><span>${escapeHtml(skill.source_type)}</span><span>${escapeHtml(skill.version)}</span><span class="status">${skill.enabled ? "Enabled" : "Disabled"}</span></div>`).join("")}</section>`;
  return { status: 200, title: "Skills", body };
}
