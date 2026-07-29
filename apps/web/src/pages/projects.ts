import { escapeHtml, pool } from "./shared.ts";
import type { PageResult, Session } from "./shared.ts";

function generateYaml(project: any) {
  const config = project.config_json || {};
  const validationCommands = config.validation_commands || {};
  const lines = [
    `name: ${project.name}`,
    `repository_path: ${project.repository_path}`,
    `github_owner: ${project.github_owner || ""}`,
    `github_repository: ${project.github_repository || ""}`,
    `default_branch: ${project.default_branch || "main"}`,
    `enabled: ${project.enabled}`,
    `config_version: ${project.config_version}`,
  ];
  if (Object.keys(validationCommands).length > 0) {
    lines.push("validation_commands:");
    for (const [key, value] of Object.entries(validationCommands)) {
      lines.push(`  ${key}: ${value}`);
    }
  }
  return lines.join("\n");
}

export async function render(url: URL, _session: Session, _metrics: Record<string, number>): Promise<PageResult> {
  if (url.pathname === "/admin/projects") {
    const projects = (await pool.query("SELECT * FROM projects ORDER BY name")).rows;
    const body = `<div class="eyebrow">Configure / projects.yaml</div><h1>Projects</h1>
      <div class="toolbar"><button class="button primary" data-add-project-button>+ Add project</button></div>
      <div class="grid">${projects.length ? projects.map((project) =>
        `<a class="card" href="/admin/projects/${escapeHtml(project.slug)}"><div style="border-top:2px solid var(--t-ok)"><div style="padding:13px 18px"><h2 style="font-size:22px;font-family:'Cormorant Garamond',serif;font-weight:700;margin:0 0 8px">${escapeHtml(project.name)}</h2><p style="margin:0;font-size:13px;color:var(--text3)">${escapeHtml(project.description || "")}</p><p style="margin:8px 0 0;font-size:13px"><span class="status">${escapeHtml(project.health_status)}</span></p><p style="margin:8px 0 0;font-size:12.5px;color:var(--text2)" class="mono">${escapeHtml(project.repository_path ?? "")}</p></div></div></a>`,
      ).join("") : `<div style="padding:48px 20px;text-align:center;color:var(--text3);font-size:13.5px">No projects configured yet. Create one to get started.</div>`}</div>
      <dialog data-add-project-modal aria-label="Add project"><div class="card-head">Add project</div><form data-add-project-form><div class="card-body"><label class="field"><span>Project name</span><input name="name" required></label><label class="field"><span>Slug</span><input name="slug" required placeholder="auto-generated from name"></label><label class="field"><span>Repository path</span><input name="repository_path" required></label><label class="field"><span>GitHub owner</span><input name="github_owner"></label><label class="field"><span>GitHub repository</span><input name="github_repository"></label><label class="field"><span>Default branch</span><input name="default_branch" value="main"></label><p class="error" role="alert"></p></div><div style="padding:12px 18px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px"><button class="button" type="button" data-close-modal>Cancel</button><button class="button primary" type="submit">Create project</button></div></form></dialog>`;
    return { status: 200, title: "Projects", body };
  }
  const projectPageMatch = url.pathname.match(/^\/admin\/projects\/([^/]+)$/);
  if (projectPageMatch) {
    const project = (await pool.query("SELECT * FROM projects WHERE id::text=$1 OR slug=$1", [decodeURIComponent(projectPageMatch[1])])).rows[0];
    if (!project) return { status: 404, title: "Project not found", body: "<h1>Project not found</h1>" };
    const [skillsResult, promptsResult, allSkillsResult] = await Promise.all([
      pool.query(
        `SELECT ps.*,s.slug,s.name,s.category,s.version FROM project_skills ps
         JOIN skills s ON s.id=ps.skill_id WHERE ps.project_id=$1 ORDER BY s.name`,
        [project.id],
      ),
      pool.query(
        `SELECT pf.*,pv.version active_version
         FROM prompt_files pf LEFT JOIN prompt_versions pv ON pv.id=pf.active_version_id
         WHERE pf.project_id=$1 ORDER BY pf.prompt_type`,
        [project.id],
      ),
      pool.query(
        `SELECT s.*,ps.id IS NOT NULL attached FROM skills s
         LEFT JOIN project_skills ps ON ps.skill_id=s.id AND ps.project_id=$1
         ORDER BY s.category,s.name`,
        [project.id],
      ),
    ]);
    const dirty = project.health_status === "repository_dirty";
    const config = project.config_json || {};
    const validationCommands = config.validation_commands || {};
    const branchPrefix = config.branch_prefix || "";
    const yaml = generateYaml(project);
    const panel = (index: number, content: string) => `<div role="tabpanel" id="panel-${index}" aria-labelledby="tab-${index}"${index === 0 ? "" : " hidden"}>${content}</div>`;
    const overviewPanel = `<section class="card"><div class="card-head">Paths & repository</div><div class="card-body"><form data-project-form data-project-id="${project.id}">
      <label class="field"><span>Local repository path</span><input name="repository_path" value="${escapeHtml(project.repository_path)}" required></label>
      <label class="field"><span>GitHub owner / repository</span><div style="display:grid;grid-template-columns:1fr 1fr;gap:8px"><input name="github_owner" placeholder="Owner" value="${escapeHtml(project.github_owner || "")}"><input name="github_repository" placeholder="Repository" value="${escapeHtml(project.github_repository || "")}"></div></label>
      <label class="field"><span>Default branch</span><input name="default_branch" value="${escapeHtml(project.default_branch)}" required></label>
      <label class="field"><span>Branch prefix</span><input name="branch_prefix" value="${escapeHtml(branchPrefix)}"></label></form></div></section>
      <section class="card"><div class="card-head">Validation commands</div><div class="card-body" style="display:flex;flex-direction:column;gap:8px">${["install", "lint", "typecheck", "test", "build"].map((cmd) =>
        `<div style="display:flex;gap:8px;align-items:center"><span class="mono" style="min-width:80px;color:var(--text3)">${escapeHtml(cmd)}</span><input data-cmd="${cmd}" style="flex:1" value="${escapeHtml(validationCommands[cmd] || "")}" placeholder="Command"></div>`,
      ).join("")}</div></section>`;
    const yamlPanel = `<section class="card"><div class="card-head">config/projects.yaml · version ${project.config_version}</div><div class="card-body"><pre style="background:var(--code-bg);padding:12px;border-radius:4px;font-family:'JetBrains Mono',monospace;font-size:12px;overflow-x:auto">${escapeHtml(yaml)}</pre></div></section>`;
    const skillsPanel = `<section class="card"><div class="card-head">Automatically attached to every ticket</div><div class="card-body">${allSkillsResult.rows.length > 0 ? allSkillsResult.rows.map((skill) =>
      `<label style="padding:8px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--border)"><div><strong>${escapeHtml(skill.name)}</strong> <span class="mono" style="font-size:11px;color:var(--text3)">${escapeHtml(skill.slug)}</span> <span style="font-size:11px;font-weight:600;color:var(--text3)">${escapeHtml(skill.category)}</span> <span style="font-size:11px;color:var(--text3)">v${escapeHtml(skill.version)}</span></div><input type="checkbox" data-skill-checkbox value="${skill.id}" ${skill.attached ? "checked" : ""}></label>`,
    ).join("") : "<p>No skills available.</p>"}</div></section>`;
    const validationPanel = `<section class="card"><div class="card-head">Last validation</div><div class="card-body"><p>${project.last_validated_at ? `Validated ${new Date(project.last_validated_at).toLocaleString("nl-NL")}` : "Never validated"}</p>
      <div style="display:flex;flex-direction:column;gap:8px">${["Repository path exists and is a Git repository", "Remote reachable · default branch exists · fetch succeeded", "Worktree root writable", "Primary checkout clean", "Prompt files present · automatic skills resolve", "Claude subscription auth · GitHub auth valid"].map((msg) =>
        `<p style="display:flex;gap:8px;align-items:center"><span style="width:8px;height:8px;border-radius:50%;background:var(--border2);flex-shrink:0"></span>${msg}</p>`,
      ).join("")}</div></div></section>`;
    const promptsPanel = `<section class="card"><div class="card-head">Project prompt files</div><div class="card-body">${promptsResult.rows.length > 0 ? promptsResult.rows.map((prompt) =>
      `<p><a href="/admin/prompts/${prompt.id}">${escapeHtml(prompt.prompt_type)}.md v${prompt.active_version || "—"} · ${prompt.active_version ? "active" : "inactive"}</a></p>`,
    ).join("") : "<p>No project prompts.</p>"}</div></section>`;
    const body = `<div class="eyebrow">Configure / Projects</div><h1>${escapeHtml(project.name)}</h1>
      <div class="toolbar"><button class="button" data-validate-button>Run validation</button><button class="button primary" data-save-button>Save configuration</button></div>
      ${dirty ? `<div style="border:1px solid var(--t-danger);border-left:3px;background:var(--s-danger);border-radius:5px;padding:13px 16px"><strong>Planning and execution are blocked.</strong> <em>The primary checkout has ${escapeHtml(String(config.uncommitted_count || 3))} uncommitted files. Resolve them on the server — the platform never resets a checkout automatically.</em></div>` : ""}
      <div class="tabs" role="tablist">${["Overview", "YAML config", "Skills", "Validation", "Prompts"].map((label, index) => `<button type="button" role="tab" id="tab-${index}" aria-controls="panel-${index}" aria-selected="${index === 0}">${label}</button>`).join("")}</div>
      ${[overviewPanel, yamlPanel, skillsPanel, validationPanel, promptsPanel].map((content, index) => panel(index, content)).join("")}`;
    return { status: 200, title: project.name, body };
  }
  return null;
}
