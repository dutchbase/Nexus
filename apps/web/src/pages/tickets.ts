import { escapeHtml, lineDiff, pool, renderMarkdown, shortRef, validStatuses } from "./shared.ts";
import type { PageResult, Session } from "./shared.ts";

export async function render(url: URL, _session: Session, _metrics: Record<string, number>): Promise<PageResult> {
  if (url.pathname === "/admin/tickets") {
    const values: any[] = [];
    const conditions: string[] = [];
    for (const [key, column] of [["project_id", "t.project_id"], ["status", "t.status"], ["priority", "t.priority"], ["category", "t.category"], ["form", "f.slug"]] as const) {
      const value = url.searchParams.get(key);
      if (value) { values.push(value); conditions.push(`${column} = $${values.length}`); }
    }
    const search = url.searchParams.get("search");
    if (search) { values.push(`%${search}%`); conditions.push(`(t.ticket_number ILIKE $${values.length} OR t.title ILIKE $${values.length} OR t.description ILIKE $${values.length})`); }
    const [ticketsResult, projectsResult] = await Promise.all([
      pool.query(
        `SELECT t.*,p.name project_name,f.name form_name FROM tickets t JOIN projects p ON p.id=t.project_id LEFT JOIN forms f ON f.id=t.form_id
         ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""} ORDER BY t.updated_at DESC LIMIT 200`,
        values,
      ),
      pool.query("SELECT id, slug, name FROM projects ORDER BY name"),
    ]);
    const tickets = ticketsResult.rows;
    const projects = projectsResult.rows;
    const view = url.searchParams.get("view");

    const buildFilterUrl = (newView?: string) => {
      const params = new URLSearchParams();
      if (search) params.append("search", search);
      if (url.searchParams.get("project_id")) params.append("project_id", url.searchParams.get("project_id")!);
      if (url.searchParams.get("priority")) params.append("priority", url.searchParams.get("priority")!);
      if (url.searchParams.get("status")) params.append("status", url.searchParams.get("status")!);
      if (newView) params.append("view", newView);
      return `/admin/tickets${params.size > 0 ? "?" + params.toString() : ""}`;
    };

    const statusToneMap: Record<string, string> = {
      "Submitted": "var(--t-info)", "Triage": "var(--t-info)", "Needs Information": "var(--t-warn)",
      "Rejected": "var(--t-danger)", "Approved for Planning": "var(--t-ok)", "Planning Queued": "var(--t-info)", "Planning": "var(--t-run)", "Plan Ready for Review": "var(--t-run)", "Plan Revision Requested": "var(--t-warn)", "Plan Revision Queued": "var(--t-run)", "Plan Approved": "var(--t-ok)",
      "Execution Queued": "var(--t-info)", "Executing": "var(--t-run)", "Validating": "var(--t-run)", "Validation Failed": "var(--t-danger)", "Execution Failed": "var(--t-danger)", "PR Creation Failed": "var(--t-danger)",
      "PR Ready for Review": "var(--t-warn)", "PR Changes Requested": "var(--t-warn)", "PR Approved": "var(--t-ok)",
      "Merged": "var(--t-ok)", "Completed": "var(--t-ok)", "Rejected": "var(--t-danger)", "Cancelled": "var(--t-muted)", "Archived": "var(--t-muted)", "Closed Without Merge": "var(--t-muted)",
    };

    if (view === "board") {
      // Board view: group tickets into 6 status columns
      const boardColumns = {
        "Triage": ["Submitted", "Triage", "Needs Information"],
        "Planning": ["Approved for Planning", "Planning Queued", "Planning", "Plan Revision Requested", "Plan Revision Queued"],
        "Plan review": ["Plan Ready for Review", "Plan Approved"],
        "Execution": ["Execution Queued", "Executing", "Validating", "Validation Failed", "Execution Failed", "PR Creation Failed"],
        "PR review": ["PR Ready for Review", "PR Changes Requested", "PR Approved"],
        "Done": ["Merged", "Completed", "Rejected", "Cancelled", "Archived", "Closed Without Merge"],
      };

      const groupedByStatus: Record<string, typeof tickets> = {};
      for (const column of Object.values(boardColumns)) {
        for (const status of column) {
          groupedByStatus[status] = [];
        }
      }
      for (const ticket of tickets) {
        if (groupedByStatus[ticket.status]) groupedByStatus[ticket.status].push(ticket);
      }

      const boardColumnsHtml = Object.entries(boardColumns).map(([columnName, statuses]) => {
        const columnTickets = statuses.flatMap(status => groupedByStatus[status] || []);
        const cardsHtml = columnTickets.map((ticket) => {
          const tone = statusToneMap[ticket.status] || "var(--t-text)";
          return `<a class="ticket-row" style="display:block;border-left:2px solid ${tone};padding:10px 12px;text-decoration:none;margin-bottom:8px;background:var(--surface);border-radius:4px" href="/admin/tickets/${escapeHtml(ticket.ticket_number)}">
            <span class="mono" style="font-size:11px">${escapeHtml(ticket.ticket_number)}</span>
            <span style="display:inline-block;font-size:11px;font-weight:700;padding:2px 6px;border-radius:3px;margin-left:4px;background:var(--accent-soft);color:var(--t-${ticket.priority || "low"})">${escapeHtml(ticket.priority || "—")}</span>
            <span style="display:block;font-weight:600;margin:4px 0">${escapeHtml(ticket.title)}</span>
            <span style="display:block;font-size:12px;color:var(--text2)">${escapeHtml(ticket.project_name)} · <span class="mono">${escapeHtml(ticket.default_model || "—")} · ${escapeHtml(ticket.default_reasoning_level || "—")}</span></span>
          </a>`;
        }).join("");
        return `<div style="flex:1;min-width:230px;background:var(--surface2);border:1px solid var(--border);border-radius:4px;min-height:120px;display:flex;flex-direction:column;padding:12px">
          <div style="font-weight:700;font-size:11px;text-transform:uppercase;color:var(--text3);margin-bottom:8px">${escapeHtml(columnName)}</div>
          <div style="flex:1;overflow-y:auto">${cardsHtml || '<div style="text-align:center;color:var(--text3);font-size:11.5px;padding:8px">Empty</div>'}</div>
        </div>`;
      }).join("");

      const body = `<div class="eyebrow">Work · intake</div><h1>Tickets</h1>
        <div class="toolbar">
          <a class="button" href="${escapeHtml(buildFilterUrl())}">Table</a>
          <a class="button" style="background:var(--accent-soft);color:var(--accent)">Board</a>
        </div>
        <form class="toolbar" id="filters" style="margin-top:16px">
          <input class="search" data-ticket-filter name="search" placeholder="Search ticket number or title…" value="${escapeHtml(search || "")}">
          <select data-ticket-filter name="project_id">
            <option value="">All projects</option>
            ${projects.map((p) => `<option value="${p.id}"${url.searchParams.get("project_id") === p.id ? " selected" : ""}>${p.name}</option>`).join("")}
          </select>
          <select data-ticket-filter name="priority">
            <option value="">All priorities</option>
            <option value="critical"${url.searchParams.get("priority") === "critical" ? " selected" : ""}>Critical</option>
            <option value="high"${url.searchParams.get("priority") === "high" ? " selected" : ""}>High</option>
            <option value="medium"${url.searchParams.get("priority") === "medium" ? " selected" : ""}>Medium</option>
            <option value="low"${url.searchParams.get("priority") === "low" ? " selected" : ""}>Low</option>
          </select>
          <select data-ticket-filter name="status">
            <option value="">All statuses</option>
            ${[...validStatuses].map((status) => `<option${url.searchParams.get("status") === status ? " selected" : ""}>${status}</option>`).join("")}
          </select>
          <a class="button" href="/admin/tickets">Reset</a>
          <span aria-live="polite" style="margin-left:auto">${tickets.length} of 14</span>
        </form>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px;margin-top:16px">${boardColumnsHtml}</div>`;
      return { status: 200, title: "Tickets", body };
    }

    // Table view
    const rows = tickets.map((ticket) => `<a class="ticket-row tickets7" href="/admin/tickets/${escapeHtml(ticket.ticket_number)}"><span class="mono">${escapeHtml(ticket.ticket_number)}</span><strong>${escapeHtml(ticket.title)}</strong><span>${escapeHtml(ticket.project_name)}</span><span>${escapeHtml(ticket.priority || "—")}</span><span class="mono">${escapeHtml(ticket.default_model || "—")} · ${escapeHtml(ticket.default_reasoning_level || "—")}</span><span class="status">${escapeHtml(ticket.status)}</span><time>${new Date(ticket.updated_at).toLocaleDateString("nl-NL")}</time></a>`).join("");
    const emptyState = tickets.length === 0 ? `<div style="padding:48px 20px;text-align:center;color:var(--text3);font-size:13.5px">No tickets match these filters.</div>` : "";
    const body = `<div class="eyebrow">Work · intake</div><h1>Tickets</h1>
      <div class="toolbar">
        <a class="button" style="background:var(--accent-soft);color:var(--accent)">Table</a>
        <a class="button" href="${escapeHtml(buildFilterUrl("board"))}">Board</a>
      </div>
      <form class="toolbar" id="filters" style="margin-top:16px">
        <input class="search" data-ticket-filter name="search" placeholder="Search ticket number or title…" value="${escapeHtml(search || "")}">
        <select data-ticket-filter name="project_id">
          <option value="">All projects</option>
          ${projects.map((p) => `<option value="${p.id}"${url.searchParams.get("project_id") === p.id ? " selected" : ""}>${p.name}</option>`).join("")}
        </select>
        <select data-ticket-filter name="priority">
          <option value="">All priorities</option>
          <option value="critical"${url.searchParams.get("priority") === "critical" ? " selected" : ""}>Critical</option>
          <option value="high"${url.searchParams.get("priority") === "high" ? " selected" : ""}>High</option>
          <option value="medium"${url.searchParams.get("priority") === "medium" ? " selected" : ""}>Medium</option>
          <option value="low"${url.searchParams.get("priority") === "low" ? " selected" : ""}>Low</option>
        </select>
        <select data-ticket-filter name="status">
          <option value="">All statuses</option>
          ${[...validStatuses].map((status) => `<option${url.searchParams.get("status") === status ? " selected" : ""}>${status}</option>`).join("")}
        </select>
        <a class="button" href="/admin/tickets">Reset</a>
        <span aria-live="polite" style="margin-left:auto">${tickets.length} of 14</span>
      </form>
      <section class="card">${emptyState || `<div class="list-head tickets7"><span>Ticket</span><span>Title</span><span>Project</span><span>Priority</span><span>AI config</span><span>Status</span><span>Updated</span></div>${rows}`}</section>`;
    return { status: 200, title: "Tickets", body };
  }
  const planComparePageMatch = url.pathname.match(/^\/admin\/tickets\/([^/]+)\/plans\/compare$/);
  if (planComparePageMatch) {
    const ref = decodeURIComponent(planComparePageMatch[1]);
    const ids = [url.searchParams.get("from"), url.searchParams.get("to")].filter(Boolean);
    const rows = (await pool.query(
      `SELECT pv.* FROM plan_versions pv JOIN plans p ON p.id=pv.plan_id
       JOIN tickets t ON t.id=p.ticket_id
       WHERE (t.id::text=$1 OR t.ticket_number=$1) AND pv.id=ANY($2::uuid[])`,
      [ref, ids],
    )).rows;
    const from = rows.find((version) => version.id === ids[0]);
    const to = rows.find((version) => version.id === ids[1]);
    if (!from || !to) {
      return { status: 404, title: "Versions not found", body: "<h1>Plan versions not found</h1>" };
    }
    const body = `<div class="eyebrow">${escapeHtml(ref)} · Plan comparison</div>
      <h1>Version ${from.version} → ${to.version}</h1>
      <p><a class="button" href="/admin/tickets/${escapeHtml(ref)}/plans">Back to plans</a></p>
      <section class="card"><div class="card-body"><pre>${escapeHtml(lineDiff(from.content_markdown, to.content_markdown))}</pre></div></section>`;
    return { status: 200, title: "Plan comparison", body };
  }
  const planVersionPageMatch = url.pathname.match(/^\/admin\/tickets\/([^/]+)\/plans\/(\d+)$/);
  if (planVersionPageMatch) {
    const ref = decodeURIComponent(planVersionPageMatch[1]);
    const ticket = (await pool.query(
      "SELECT t.*,p.name project_name,p.slug project_slug FROM tickets t JOIN projects p ON p.id=t.project_id WHERE t.id::text=$1 OR t.ticket_number=$1",
      [ref],
    )).rows[0];
    if (!ticket) return { status: 404, title: "Ticket not found", body: "<h1>Ticket not found</h1>" };
    const versions = (await pool.query(
      `SELECT pv.*,p.planning_session_id,ar.model,ar.reasoning_level,ps.content prompt_content
       FROM plans p JOIN plan_versions pv ON pv.plan_id=p.id
       JOIN agent_runs ar ON ar.id=pv.agent_run_id
       JOIN prompt_snapshots ps ON ps.id=pv.prompt_snapshot_id
       WHERE p.ticket_id=$1 ORDER BY pv.version DESC`,
      [ticket.id],
    )).rows;
    const target = versions.find((version) => version.version === Number(planVersionPageMatch[2]));
    if (!target) return { status: 404, title: "Plan version not found", body: "<h1>Plan version not found</h1>" };
    const previous = versions.find((version) => version.version === target.version - 1);
    const versionsRail = versions.map((version) => `<a class="ticket-row"${version.id === target.id ? ' style="background:var(--accent-soft);border-left:2px solid var(--accent)"' : ""} href="/admin/tickets/${escapeHtml(ticket.ticket_number)}/plans/${version.version}"><span class="mono">v${version.version}</span><span>${escapeHtml(version.model)} · ${escapeHtml(version.reasoning_level)}</span></a>`).join("");
    const body = `<div class="eyebrow">${escapeHtml(ticket.ticket_number)} · ${escapeHtml(ticket.project_name)} <span class="status">${escapeHtml(ticket.status)}</span></div>
      <h1>Plan review · v${target.version}</h1>
      <div class="toolbar"><a class="button" href="/admin/tickets/${escapeHtml(ticket.ticket_number)}/plans">Back to plans</a>
        <button class="button" type="button" data-open-revision-dialog>Request revision</button>
        <button class="button" style="color:var(--t-danger);border-color:var(--t-danger)" type="button" data-reject-plan-version="${target.id}">Reject</button>
        <button class="button primary" type="button" data-approve-plan-version="${target.id}" data-content-hash="${escapeHtml(target.content_hash)}">Approve this version</button></div>
      <div class="grid two">
        <section class="card"><div class="tabs" role="tablist"><button type="button" role="tab" id="tab-0" aria-controls="panel-0" aria-selected="true">Rendered</button><button type="button" role="tab" id="tab-1" aria-controls="panel-1" aria-selected="false">Raw Markdown</button><button type="button" role="tab" id="tab-2" aria-controls="panel-2" aria-selected="false">Diff${previous ? ` v${previous.version} → v${target.version}` : ""}</button></div>
          <div class="card-body">
            <div role="tabpanel" id="panel-0" aria-labelledby="tab-0">${renderMarkdown(target.content_markdown)}</div>
            <div role="tabpanel" id="panel-1" aria-labelledby="tab-1" hidden><pre>${escapeHtml(target.content_markdown)}</pre></div>
            <div role="tabpanel" id="panel-2" aria-labelledby="tab-2" hidden data-diff-panel data-plan-id="${target.plan_id}"${previous ? ` data-diff-from="${previous.id}" data-diff-to="${target.id}"` : ""}><pre data-diff-content>${previous ? "Loading…" : "No previous version to compare."}</pre></div>
            <p class="mono">SHA-256 ${escapeHtml(target.content_hash)}</p>
          </div></section>
        <div class="grid rail">
          <section class="card"><div class="card-head">Versions</div>${versionsRail}</section>
          <section class="card"><div class="card-head">Run snapshot</div><div class="card-body"><dl><dt>Model</dt><dd>${escapeHtml(target.model)}</dd><dt>Reasoning level</dt><dd>${escapeHtml(target.reasoning_level)}</dd><dt>Session</dt><dd class="mono">${escapeHtml(target.planning_session_id)}</dd></dl></div></section>
          <section class="card"><div class="card-head">Exact planning prompt</div><div class="card-body"><details><summary>View prompt</summary><pre>${escapeHtml(target.prompt_content)}</pre></details></div></section>
        </div>
      </div>
      <dialog data-revision-dialog aria-label="Request revision" data-plan-id="${target.plan_id}"><div class="card-head">Request revision</div>
        <div class="card-body"><label class="field"><span>What must change in the next revision?</span><textarea data-revision-feedback rows="6" placeholder="What must change in the next revision?"></textarea></label>
        <p class="error" role="alert"></p><button class="button" type="button" data-close-dialog>Cancel</button> <button class="button primary" type="button" data-submit-revision>Submit feedback &amp; queue revision</button></div></dialog>`;
    return { status: 200, title: `Plan review · v${target.version}`, body };
  }
  const ticketPlansPageMatch = url.pathname.match(/^\/admin\/tickets\/([^/]+)\/plans$/);
  if (ticketPlansPageMatch) {
    const ref = decodeURIComponent(ticketPlansPageMatch[1]);
    const ticket = (await pool.query(
      "SELECT t.*,p.name project_name FROM tickets t JOIN projects p ON p.id=t.project_id WHERE t.id::text=$1 OR t.ticket_number=$1",
      [ref],
    )).rows[0];
    if (!ticket) return { status: 404, title: "Ticket not found", body: "<h1>Ticket not found</h1>" };
    const versions = (await pool.query(
      `SELECT pv.*,p.planning_session_id,ar.model,ar.reasoning_level,ps.content prompt_content
       FROM plans p JOIN plan_versions pv ON pv.plan_id=p.id
       JOIN agent_runs ar ON ar.id=pv.agent_run_id
       JOIN prompt_snapshots ps ON ps.id=pv.prompt_snapshot_id
       WHERE p.ticket_id=$1 ORDER BY pv.version DESC`,
      [ticket.id],
    )).rows;
    const compare = versions.length > 1
      ? `<a class="button" href="/admin/tickets/${escapeHtml(ticket.ticket_number)}/plans/compare?from=${versions[1].id}&to=${versions[0].id}">Compare latest versions</a>`
      : "";
    const body = `<div class="eyebrow">${escapeHtml(ticket.ticket_number)} · Plan review</div>
      <h1>Implementation plan</h1><p><a class="button" href="/admin/tickets/${escapeHtml(ticket.ticket_number)}">Back to ticket</a></p>
      <p>${compare}</p>
      ${versions.map((version) => `<section class="card"><div class="card-head">Version ${version.version} · ${escapeHtml(version.model)} / ${escapeHtml(version.reasoning_level)} · <a href="/admin/tickets/${escapeHtml(ticket.ticket_number)}/plans/${version.version}">Open review page</a></div>
        <div class="card-body">${renderMarkdown(version.content_markdown)}
        <details><summary>Raw Markdown</summary><pre>${escapeHtml(version.content_markdown)}</pre></details>
        <details><summary>Exact planning prompt</summary><pre>${escapeHtml(version.prompt_content)}</pre></details>
        <p class="mono">Session ${escapeHtml(version.planning_session_id)} · SHA-256 ${escapeHtml(version.content_hash)}</p></div></section>`).join("") || "<p>No completed plan is available yet.</p>"}`;
    return { status: 200, title: "Plan review", body };
  }
  const ticketMatch = url.pathname.match(/^\/admin\/tickets\/([^/]+)$/);
  if (ticketMatch) {
    const ticket = (await pool.query(
      `SELECT t.*,p.name project_name,f.name form_name FROM tickets t JOIN projects p ON p.id=t.project_id LEFT JOIN forms f ON f.id=t.form_id WHERE t.id::text=$1 OR t.ticket_number=$1`,
      [decodeURIComponent(ticketMatch[1])],
    )).rows[0];
    if (!ticket) return { status: 404, title: "Ticket not found", body: "<h1>Ticket not found</h1>" };
    const [notesResult, historyResult, skillsResult, notificationsResult, runsResult, prsResult] = await Promise.all([
      pool.query("SELECT n.*,u.username FROM ticket_notes n LEFT JOIN users u ON u.id=n.author_id WHERE ticket_id=$1 ORDER BY n.created_at DESC", [ticket.id]),
      pool.query("SELECT * FROM ticket_status_history WHERE ticket_id=$1 ORDER BY created_at DESC", [ticket.id]),
      pool.query(
        `SELECT s.*,ps.id IS NOT NULL automatic,ts.id IS NOT NULL selected
         FROM skills s
         LEFT JOIN project_skills ps ON ps.skill_id=s.id AND ps.project_id=$1 AND ps.attachment_type='automatic'
         LEFT JOIN ticket_skills ts ON ts.skill_id=s.id AND ts.ticket_id=$2
         ORDER BY s.category,s.name`,
        [ticket.project_id, ticket.id],
      ),
      pool.query(
        `SELECT nd.*,np.name provider,np.configuration_encrypted_json->>'recipient' recipient
         FROM notification_deliveries nd LEFT JOIN notification_providers np ON np.id=nd.provider_id
         WHERE nd.ticket_id=$1 ORDER BY nd.created_at DESC`,
        [ticket.id],
      ),
      pool.query("SELECT * FROM agent_runs WHERE ticket_id=$1 ORDER BY started_at DESC NULLS LAST", [ticket.id]),
      pool.query("SELECT * FROM pull_requests WHERE ticket_id=$1 ORDER BY created_at DESC", [ticket.id]),
    ]);
    const notes = notesResult.rows;
    const history = historyResult.rows;
    const skillRows = skillsResult.rows;
    const selectedSkills = skillRows.filter((skill) => skill.automatic || skill.selected);
    const chips = selectedSkills.map((skill) =>
      `<span class="skill-chip" data-skill-chip="${skill.id}" data-slug="${escapeHtml(skill.slug)}" title="${skill.automatic ? "Automatically added by project" : "Selected on this ticket"} · ${escapeHtml(skill.filesystem_path)}">${escapeHtml(skill.name)}
       ${skill.automatic ? '<small>auto</small>' : `<button type="button" aria-label="Remove ${escapeHtml(skill.name)}" data-remove-skill="${skill.id}">×</button>`}</span>`,
    ).join("");
    const referenceLines = selectedSkills.map((skill) => `- ${skill.slug}: ${skill.filesystem_path}`).join("\n");
    const modelOptions = ["fable", "opus", "sonnet", "haiku"].map((model) => `<option value="${model}"${ticket.default_model === model ? " selected" : ""}>${model[0].toUpperCase()}${model.slice(1)}</option>`).join("");
    const reasoningOptions = [["low","Low"],["medium","Medium"],["high","High"],["xhigh","Extra high"],["max","Maximum"],["ultracode","Ultracode"]].map(([value,label]) => `<option value="${value}"${ticket.default_reasoning_level === value ? " selected" : ""}>${label}</option>`).join("");
    const phaseConfiguration = (phase: "planning" | "execution" | "repair") => {
      const selectedModel = ticket[`${phase}_model`];
      const selectedReasoning = ticket[`${phase}_reasoning_level`];
      const models = ["fable", "opus", "sonnet", "haiku"].map((model) => `<option value="${model}"${selectedModel === model ? " selected" : ""}>${model[0].toUpperCase()}${model.slice(1)}</option>`).join("");
      const reasoning = [["low","Low"],["medium","Medium"],["high","High"],["xhigh","Extra high"],["max","Maximum"],["ultracode","Ultracode"]].map(([value,label]) => `<option value="${value}"${selectedReasoning === value ? " selected" : ""}>${label}</option>`).join("");
      return `<fieldset><legend>${phase[0].toUpperCase()}${phase.slice(1)}</legend><div class="grid two"><label class="field"><span>Model</span><select name="${phase}_model">${models}</select></label><label class="field"><span>Reasoning level</span><select name="${phase}_reasoning_level">${reasoning}</select></label></div></fieldset>`;
    };
    const execRuns = runsResult.rows.filter((run) => run.run_type === "execution");
    const panel = (index: number, content: string) => `<div role="tabpanel" id="panel-${index}" aria-labelledby="tab-${index}"${index === 0 ? "" : " hidden"}>${content}</div>`;
    const overviewPanel = `<div class="grid two"><section class="card"><div class="card-head">Original submission</div><div class="card-body"><p>${escapeHtml(ticket.description)}</p><dl><dt>Category</dt><dd>${escapeHtml(ticket.category)}</dd><dt>Environment</dt><dd>${escapeHtml(ticket.environment)}</dd><dt>Source URL</dt><dd>${escapeHtml(ticket.source_url)}</dd></dl></div></section>
      <section class="card"><div class="card-head">Internal notes</div><div class="card-body notes">${notes.map((note) => `<div class="note"><strong>${escapeHtml(note.username ?? "Administrator")}</strong><p>${escapeHtml(note.body)}</p></div>`).join("") || "<p>No notes yet.</p>"}<form data-notes-form><label class="field"><span>Add an internal note…</span><textarea name="body" placeholder="Add an internal note…" rows="3"></textarea></label><button class="button" type="submit">Save note</button><p class="error" role="alert"></p></form></div></section></div>
      <div class="grid rail"><section class="card"><div class="card-head">Ticket</div><div class="card-body"><dl><dt>Project</dt><dd>${escapeHtml(ticket.project_name)}</dd><dt>Category</dt><dd>${escapeHtml(ticket.category)}</dd><dt>Source form</dt><dd>${escapeHtml(ticket.form_name ?? "—")}</dd><dt>Created</dt><dd>${new Date(ticket.created_at).toLocaleDateString("nl-NL")}</dd></dl></div></section>
      <section class="card"><div class="card-head">Approval gates</div><div class="card-body"><p><button class="button primary" type="button" data-approve-planning${["Triage", "Needs Information"].includes(ticket.status) ? "" : " disabled"} title="${["Triage", "Needs Information"].includes(ticket.status) ? "" : "Ticket must be Triage or Needs Information"}">Approve for planning</button></p><p class="error" role="alert"></p></div></section>
      <section class="card"><div class="card-head">Danger zone</div><div class="card-body"><p><button class="button" style="color:var(--t-danger);border-color:var(--t-danger)" type="button" data-reject-ticket${["Submitted", "Triage", "Needs Information"].includes(ticket.status) ? "" : " disabled"} title="${["Submitted", "Triage", "Needs Information"].includes(ticket.status) ? "" : "Can only reject early-stage tickets"}">Reject</button></p><p><button class="button" style="color:var(--t-danger);border-color:var(--t-danger)" type="button" data-cancel-ticket${["Planning Queued", "Planning", "Execution Queued", "Executing"].includes(ticket.status) ? "" : " disabled"} title="${["Planning Queued", "Planning", "Execution Queued", "Executing"].includes(ticket.status) ? "" : "Can only cancel in-progress tickets"}">Cancel</button></p><p><button class="button" style="color:var(--t-danger);border-color:var(--t-danger)" type="button" data-archive-ticket${["Completed", "Merged", "Rejected", "Cancelled"].includes(ticket.status) ? "" : " disabled"} title="${["Completed", "Merged", "Rejected", "Cancelled"].includes(ticket.status) ? "" : "Can only archive finished tickets"}">Archive</button></p></div></section></div>`;
    const aiPanel = `<section class="card"><div class="card-head">AI configuration</div><div class="card-body">
        <form id="ai-config" data-ticket-id="${ticket.id}"><label class="field"><span>Mode</span><select name="ai_configuration_mode"><option value="basic"${ticket.ai_configuration_mode !== "advanced" ? " selected" : ""}>Basic</option><option value="advanced"${ticket.ai_configuration_mode === "advanced" ? " selected" : ""}>Advanced</option></select></label>
        <div class="grid two"><label class="field"><span>Default model</span><select name="default_model">${modelOptions}</select></label><label class="field"><span>Default reasoning level</span><select name="default_reasoning_level">${reasoningOptions}</select></label></div>
        <div data-advanced-ai${ticket.ai_configuration_mode === "advanced" ? "" : " hidden"}>${phaseConfiguration("planning")}${phaseConfiguration("execution")}${phaseConfiguration("repair")}</div>
        <button class="button primary" type="submit">Save AI configuration</button><p class="error" role="alert"></p></form>
      </div></section>
      <section class="card"><div class="card-head">Skills</div><div class="card-body">
        <div class="skill-chips" data-skill-chips>${chips}</div>
        <button class="button" type="button" data-add-skill>+ Add skill</button>
        <div class="skill-options" data-skill-picker hidden><label class="field"><span>Search and select skills</span><input data-skill-search placeholder="Search skills or categories"></label>
        ${skillRows.map((skill) => `<label data-skill-option data-search="${escapeHtml(`${skill.name} ${skill.slug} ${skill.category}`.toLowerCase())}"><input type="checkbox" value="${skill.id}" data-skill-toggle data-slug="${escapeHtml(skill.slug)}" data-name="${escapeHtml(skill.name)}" data-path="${escapeHtml(skill.filesystem_path)}"${skill.automatic ? " data-auto" : ""}${skill.automatic || skill.selected ? " checked" : ""}${skill.automatic || !skill.enabled ? " disabled" : ""}> ${escapeHtml(skill.name)} <small>${escapeHtml(skill.category)}${skill.automatic ? " · Automatically added by project" : ""}${!skill.enabled ? " · disabled" : ""}</small></label>`).join("")}</div>
      </div></section>
      <section class="card"><div class="card-head">Resolved references injected into the prompt (<span data-ref-count>${selectedSkills.length}</span>)</div><div class="card-body"><pre class="references" data-skill-references>Use the following skills:
${escapeHtml(referenceLines)}</pre></div></section>`;
    const promptPanel = `<section class="card"><div class="card-head">Assembled prompt</div><div class="card-body"><p>Compiled from the current prompt versions, project configuration, resolved AI configuration, resolved skills, and this ticket — without creating a run or snapshot.</p>
      <pre class="references">Use the following skills:
<span data-prompt-skills>${escapeHtml(referenceLines)}</span></pre>
      <a class="button" href="/api/admin/tickets/${ticket.id}/prompt-preview">Open full planning prompt preview</a></div></section>`;
    const plansPanel = `<section class="card"><div class="card-head">Planning</div><div class="card-body"><p>Review the immutable generated plan, its exact prompt, model, reasoning level, and raw Markdown.</p><a class="button" href="/admin/tickets/${ticket.ticket_number}/plans">Open plan review</a></div></section>`;
    const runsPanel = `<section class="card"><div class="card-head">Runs</div>${runsResult.rows.map((run) =>
      `<a class="ticket-row" href="/admin/runs/${run.id}"><span class="mono">${shortRef("RUN", run.id)}</span><strong>${escapeHtml(run.run_type)}</strong><span>${escapeHtml(run.model)} · ${escapeHtml(run.reasoning_level)}</span><span class="status">${escapeHtml(run.status)}</span><time>${run.started_at ? new Date(run.started_at).toLocaleString("nl-NL") : ""}</time></a>`,
    ).join("") || '<div class="card-body"><p>No runs yet.</p></div>'}</section>`;
    const validationPanel = `<section class="card"><div class="card-head">Validation</div><div class="card-body">${execRuns.map((run) =>
      `<p><span class="status">${escapeHtml(run.status)}</span> ${run.error_code === "validation_failed" ? "<strong>Validation failed</strong> — " : ""}${escapeHtml(run.error_message ?? "")}</p>`,
    ).join("") || "<p>Greyed out until an execution attempt exists.</p>"}</div></section>`;
    const prPanel = `<section class="card"><div class="card-head">Pull request</div>${prsResult.rows.map((item) =>
      `<a class="ticket-row" href="/admin/pull-requests/${item.id}"><span class="mono">#${item.number}</span><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.head_branch)}</span><span class="status">${escapeHtml(item.review_state ?? item.state)}</span><time>${new Date(item.created_at).toLocaleDateString("nl-NL")}</time></a>`,
    ).join("") || '<div class="card-body"><p>No pull request yet — the worker opens a draft PR after a validated execution.</p></div>'}</section>`;
    const activityPanel = `<section class="card"><div class="card-head">Status history</div><div class="card-body">${history.map((item) => `<p><span class="mono">${new Date(item.created_at).toLocaleString("nl-NL")}</span> ${escapeHtml(item.previous_status ?? "New")} → <strong>${escapeHtml(item.new_status)}</strong></p>`).join("") || "<p>No recorded transitions.</p>"}</div></section>
      <section class="card"><div class="card-head">Notification history</div><div class="card-body">${notificationsResult.rows.map((item) =>
        `<p><strong>${escapeHtml(item.event_type)}</strong> · ${escapeHtml(item.provider ?? "Unknown provider")} · ${escapeHtml(item.recipient ?? "default recipient")} · ${escapeHtml(item.status)} · attempts ${item.attempt_count ?? 0}${item.response_status ? ` · HTTP ${item.response_status}` : ""}${item.sent_at ? ` · ${new Date(item.sent_at).toLocaleString("nl-NL")}` : ""}${item.error_message ? `<br><span class="error">${escapeHtml(item.error_message)}</span>` : ""}</p>`,
      ).join("") || "<p>No notifications yet.</p>"}</div></section>`;
    const body = `<div class="eyebrow">${escapeHtml(ticket.ticket_number)} · ${escapeHtml(ticket.project_name)}</div><h1>${escapeHtml(ticket.title)}</h1>
      <div class="toolbar"><span class="status">${escapeHtml(ticket.status)}</span>
        <button class="button" type="button" data-open-preview>Preview prompt</button>
        <button class="button primary" type="button" data-start-execution${ticket.status === "Plan Approved" ? "" : " disabled"}>Start execution</button></div>
      <dialog data-preview-dialog aria-label="Prompt preview"><div class="card-head">Prompt preview</div><pre class="references">Loading…</pre><button class="button" type="button" data-close-dialog>Close</button></dialog>
      <div class="tabs" role="tablist">${["Overview", "AI & skills", "Prompt", "Plans", "Runs", "Validation", "Pull request", "Activity"].map((label, index) => `<button type="button" role="tab" id="tab-${index}" aria-controls="panel-${index}" aria-selected="${index === 0}">${label}</button>`).join("")}</div>
      ${[overviewPanel, aiPanel, promptPanel, plansPanel, runsPanel, validationPanel, prPanel, activityPanel].map((content, index) => panel(index, content)).join("")}`;
    return { status: 200, title: ticket.ticket_number, body };
  }
  return null;
}
