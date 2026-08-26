import { escapeHtml, pool } from "./shared.ts";
import type { PageResult, Session } from "./shared.ts";

const categories = ["All", "Frontend", "Backend", "Database", "Security", "Testing", "Performance", "SEO", "Accessibility", "Architecture", "DevOps"];
const validRisks = new Set(["low", "medium", "high"]);

function riskTone(level: string | null): string {
  return level && validRisks.has(level) ? level : "muted";
}

export async function render(url: URL, _session: Session, _metrics: Record<string, number>): Promise<PageResult> {
  if (url.pathname === "/admin/skills") {
    const skills = (await pool.query("SELECT * FROM skills ORDER BY category,name")).rows;
    const body = `<div class="eyebrow">SKILL.md registry</div><h1>Skills</h1>
      <div class="toolbar"><button class="button" data-validate-all>Validate all</button><button class="button primary" data-register-skill>Register skill</button></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px;align-items:center">
        <input type="search" placeholder="Search skills…" data-skill-search-list style="flex:1 1 240px;min-width:180px;padding:9px 12px;font-size:13.5px;border:1px solid var(--border);border-radius:4px;background:var(--bg)">
        ${categories.map((cat) => `<button class="category-chip" data-category="${cat.toLowerCase()}" style="border:1px solid var(--border);border-radius:99px;padding:4px 12px;background:transparent;cursor:pointer;font-size:12px">${cat}</button>`).join("")}
      </div>
      <section class="card"><div class="list-head" style="display:grid;grid-template-columns:minmax(200px,2fr) 1fr 0.8fr 0.7fr 0.8fr 0.7fr;gap:12px;padding:10px 18px;border-bottom:1px solid var(--border);background:var(--surface2)"><span style="font-size:10px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--text3)">Skill</span><span style="font-size:10px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--text3)">Category</span><span style="font-size:10px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--text3)">Scope</span><span style="font-size:10px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--text3)">Version</span><span style="font-size:10px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--text3)">Risk</span><span style="font-size:10px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--text3);justify-self:end">State</span></div>
      ${skills.length > 0 ? skills.map((skill) => {
        const tone = riskTone(skill.risk_level);
        return `<a class="skill-list-row" href="/admin/skills/${escapeHtml(skill.id)}" style="display:grid;grid-template-columns:minmax(200px,2fr) 1fr 0.8fr 0.7fr 0.8fr 0.7fr;gap:12px;padding:13px 18px;border-bottom:1px solid var(--border);align-items:center;text-decoration:none;cursor:pointer" data-skill-row="${escapeHtml((skill.category ?? "").toLowerCase())}" data-skill-id="${escapeHtml(skill.id)}">
          <div style="min-width:0"><strong>${escapeHtml(skill.name)}</strong><div style="font-size:11px;color:var(--text3);font-family:monospace">${escapeHtml(skill.slug)}</div></div>
          <span style="font-size:13px;color:var(--text2)">${escapeHtml(skill.category || "—")}</span>
          <span style="font-size:13px;color:var(--text2)">${escapeHtml(skill.source_type === "workspace_global" ? "Global" : skill.source_type === "project_local" ? "Project" : skill.source_type)}</span>
          <span style="font-size:13px;color:var(--text2)">${escapeHtml(skill.version)}</span>
          <span style="font-size:13px;color:var(--t-${tone});font-weight:600">${escapeHtml((skill.risk_level || "low").charAt(0).toUpperCase() + (skill.risk_level || "low").slice(1))}</span>
          <span style="font-size:11.5px;font-weight:600;color:var(--t-${skill.enabled ? "ok" : "muted"});background:var(--s-${skill.enabled ? "ok" : "muted"});padding:3px 9px;border-radius:3px;white-space:nowrap;justify-self:end">${skill.enabled ? "Enabled" : "Disabled"}</span>
        </a>`;
      }).join("") : "<div style=\"padding:48px 20px;text-align:center;color:var(--text3);font-size:13.5px\">No skills match.</div>"}
      </section>
      <dialog data-register-skill-modal aria-label="Register skill"><div class="card-head">Register skill</div><form data-register-skill-form><div class="card-body"><label class="field"><span>Slug</span><input name="slug" required placeholder="kebab-case"></label><label class="field"><span>Name</span><input name="name" required></label><label class="field"><span>Description</span><textarea name="description" rows="3"></textarea></label><label class="field"><span>Category</span><select name="category"><option value="">—</option>${categories.slice(1).map((cat) => `<option value="${cat}">${cat}</option>`).join("")}</select></label><label class="field"><span>Source type</span><select name="source_type" required><option value="">—</option><option value="workspace_global">Global workspace skill</option><option value="project_local">Project-specific skill</option></select></label><label class="field"><span>Filesystem path</span><input name="filesystem_path" placeholder="skills/…/SKILL.md"><small style="color:var(--text3);font-size:11.5px">Global workspace skill: absolute path, e.g. <code>/home/user/.claude/skills/&lt;slug&gt;/SKILL.md</code>. Project-specific skill: relative to the skills root, e.g. <code>skills/vendor/&lt;name&gt;/SKILL.md</code>.</small></label><label class="field"><span>Version</span><input name="version" value="1.0.0"></label><label class="field"><span>Risk level</span><select name="risk_level"><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label><label style="display:flex;flex-direction:row;gap:9px;align-items:center;font-size:13px"><input type="checkbox" name="enabled" checked style="accent-color:var(--primary)"><span>Enabled</span></label><p class="error" role="alert"></p></div><div style="padding:12px 18px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px"><button class="button" type="button" data-close-modal>Cancel</button><button class="button primary" type="submit">Register skill</button></div></form></dialog>`;
    return { status: 200, title: "Skills", body };
  }
  const skillPageMatch = url.pathname.match(/^\/admin\/skills\/([^/]+)$/);
  if (skillPageMatch) {
    const skill = (await pool.query("SELECT * FROM skills WHERE id::text=$1 OR slug=$1", [decodeURIComponent(skillPageMatch[1])])).rows[0];
    if (!skill) return { status: 404, title: "Skill not found", body: "<h1>Skill not found</h1>" };
    const validation = skill.configuration_json?.last_validation_result || {};
    const tone = riskTone(skill.risk_level);
    const [projects, runs] = await Promise.all([
      pool.query("SELECT COUNT(*) as count FROM project_skills WHERE skill_id=$1", [skill.id]),
      pool.query("SELECT COUNT(*) as count FROM skill_snapshots WHERE skills_json @> $1", [JSON.stringify([{ id: skill.id }])]),
    ]);
    const body = `<div class="eyebrow">SKILL.md registry / Skills</div><h1 style="max-width:24ch">${escapeHtml(skill.name)}</h1>
      <div style="display:flex;gap:8px;margin-bottom:16px;align-items:center">
        <span style="font-size:11.5px;color:var(--text3)">v${escapeHtml(skill.version)}</span>
        ${skill.content_hash ? `<span style="font-size:11.5px;color:var(--text3);font-family:monospace">· ${escapeHtml(skill.content_hash.slice(0, 12))}</span>` : ""}
        <span style="font-size:11.5px;font-weight:600;color:var(--t-${tone});background:var(--s-${tone});padding:3px 9px;border-radius:3px">${escapeHtml((skill.risk_level || "low").charAt(0).toUpperCase() + (skill.risk_level || "low").slice(1))} risk</span>
      </div>
      <div class="toolbar"><button class="button" data-validate-skill>Validate</button><button class="button primary" data-save-skill>Save</button></div>
      <div class="grid two"><section class="card"><div class="card-head">Reference</div><div class="card-body" style="display:flex;flex-direction:column;gap:16px">
        <div><label class="field" style="gap:8px"><span style="font-size:11.5px;font-weight:600;color:var(--text2)">Prompt line</span><pre style="background:var(--code-bg);font-family:'JetBrains Mono',monospace;font-size:11.5px;line-height:1.85;color:var(--text2);white-space:pre-wrap;padding:8px;border-radius:4px;margin:0">- ${escapeHtml(skill.slug)}: ${escapeHtml(skill.filesystem_path || "")}</pre></label></div>
        <div><label class="field"><span>Description</span><textarea name="description" data-skill-description rows="4">${escapeHtml(skill.description || "")}</textarea></label></div>
        <div><label class="field"><span>Filesystem path</span><div style="display:flex;gap:8px;align-items:center"><input type="text" name="filesystem_path" data-skill-path value="${escapeHtml(skill.filesystem_path || "")}" style="flex:1;border:1px solid var(--border);background:var(--bg);border-radius:4px;padding:9px 11px;font-size:13px">${validation.valid ? `<span style="font-size:11.5px;font-weight:600;color:var(--t-ok);background:var(--s-ok);padding:3px 9px;border-radius:3px">Resolves</span>` : ""}</div></label></div>
        <div style="border:1px solid var(--border);border-left:2px solid var(--t-info);border-radius:4px;padding:12px 14px;background:var(--s-info);font-size:12.5px;line-height:1.65;color:var(--text)">The registry points to Git-controlled skill files. For each run, the worker records a content-hashed snapshot, reconstructs it in a temporary .claude/skills/ bundle, then deletes that bundle when the run ends.</div>
      </div></section><section class="card"><div class="card-head">Registry entry</div><div class="card-body" style="display:flex;flex-direction:column;gap:8px">
        <div style="display:flex;justify-content:space-between;gap:10px;padding:7px 0"><span style="font-size:12.5px;color:var(--text3)">Category</span><span style="font-size:12.5px;color:var(--text2)">${escapeHtml(skill.category || "—")}</span></div>
        <div style="display:flex;justify-content:space-between;gap:10px;padding:7px 0"><span style="font-size:12.5px;color:var(--text3)">Source</span><span style="font-size:12.5px;color:var(--text2)">${escapeHtml(skill.source_type)}</span></div>
        <div style="display:flex;justify-content:space-between;gap:10px;padding:7px 0"><span style="font-size:12.5px;color:var(--text3)">Phases</span><span style="font-size:12.5px;color:var(--text2)">—</span></div>
        <div style="display:flex;justify-content:space-between;gap:10px;padding:7px 0"><span style="font-size:12.5px;color:var(--text3)">Projects</span><span style="font-size:12.5px;color:var(--text2)">${escapeHtml(String(projects.rows[0]?.count ?? 0))}</span></div>
        <div style="display:flex;justify-content:space-between;gap:10px;padding:7px 0"><span style="font-size:12.5px;color:var(--text3)">Used in runs</span><span style="font-size:12.5px;color:var(--text2)">${escapeHtml(String(runs.rows[0]?.count ?? 0))}</span></div>
        <div style="display:flex;justify-content:space-between;gap:10px;padding:7px 0"><span style="font-size:12.5px;color:var(--text3)">Filesystem path</span><span style="font-size:12.5px;color:var(--text2);font-family:monospace">${escapeHtml(skill.filesystem_path || "—")}</span></div>
        <div style="display:flex;justify-content:space-between;gap:10px;padding:7px 0"><span style="font-size:12.5px;color:var(--text3)">Content hash</span><span style="font-size:12.5px;color:var(--text2);font-family:monospace">${escapeHtml(skill.content_hash || "—")}</span></div>
        <hr style="border:none;border-top:1px solid var(--border);margin:12px 0">
        <div><div style="font-size:11.5px;font-weight:600;color:var(--text2);margin-bottom:8px">Last validation</div>
        ${validation.valid ? `<div style="display:flex;flex-direction:column;gap:4px">
          <div style="display:flex;gap:8px;align-items:center"><span style="width:8px;height:8px;border-radius:50%;background:var(--t-ok);flex-shrink:0"></span><span style="font-size:12.5px;color:var(--text2)">SKILL.md front matter valid</span></div>
          <div style="display:flex;gap:8px;align-items:center"><span style="width:8px;height:8px;border-radius:50%;background:var(--t-ok);flex-shrink:0"></span><span style="font-size:12.5px;color:var(--text2)">Required tools available</span></div>
          <div style="display:flex;gap:8px;align-items:center"><span style="width:8px;height:8px;border-radius:50%;background:var(--t-ok);flex-shrink:0"></span><span style="font-size:12.5px;color:var(--text2)">References resolve</span></div>
        </div>` : "<p style=\"font-size:12.5px;color:var(--text3)\">Never validated</p>"}</div>
      </div></section></div>
      <div style="margin-top:16px">${skill.enabled
  ? `<button class="button" style="border:1px solid var(--t-danger);color:var(--t-danger);background:transparent" data-disable-skill>Disable skill</button>`
  : `<button class="button" style="border:1px solid var(--t-ok);color:var(--t-ok);background:transparent" data-enable-skill>Enable skill</button>`
}</div>`;
    return { status: 200, title: skill.slug, body };
  }
  return null;
}
