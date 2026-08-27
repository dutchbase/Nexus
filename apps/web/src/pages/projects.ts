import { escapeHtml, pool, statusBadge } from "./shared.ts";
import type { PageResult, Session } from "./shared.ts";
import { globalPromptTypes } from "@dcc/domain";
import type { DeploymentConfig } from "@dcc/project-config";

function generateYaml(project: any) {
  const config = project.config_json || {};
  const validationCommands = config.validation_commands || {};
  const lines = [
    `name: ${project.name}`,
    `repository_path: ${project.repository_path}`,
    `agent_start_path: ${project.agent_start_path || ""}`,
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

type HealthDetail = { summary: Record<string, number>; files: Array<{ path: string; status: string; staged: boolean }> } | null;

function healthSummaryLine(detail: HealthDetail): string {
  if (!detail || !detail.summary || !Object.keys(detail.summary).length) return "uncommitted changes";
  return Object.entries(detail.summary).map(([status, count]) => `${count} ${status} file${count === 1 ? "" : "s"}`).join(", ");
}

// The dirty banner shown at the top of the project page — fixed to read the
// real categorized count instead of the never-populated config.uncommitted_count.
export function dirtyBanner(project: any): string {
  if (project.health_status !== "repository_dirty") return "";
  const summary = healthSummaryLine(project.health_detail_json ?? null);
  return `<div style="border:1px solid var(--t-danger);border-left:3px;background:var(--s-danger);border-radius:5px;padding:13px 16px"><strong>Planning and execution are blocked.</strong> <em>The primary checkout has ${summary}. Resolve them on the server — the platform never resets a checkout automatically.</em></div>`;
}

const STATUS_LABELS: Record<string, string> = {
  conflicted: "Conflicted", modified: "Modified", added: "Added", deleted: "Deleted", renamed: "Renamed", untracked: "Untracked",
};
const STATUS_ORDER = ["conflicted", "modified", "added", "deleted", "renamed", "untracked"];
const CODE_BLOCK_STYLE = "background:var(--code-bg);padding:10px;border-radius:4px;font-family:'JetBrains Mono',monospace;font-size:12px;overflow-x:auto";

function groupedFileList(files: Array<{ path: string; status: string; staged: boolean }>): string {
  const byStatus = new Map<string, Array<{ path: string; status: string; staged: boolean }>>();
  for (const file of files) {
    if (!byStatus.has(file.status)) byStatus.set(file.status, []);
    byStatus.get(file.status)!.push(file);
  }
  return STATUS_ORDER.filter((status) => byStatus.has(status)).map((status) => {
    const items = byStatus.get(status)!;
    const severe = status === "conflicted";
    return `<div style="margin-bottom:10px"><div style="font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${severe ? "var(--t-danger)" : "var(--text3)"}">${STATUS_LABELS[status] ?? status} (${items.length})</div>${items.map((file) =>
      `<div class="mono" style="padding:3px 0;font-size:12.5px;${severe ? "color:var(--t-danger);font-weight:600" : ""}">${escapeHtml(file.path)}${file.staged ? ` <span style="color:var(--text3);font-weight:400">· staged</span>` : ""}</div>`,
    ).join("")}</div>`;
  }).join("");
}

function resolutionGuidance(repositoryPath: string): string {
  const path = escapeHtml(repositoryPath);
  return `<pre style="${CODE_BLOCK_STYLE}">cd ${path}

git status</pre>
<p style="font-size:12.5px">Keep the changes:</p>
<pre style="${CODE_BLOCK_STYLE}">git add &lt;files&gt;
git commit -m "Describe the change"</pre>
<p style="font-size:12.5px">Temporarily set them aside:</p>
<pre style="${CODE_BLOCK_STYLE}">git stash push -u</pre>
<p style="font-size:12.5px">Or remove/ignore unwanted local files.</p>`;
}

// Replaces the previously-static "Last validation" checklist with real
// diagnostics driven by health_detail_json/health_error, plus a live-wired
// Recheck repository button (see ui.ts data-recheck-repository, which
// mirrors this function's grouping/summary logic client-side to re-render
// data-repository-diagnostics in place from the refreshed project JSON).
export function repositoryDiagnosticsPanel(project: any): string {
  const lastValidated = project.last_validated_at ? `Validated ${new Date(project.last_validated_at).toLocaleString("nl-NL")}` : "Never validated";
  const head = `<div class="card-head">Last validation <button class="button" type="button" data-recheck-repository>Recheck repository</button></div>`;
  const open = `<section class="card">${head}<div class="card-body" data-repository-diagnostics data-project-id="${project.id}" data-repository-path="${escapeHtml(project.repository_path ?? "")}"><p>${escapeHtml(lastValidated)}</p>`;

  if (project.health_status === "inspection_error") {
    return `${open}
      <div style="border:1px solid var(--t-danger);border-left:3px;background:var(--s-danger);border-radius:5px;padding:13px 16px">
        <strong>Repository status unavailable.</strong> <em>The repository could not be inspected: ${escapeHtml(project.health_error ?? "unknown error")}. This is distinct from having uncommitted changes — verify the configured repository path exists, is a Git repository, and is readable by the platform.</em>
      </div>
    </div></section>`;
  }

  const detail: HealthDetail = project.health_detail_json ?? null;
  if (project.health_status === "repository_dirty" && detail && detail.files) {
    return `${open}
      <div style="border:1px solid var(--t-danger);border-left:3px;background:var(--s-danger);border-radius:5px;padding:13px 16px;margin-bottom:14px">
        <strong>Local changes are blocking planning and execution.</strong> <em>${escapeHtml(healthSummaryLine(detail))}</em>
      </div>
      <div data-diagnostics-files>${groupedFileList(detail.files)}</div>
      <div style="margin-top:14px">
        <p style="font-size:12.5px;color:var(--text3);margin-bottom:6px">Resolve on the server — the platform never resets a checkout automatically:</p>
        ${resolutionGuidance(project.repository_path)}
      </div>
    </div></section>`;
  }

  return `${open}
    <p style="color:var(--text3);font-size:13px">No local changes blocking planning or execution.</p>
  </div></section>`;
}

function deploymentPanel(project: any, deployment: DeploymentConfig): string {
  return `<div class="grid two">
    <section class="card">
      <div class="card-head">Pipeline status <button class="button" type="button" data-refresh-deployment>Refresh</button></div>
      <div class="card-body" data-deployment-pipeline data-project-id="${project.id}">
        <p style="color:var(--text3);font-size:13px">Loading…</p>
      </div>
    </section>
    <section class="card">
      <div class="card-head">Production</div>
      <div class="card-body" data-deployment-production>
        <p style="color:var(--text3);font-size:13px">Loading…</p>
      </div>
    </section>
    <section class="card" style="grid-column:1 / -1">
      <div class="card-head">Promote</div>
      <div class="card-body" style="display:flex;flex-direction:column;gap:10px">
        <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
          <button class="button primary" type="button" data-promote-button disabled>Promote to production</button>
          <button class="button" type="button" data-promote-retry hidden>Retry</button>
          <span data-promote-reason style="font-size:13px;color:var(--text3)"></span>
        </div>
      </div>
    </section>
    <section class="card" style="grid-column:1 / -1">
      <div class="card-head">Rollback</div>
      <div class="card-body" data-deployment-rollback style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
        <p style="color:var(--text3);font-size:13px">Loading…</p>
      </div>
    </section>
    <!-- Cron/background-job monitoring: config support exists (deployment.cron_jobs,
         cron_check_ins rows written by the webhook), but there is no read path yet —
         no API route reads cron_check_ins and nothing renders it. Real spec gap,
         intentionally left unbuilt rather than half-wired; someone should pick this
         up later (add a GET route + render logic here). -->
    <section class="card" style="grid-column:1 / -1">
      <div class="card-head">Release history</div>
      <div data-deployment-releases></div>
    </section>
    <dialog data-promote-dialog>
      <h3>Promote to production</h3>
      <p>This pushes <code data-promote-dialog-sha></code> (<span data-promote-dialog-message></span>) to the <code>${escapeHtml(deployment.production_branch)}</code> branch, deploying image <code data-promote-dialog-tag></code>.</p>
      <div style="display:flex;gap:10px;justify-content:flex-end">
        <button class="button" type="button" data-promote-dialog-cancel>Cancel</button>
        <button class="button primary" type="button" data-promote-dialog-confirm>Promote</button>
      </div>
    </dialog>
  </div>`;
}

export async function render(url: URL, _session: Session, _metrics: Record<string, number>): Promise<PageResult> {
  if (url.pathname === "/admin/projects") {
    const projects = (await pool.query("SELECT * FROM projects ORDER BY name")).rows;
    const body = `<div class="eyebrow">Configure / projects.yaml</div><h1>Projects</h1>
      <div class="toolbar"><button class="button primary" data-add-project-button>+ Add project</button></div>
      <section class="card">${projects.length ? `<div class="list-head projects-head"><span>Project</span><span>Status</span><span>Repository</span><span>Local path</span></div>${projects.map((project) =>
        `<a class="ticket-row projects-row" href="/admin/projects/${escapeHtml(project.slug)}"><strong>${escapeHtml(project.name)}</strong><span data-label="Status">${statusBadge(project.health_status)}</span><span data-label="Repository">${project.github_owner && project.github_repository ? `<span class="mono">${escapeHtml(project.github_owner)}/${escapeHtml(project.github_repository)}</span>` : `<span style="color:var(--text3)">—</span>`}</span><span class="mono" data-label="Local path">${escapeHtml(project.repository_path ?? "")}</span></a>`,
      ).join("")}` : `<div style="padding:48px 20px;text-align:center;color:var(--text3);font-size:13.5px">No projects configured yet. Create one to get started.</div>`}</section>
      <dialog data-add-project-modal aria-label="Add project"><div class="card-head">Add project</div><form data-add-project-form><div class="card-body"><label class="field"><span>Project name</span><input name="name" required></label><label class="field"><span>Slug</span><input name="slug" required placeholder="auto-generated from name"></label><label class="field"><span>Repository path</span><input name="repository_path" required></label><label class="field"><span>Planning agent start folder</span><input name="agent_start_path"><small>Leave blank to use the repository path.</small></label><label class="field"><span>GitHub owner</span><input name="github_owner"></label><label class="field"><span>GitHub repository</span><input name="github_repository"></label><label class="field"><span>Default branch</span><input name="default_branch" value="main"></label><p class="error" role="alert"></p></div><div style="padding:12px 18px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px"><button class="button" type="button" data-close-modal>Cancel</button><button class="button primary" type="submit">Create project</button></div></form></dialog>`;
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
    const config = project.config_json || {};
    const validationCommands = config.validation_commands || {};
    const branchPrefix = config.branch_prefix || "";
    const yaml = generateYaml(project);
    const panel = (index: number, content: string) => `<div role="tabpanel" id="panel-${index}" aria-labelledby="tab-${index}"${index === 0 ? "" : " hidden"}>${content}</div>`;
    const overviewPanel = `<section class="card"><div class="card-head">Paths & repository</div><div class="card-body"><form data-project-form data-project-id="${project.id}">
      <label class="field"><span>Local repository path</span><input name="repository_path" value="${escapeHtml(project.repository_path)}" required></label>
      <label class="field"><span>Planning agent start folder</span><input name="agent_start_path" value="${escapeHtml(project.agent_start_path || "")}"><small>Leave blank to use the repository path.</small></label>
      <label class="field"><span>GitHub owner / repository</span><div style="display:grid;grid-template-columns:1fr 1fr;gap:8px"><input name="github_owner" placeholder="Owner" value="${escapeHtml(project.github_owner || "")}"><input name="github_repository" placeholder="Repository" value="${escapeHtml(project.github_repository || "")}"></div></label>
      <label class="field"><span>Default branch</span><input name="default_branch" value="${escapeHtml(project.default_branch)}" required></label>
      <label class="field"><span>Branch prefix</span><input name="branch_prefix" value="${escapeHtml(branchPrefix)}"></label></form></div></section>
      <section class="card"><div class="card-head">Validation commands</div><div class="card-body" style="display:flex;flex-direction:column;gap:8px">${["install", "lint", "typecheck", "test", "build"].map((cmd) =>
        `<div style="display:flex;gap:8px;align-items:center"><span class="mono" style="min-width:80px;color:var(--text3)">${escapeHtml(cmd)}</span><input data-cmd="${cmd}" style="flex:1" value="${escapeHtml(validationCommands[cmd] || "")}" placeholder="Command"></div>`,
      ).join("")}</div></section>`;
    const mergeBranchesPanel = project.github_owner && project.github_repository
      ? `<section class="card"><div class="card-head">Merge branches</div><div class="card-body">
      <form data-merge-branches-form style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap">
        <label class="field"><span>From (head)</span><input name="head" value="${escapeHtml(project.default_branch)}" required></label>
        <label class="field"><span>Into (base)</span><input name="base" placeholder="e.g. production" required></label>
        <button class="button" type="submit">Merge</button>
      </form>
      <p style="font-size:12px;color:var(--text3)">Merges one branch directly into another on GitHub (no pull request). Use to promote master into staging/production.</p>
    </div></section>`
      : "";
    const yamlPanel = `<section class="card"><div class="card-head">config/projects.yaml · version ${project.config_version}</div><div class="card-body"><pre style="background:var(--code-bg);padding:12px;border-radius:4px;font-family:'JetBrains Mono',monospace;font-size:12px;overflow-x:auto">${escapeHtml(yaml)}</pre></div></section>`;
    const skillsPanel = `<section class="card"><div class="card-head">Automatically attached to every ticket</div><div class="card-body">${allSkillsResult.rows.length > 0 ? allSkillsResult.rows.map((skill) =>
      `<label style="padding:8px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--border)"><div><strong>${escapeHtml(skill.name)}</strong> <span class="mono" style="font-size:11px;color:var(--text3)">${escapeHtml(skill.slug)}</span> <span style="font-size:11px;font-weight:600;color:var(--text3)">${escapeHtml(skill.category)}</span> <span style="font-size:11px;color:var(--text3)">v${escapeHtml(skill.version)}</span></div><input type="checkbox" data-skill-checkbox value="${skill.id}" ${skill.attached ? "checked" : ""}></label>`,
    ).join("") : "<p>No skills available.</p>"}</div></section>`;
    const validationPanel = repositoryDiagnosticsPanel(project);
    const overriddenTypes = new Set(promptsResult.rows.map((prompt) => prompt.prompt_type));
    const availableTypes = globalPromptTypes.filter((type) => !overriddenTypes.has(type));
    const promptsPanel = `<section class="card"><div class="card-head">Project prompt overrides</div><div class="card-body">
      ${promptsResult.rows.length > 0 ? `<div style="display:flex;gap:8px;padding:12px 18px;border-bottom:1px solid var(--border);align-items:center"><span style="font-size:12.5px;color:var(--text3)">Selected: <strong data-prompt-selected-count>0</strong></span><span style="flex:1"></span><button class="button" type="button" data-prompt-bulk="activate">Activate</button><button class="button" type="button" data-prompt-bulk="deactivate">Deactivate</button><button class="button" type="button" data-prompt-bulk="delete" style="border:1px solid var(--t-danger);color:var(--t-danger);background:transparent">Delete</button></div>
      <div class="list-head" style="display:grid;grid-template-columns:28px minmax(200px,2fr) 1fr;gap:12px;padding:10px 18px;border-bottom:1px solid var(--border);background:var(--surface2)"><input type="checkbox" data-prompt-check-all aria-label="Select all prompts"><span style="font-size:10px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--text3)">Prompt type</span><span style="font-size:10px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--text3);justify-self:end">Status</span></div>${promptsResult.rows.map((prompt) =>
        `<div style="display:grid;grid-template-columns:28px minmax(200px,2fr) 1fr;gap:12px;padding:13px 18px;border-bottom:1px solid var(--border);align-items:center"><input type="checkbox" data-prompt-check="${prompt.id}" value="${prompt.id}" aria-label="Select ${escapeHtml(prompt.prompt_type)}"><div style="min-width:0"><a href="/admin/prompts/${prompt.id}"><strong>${escapeHtml(prompt.prompt_type)}</strong></a></div><span class="status ${prompt.active_version ? "ok" : "muted"}" style="justify-self:end">${prompt.active_version ? "Active" : "Inactive"}</span></div>`,
      ).join("")}` : "<p>This project uses the global prompts. Add an override to customize a prompt type.</p>"}
      ${availableTypes.length > 0 ? `<form data-add-override-form style="display:flex;gap:8px;align-items:center;padding:13px 18px;border-top:1px solid var(--border)"><select name="prompt_type" data-add-override-select aria-label="Prompt type to override" style="flex:1">${availableTypes.map((type) => `<option value="${type}">${type}</option>`).join("")}</select><button class="button" type="submit">+ Add override</button></form>` : ""}
    </div></section>`;
    const deployment = project.config_json?.deployment as DeploymentConfig | undefined;
    const tabLabels = ["Overview", "YAML config", "Skills", "Validation", "Prompts", ...(deployment?.enabled ? ["Deployment"] : [])];
    const panelContents = [overviewPanel + mergeBranchesPanel, yamlPanel, skillsPanel, validationPanel, promptsPanel, ...(deployment?.enabled ? [deploymentPanel(project, deployment)] : [])];
    const body = `<div class="eyebrow">Configure / Projects</div><h1>${escapeHtml(project.name)}</h1>
      <div class="toolbar"><button class="button" data-validate-button>Run validation</button><button class="button primary" data-save-button>Save configuration</button></div>
      <div data-dirty-page-banner>${dirtyBanner(project)}</div>
      <div class="tabs" role="tablist">${tabLabels.map((label, index) => `<button type="button" role="tab" id="tab-${index}" aria-controls="panel-${index}" aria-selected="${index === 0}">${label}</button>`).join("")}</div>
      ${panelContents.map((content, index) => panel(index, content)).join("")}`;
    return { status: 200, title: project.name, body };
  }
  return null;
}
