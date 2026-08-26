import { escapeHtml, fieldsFor, keysetCondition, lineDiff, nextCursor, pageRequest, PAGE_SIZE_MAX, pagerHtml, pool, renderMarkdown, shortRef, standardFields, statusBadge, statusTone, validStatuses } from "./shared.ts";
import type { PageResult, Session } from "./shared.ts";
import { checkPlanApprovalGate, aiInvocationPhases, aiLifecycleGroup, aiModels } from "@dcc/domain";
import { formControls } from "../ui.ts";

function usd(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 8 }).format(value);
}

function coverageLabel(run: any) {
  if (run.ai_usage_status == null) return "Legacy";
  if (run.ai_usage_status !== "captured") return "Unavailable";
  if (run.estimated_cost_usd == null) return "Unpriced";
  return "Captured";
}

export function ticketAiUsagePanel(runs: any[]) {
  const aiRuns = runs.filter((run) => aiInvocationPhases.includes(run.run_type));
  const summary = (label: string, selected: any[]) => {
    const captured = selected.filter((run) => run.ai_usage_status === "captured");
    const tokens = captured.reduce((total, run) => total + Number(run.total_tokens ?? 0), 0);
    const cost = selected.reduce((total, run) => total + (run.estimated_cost_usd == null ? 0 : Number(run.estimated_cost_usd)), 0);
    const coverage = ["Unavailable", "Unpriced", "Legacy"].map((label) => [label, selected.filter((run) => coverageLabel(run) === label).length] as const).filter(([, count]) => count);
    return `<div class="card"><div class="card-body"><div class="eyebrow">${label}</div><strong>${selected.length} invocations · ${tokens} tokens · ${escapeHtml(usd(cost))}</strong>${coverage.length ? `<p class="status">${coverage.map(([label, count]) => `${label} ${count}`).join(" · ")}</p>` : ""}</div></div>`;
  };
  const groups = [
    ["Planning", aiRuns.filter((run) => aiLifecycleGroup(run.run_type) === "planning")],
    ["Execution", aiRuns.filter((run) => aiLifecycleGroup(run.run_type) === "execution")],
    ["PR work", aiRuns.filter((run) => aiLifecycleGroup(run.run_type) === "pr_work")],
    ["All AI work", aiRuns],
  ] as const;
  const rows = runs.map((run) => `<a class="ticket-row" href="/admin/runs/${escapeHtml(run.id)}"><span class="mono">${escapeHtml(shortRef("RUN", run.id))}</span><strong>${escapeHtml(run.run_type)}</strong><span>${escapeHtml(run.model ?? "—")} · ${escapeHtml(run.reasoning_level ?? "—")}</span><span>${run.ai_usage_status === "captured" ? `${escapeHtml(run.total_tokens)} tokens · ${escapeHtml(run.estimated_cost_usd == null ? "Unpriced" : usd(Number(run.estimated_cost_usd)))}` : coverageLabel(run)}</span><span class="status ${statusTone(run.status)}">${escapeHtml(run.status ?? "—")} · ${escapeHtml(coverageLabel(run))}</span></a>`).join("");
  return `<section class="grid two">${groups.map(([label, selected]) => summary(label, selected)).join("")}</section><section class="card" style="margin-top:16px"><div class="card-head">Runs</div>${rows || '<div class="card-body"><p>No runs yet.</p></div>'}</section>`;
}

export function selectedStatusesFrom(url: URL): string[] {
  return url.searchParams.getAll("status").filter((status) => validStatuses.has(status));
}

export function skillPresentation(skill: any) {
  const required = skill.attachment_type === "required" || Boolean(skill.required);
  const automatic = !required && skill.attachment_type === "automatic";
  const projectAttached = required || automatic;
  const overridable = automatic && skill.allow_ticket_override === true;
  const selected = required || (automatic && !skill.excluded) || Boolean(skill.manual_selected);
  return {
    automatic, projectAttached, required, overridable, selected,
    removable: !projectAttached || overridable,
    badge: required ? "required" : automatic && !overridable ? "auto" : null,
  };
}

export function approvalGatesCard(ticket: { status: string }) {
  const canAcknowledge = ticket.status === "Submitted";
  return `<section class="card"><div class="card-head">Approval gates</div><div class="card-body">
    <p><button class="button" type="button" data-acknowledge-ticket${canAcknowledge ? "" : " disabled"} title="${canAcknowledge ? "" : "Ticket must be Submitted"}">Acknowledge</button></p></div></section>`;
}

export function ticketCreateModal(projects: Array<{ id: string; name: string }>) {
  const priorities = ["critical", "high", "medium", "low"];
  return `<button class="button primary" type="button" data-add-ticket-button>Add ticket</button><dialog data-add-ticket-modal aria-label="Add ticket"><div class="card-head">Add ticket</div><form data-add-ticket-form><div class="card-body"><label class="field"><span>Project</span><select name="project_id" required><option value="">Choose a project</option>${projects.map((project) => `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name)}</option>`).join("")}</select></label><label class="field"><span>Title</span><input name="title" required></label><label class="field"><span>Description</span><textarea name="description" rows="4" required></textarea></label><div class="grid two"><label class="field"><span>Category</span><input name="category"></label><label class="field"><span>Priority</span><select name="priority"><option value="">Choose priority</option>${priorities.map((priority) => `<option value="${priority}">${priority[0].toUpperCase()}${priority.slice(1)}</option>`).join("")}</select></label></div><label class="field"><span>Environment</span><input name="environment"></label><label class="field"><span>Expected behavior</span><textarea name="expected_behavior" rows="3"></textarea></label><label class="field"><span>Actual behavior</span><textarea name="actual_behavior" rows="3"></textarea></label><label class="field"><span>Reproduction steps</span><textarea name="reproduction_steps" rows="3"></textarea></label><p class="error" role="alert"></p></div><div style="padding:12px 18px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px"><button class="button" type="button" data-close-modal>Cancel</button><button class="button primary" type="submit">Create ticket</button></div></form></dialog>`;
}
export async function render(url: URL, session: Session, _metrics: Record<string, number>): Promise<PageResult> {
  if (url.pathname === "/admin/tickets") {
    const values: any[] = [];
    const conditions: string[] = [];
    for (const [key, column] of [["project_id", "t.project_id"], ["priority", "t.priority"], ["category", "t.category"], ["form", "f.slug"]] as const) {
      const value = url.searchParams.get(key);
      if (value) { values.push(value); conditions.push(`${column} = $${values.length}`); }
    }
    const selectedStatuses = selectedStatusesFrom(url);
    if (selectedStatuses.length) { values.push(selectedStatuses); conditions.push(`t.status = ANY($${values.length}::text[])`); }
    const search = url.searchParams.get("search");
    if (search) { values.push(`%${search}%`); conditions.push(`(t.ticket_number ILIKE $${values.length} OR t.title ILIKE $${values.length} OR t.description ILIKE $${values.length})`); }
    const view = url.searchParams.get("view");
    const isBoard = view === "board";
    const { limit, cursor } = pageRequest(url);
    // Board view has no pager and previously showed every ticket up to the
    // old LIMIT 200 across all 6 columns. Keep that ceiling here instead of
    // the table view's paginated PAGE_SIZE_DEFAULT (50) — otherwise
    // long-lived terminal-status cards (Merged/Completed/Archived), which
    // rarely get updated_at bumped, silently fall out of the board as newer
    // tickets push them past the top-50 window. Board also ignores any
    // cursor: it has no "Next" affordance to have produced one.
    const effectiveLimit = isBoard ? PAGE_SIZE_MAX : limit;
    if (!isBoard) {
      const keyset = keysetCondition(cursor, "t.updated_at", "t.id", values);
      if (keyset) conditions.push(keyset);
    }
    values.push(effectiveLimit);
    const limitIdx = values.length;
    const [ticketsResult, projectsResult] = await Promise.all([
      pool.query(
        `SELECT t.*,p.name project_name,f.name form_name FROM tickets t JOIN projects p ON p.id=t.project_id LEFT JOIN forms f ON f.id=t.form_id
         ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""} ORDER BY t.updated_at DESC, t.id DESC LIMIT $${limitIdx}`,
        values,
      ),
      pool.query("SELECT id, slug, name FROM projects ORDER BY name"),
    ]);
    const tickets = ticketsResult.rows;
    const projects = projectsResult.rows;
    const ticketsNext = nextCursor(tickets, effectiveLimit, "updated_at");

    const buildFilterUrl = (newView?: string) => {
      const params = new URLSearchParams();
      if (search) params.append("search", search);
      if (url.searchParams.get("project_id")) params.append("project_id", url.searchParams.get("project_id")!);
      if (url.searchParams.get("priority")) params.append("priority", url.searchParams.get("priority")!);
      for (const status of selectedStatuses) params.append("status", status);
      if (newView) params.append("view", newView);
      return `/admin/tickets${params.size > 0 ? "?" + params.toString() : ""}`;
    };

    const statusFilterLabel = selectedStatuses.length === 0
      ? "All statuses"
      : selectedStatuses.length === 1
        ? selectedStatuses[0]
        : `${selectedStatuses.length} statuses`;
    const statusFilterHtml = `<details class="menu" data-status-filter style="width:100%">
      <summary class="button" style="width:100%;text-align:left">${escapeHtml(statusFilterLabel)}</summary>
      <div class="menu-panel skill-options">
        ${[...validStatuses].map((status) => `<label><input type="checkbox" name="status" value="${escapeHtml(status)}" data-ticket-filter${selectedStatuses.includes(status) ? " checked" : ""}> ${escapeHtml(status)}</label>`).join("")}
      </div>
    </details>`;

    const statusToneMap: Record<string, string> = {
      "Submitted": "info", "Triage": "info", "Needs Information": "warn",
      "Approved for Planning": "ok", "Planning Queued": "info", "Planning": "run", "Planning Failed": "danger", "Plan Ready for Review": "run", "Plan Revision Requested": "warn", "Plan Revision Queued": "run", "Plan Approved": "ok",
      "Execution Queued": "info", "Executing": "run", "Validating": "run", "Validation Failed": "danger", "Execution Failed": "danger", "PR Creation Failed": "danger",
      "PR Ready for Review": "warn", "PR Changes Requested": "warn", "PR Approved": "ok",
      "Merged": "ok", "Completed": "ok", "Rejected": "danger", "Cancelled": "muted", "Archived": "muted", "Closed Without Merge": "muted",
    };

    const prioTone = { critical: "danger", high: "warn", medium: "info", low: "muted" } as Record<string, string>;

    const createTicket = ticketCreateModal(projects);
    if (isBoard) {
      // Board view: group tickets into 6 status columns
      const boardColumns = {
        "Triage": ["Submitted", "Triage", "Needs Information"],
        "Planning": ["Approved for Planning", "Planning Queued", "Planning", "Planning Failed", "Plan Revision Requested", "Plan Revision Queued"],
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
          const tone = `var(--t-${statusToneMap[ticket.status] ?? "muted"})`;
          const prioColor = prioTone[ticket.priority || "low"] ?? "muted";
          return `<a class="ticket-row" style="display:block;border-left:2px solid ${tone};padding:10px 12px;text-decoration:none;margin-bottom:8px;background:var(--surface);border-radius:4px" href="/admin/tickets/${escapeHtml(ticket.ticket_number)}">
            <span class="mono" style="font-size:11px">${escapeHtml(ticket.ticket_number)}</span>
            <span style="display:inline-block;font-size:11px;font-weight:700;padding:2px 6px;border-radius:3px;margin-left:4px;background:var(--primary-soft);color:var(--t-${prioColor})">${escapeHtml(ticket.priority || "—")}</span>
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
          <a class="button" style="background:var(--primary-soft);color:var(--primary)">Board</a>
          <span style="margin-left:auto">${createTicket}</span>
        </div>
        <form class="toolbar" id="filters" style="margin-top:16px">
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;flex:1;min-width:min(600px,100%)">
            <input class="search" data-ticket-filter name="search" placeholder="Search ticket number or title…" value="${escapeHtml(search || "")}">
            <select data-ticket-filter name="project_id">
              <option value="">All projects</option>
              ${projects.map((p) => `<option value="${p.id}"${url.searchParams.get("project_id") === p.id ? " selected" : ""}>${escapeHtml(p.name)}</option>`).join("")}
            </select>
            <select data-ticket-filter name="priority">
              <option value="">All priorities</option>
              <option value="critical"${url.searchParams.get("priority") === "critical" ? " selected" : ""}>Critical</option>
              <option value="high"${url.searchParams.get("priority") === "high" ? " selected" : ""}>High</option>
              <option value="medium"${url.searchParams.get("priority") === "medium" ? " selected" : ""}>Medium</option>
              <option value="low"${url.searchParams.get("priority") === "low" ? " selected" : ""}>Low</option>
            </select>
            ${statusFilterHtml}
          </div>
          <a class="button" data-tickets-reset href="/admin/tickets">Reset</a>
          <span aria-live="polite" style="margin-left:auto">${tickets.length} shown</span>
        </form>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px;margin-top:16px">${boardColumnsHtml}</div>`;
      return { status: 200, title: "Tickets", body };
    }

    // Table view
    const rows = tickets.map((ticket) => `<a class="ticket-row tickets7" href="/admin/tickets/${escapeHtml(ticket.ticket_number)}"><span class="mono">${escapeHtml(ticket.ticket_number)}</span><strong>${escapeHtml(ticket.title)}</strong><span>${escapeHtml(ticket.project_name)}</span><span>${escapeHtml(ticket.priority || "—")}</span><span class="mono">${escapeHtml(ticket.default_model || "—")} · ${escapeHtml(ticket.default_reasoning_level || "—")}</span>${statusBadge(ticket.status)}<time>${new Date(ticket.updated_at).toLocaleDateString("nl-NL")}</time></a>`).join("");
    const emptyState = tickets.length === 0 ? `<div style="padding:48px 20px;text-align:center;color:var(--text3);font-size:13.5px">No tickets match these filters.</div>` : "";
    const body = `<div class="eyebrow">Work · intake</div><h1>Tickets</h1>
      <div class="toolbar">
        <a class="button" style="background:var(--primary-soft);color:var(--primary)">Table</a>
        <a class="button" href="${escapeHtml(buildFilterUrl("board"))}">Board</a>
        <span style="margin-left:auto">${createTicket}</span>
      </div>
      <form class="toolbar" id="filters" style="margin-top:16px">
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;flex:1;min-width:min(600px,100%)">
          <input class="search" data-ticket-filter name="search" placeholder="Search ticket number or title…" value="${escapeHtml(search || "")}">
          <select data-ticket-filter name="project_id">
            <option value="">All projects</option>
            ${projects.map((p) => `<option value="${p.id}"${url.searchParams.get("project_id") === p.id ? " selected" : ""}>${escapeHtml(p.name)}</option>`).join("")}
          </select>
          <select data-ticket-filter name="priority">
            <option value="">All priorities</option>
            <option value="critical"${url.searchParams.get("priority") === "critical" ? " selected" : ""}>Critical</option>
            <option value="high"${url.searchParams.get("priority") === "high" ? " selected" : ""}>High</option>
            <option value="medium"${url.searchParams.get("priority") === "medium" ? " selected" : ""}>Medium</option>
            <option value="low"${url.searchParams.get("priority") === "low" ? " selected" : ""}>Low</option>
          </select>
          ${statusFilterHtml}
        </div>
        <a class="button" data-tickets-reset href="/admin/tickets">Reset</a>
        <span aria-live="polite" style="margin-left:auto">${tickets.length} shown</span>
      </form>
      <section class="card">${emptyState || `<div class="list-head tickets7"><span>Ticket</span><span>Title</span><span>Project</span><span>Priority</span><span>AI config</span><span>Status</span><span>Updated</span></div>${rows}`}</section>
      ${pagerHtml(url, ticketsNext)}`;
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
      `SELECT pv.*,p.planning_session_id,p.current_version_id,ar.model,ar.reasoning_level,ps.content prompt_content
       FROM plans p JOIN plan_versions pv ON pv.plan_id=p.id
       JOIN agent_runs ar ON ar.id=pv.agent_run_id
       JOIN prompt_snapshots ps ON ps.id=pv.prompt_snapshot_id
       WHERE p.ticket_id=$1 ORDER BY pv.version DESC`,
      [ticket.id],
    )).rows;
    const target = versions.find((version) => version.version === Number(planVersionPageMatch[2]));
    if (!target) return { status: 404, title: "Plan version not found", body: "<h1>Plan version not found</h1>" };
    const previous = versions.find((version) => version.version === target.version - 1);
    const versionsRail = versions.map((version) => `<a class="ticket-row"${version.id === target.id ? ' style="background:var(--primary-soft);border-left:2px solid var(--primary)"' : ""} href="/admin/tickets/${escapeHtml(ticket.ticket_number)}/plans/${version.version}"><span class="mono">v${version.version}</span><span>${escapeHtml(version.model)} · ${escapeHtml(version.reasoning_level)}</span></a>`).join("");
    const isApproved = ticket.approved_plan_version_id === target.id;
    const isCurrent = target.id === target.current_version_id;
    // ponytail: only the current version can ever be approved server-side —
    // gating the button on the same condition avoids the misleading "still
    // clickable" state the user hit after approving.
    const approveDisabledReason = isApproved ? "Already approved" : !isCurrent ? "A newer version exists — only the current version can be approved" : "";
    const body = `<div class="eyebrow">${escapeHtml(ticket.ticket_number)} · ${escapeHtml(ticket.project_name)} ${statusBadge(ticket.status)}</div>
      <h1>Plan review · v${target.version}</h1>
      <div class="toolbar"><a class="button" href="/admin/tickets/${escapeHtml(ticket.ticket_number)}/plans">Back to plans</a>
        <button class="button" type="button" data-open-revision-dialog>Request revision</button>
        <button class="button" style="color:var(--t-danger);border-color:var(--t-danger)" type="button" data-reject-plan-version="${target.id}">Reject</button>
        <button class="button primary" type="button" data-open-approve-dialog${approveDisabledReason ? " disabled" : ""} title="${escapeHtml(approveDisabledReason)}">${isApproved ? "Approved" : "Approve this version"}</button></div>
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
        <p class="error" role="alert"></p><button class="button" type="button" data-close-dialog>Cancel</button> <button class="button primary" type="button" data-submit-revision>Submit feedback &amp; queue revision</button></div></dialog>
      <dialog data-approve-dialog aria-label="Approve plan version" data-plan-version-id="${target.id}" data-content-hash="${escapeHtml(target.content_hash)}"><div class="card-head">Approve this version</div>
        <div class="card-body"><label class="field"><span>Note (optional) — open questions or extra context</span><textarea data-approve-note rows="4" placeholder="e.g. approved, but double-check the migration rollback plan"></textarea></label>
        <p class="error" role="alert"></p><button class="button" type="button" data-close-dialog>Cancel</button> <button class="button primary" type="button" data-confirm-approve>Approve</button></div></dialog>`;
    return { status: 200, title: `${ticket.ticket_number} · Plan review`, body };
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
      ${versions.map((version) => `<section class="card"><div class="card-head">Version ${version.version} · ${escapeHtml(version.model)} / ${escapeHtml(version.reasoning_level)} <a class="button primary" href="/admin/tickets/${escapeHtml(ticket.ticket_number)}/plans/${version.version}">Review &amp; approve</a></div>
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
    const [notesResult, historyResult, skillsResult, notificationsResult, runsResult, prsResult, planVersionsResult, attachmentsResult, projectsResult, sourceFields] = await Promise.all([
      pool.query("SELECT n.*,u.username FROM ticket_notes n LEFT JOIN users u ON u.id=n.author_id WHERE ticket_id=$1 ORDER BY n.created_at DESC", [ticket.id]),
      pool.query("SELECT * FROM ticket_status_history WHERE ticket_id=$1 ORDER BY created_at DESC", [ticket.id]),
      pool.query(
        `SELECT s.*,ps.attachment_type,ps.required,ps.allow_ticket_override,
                ts.id IS NOT NULL AND ts.source<>'excluded' manual_selected,ts.source='excluded' excluded
         FROM skills s
         LEFT JOIN LATERAL (
           SELECT CASE WHEN bool_or(required OR attachment_type='required') THEN 'required' ELSE 'automatic' END attachment_type,
                  bool_or(required OR attachment_type='required') required,bool_or(allow_ticket_override) allow_ticket_override
           FROM project_skills WHERE skill_id=s.id AND project_id=$1
             AND (attachment_type IN ('automatic','required') OR required)
           HAVING count(*)>0
         ) ps ON true
         LEFT JOIN ticket_skills ts ON ts.skill_id=s.id AND ts.ticket_id=$2
         ORDER BY s.category,s.name`,
        [ticket.project_id, ticket.id],
      ),
      pool.query(
        `SELECT nd.*,np.name provider
         FROM notification_deliveries nd LEFT JOIN notification_providers np ON np.id=nd.provider_id
         WHERE nd.ticket_id=$1 ORDER BY nd.created_at DESC`,
        [ticket.id],
      ),
      pool.query("SELECT * FROM agent_runs WHERE ticket_id=$1 ORDER BY started_at DESC NULLS LAST", [ticket.id]),
      pool.query("SELECT * FROM pull_requests WHERE ticket_id=$1 ORDER BY created_at DESC", [ticket.id]),
      pool.query(
        `SELECT pv.*,p.current_version_id,ar.model,ar.reasoning_level
         FROM plans p JOIN plan_versions pv ON pv.plan_id=p.id
         JOIN agent_runs ar ON ar.id=pv.agent_run_id
         WHERE p.ticket_id=$1 ORDER BY pv.version DESC`,
        [ticket.id],
      ),
      pool.query("SELECT a.id,u.original_name,u.media_type,u.size_bytes FROM attachments a JOIN uploads u ON u.id=a.upload_id WHERE a.ticket_id=$1 ORDER BY a.created_at", [ticket.id]),
      pool.query("SELECT id, slug, name FROM projects ORDER BY name"),
      ticket.form_id ? fieldsFor(ticket.form_id) : Promise.resolve(standardFields),
    ]);
    const notes = notesResult.rows;
    const history = historyResult.rows;
    const skillRows = skillsResult.rows.map((skill) => ({ ...skill, ...skillPresentation(skill) }));
    const selectedSkills = skillRows.filter((skill) => skill.selected);
    const chips = selectedSkills.map((skill) =>
      `<span class="skill-chip" data-skill-chip="${skill.id}" data-slug="${escapeHtml(skill.slug)}" title="${skill.required ? "Required by project" : skill.automatic ? "Automatically added by project" : "Selected on this ticket"} · ${escapeHtml(skill.filesystem_path)}">${escapeHtml(skill.name)}
       ${skill.removable ? `<button type="button" aria-label="Remove ${escapeHtml(skill.name)}" data-remove-skill="${skill.id}">×</button>` : `<small>${skill.badge}</small>`}</span>`,
    ).join("");
    const referenceLines = selectedSkills.map((skill) => `- ${skill.slug}: ${skill.filesystem_path}`).join("\n") || "No skills resolved for this ticket.";
    const modelOptions = `<option value=""${!ticket.default_model ? " selected" : ""}>Inherit (system default)</option>` +
      aiModels.map((model) => `<option value="${model}"${ticket.default_model === model ? " selected" : ""}>${model[0].toUpperCase()}${model.slice(1)}</option>`).join("");
    const reasoningOptions = `<option value=""${!ticket.default_reasoning_level ? " selected" : ""}>Inherit (system default)</option>` +
      [["low","Low"],["medium","Medium"],["high","High"],["xhigh","Extra high"],["max","Maximum"],["ultracode","Ultracode"]].map(([value,label]) => `<option value="${value}"${ticket.default_reasoning_level === value ? " selected" : ""}>${label}</option>`).join("");
    const phaseConfiguration = (phase: "planning" | "execution" | "repair") => {
      const selectedModel = ticket[`${phase}_model`];
      const selectedReasoning = ticket[`${phase}_reasoning_level`];
      const models = `<option value=""${!selectedModel ? " selected" : ""}>Inherit</option>` +
        aiModels.map((model) => `<option value="${model}"${selectedModel === model ? " selected" : ""}>${model[0].toUpperCase()}${model.slice(1)}</option>`).join("");
      const reasoning = `<option value=""${!selectedReasoning ? " selected" : ""}>Inherit</option>` +
        [["low","Low"],["medium","Medium"],["high","High"],["xhigh","Extra high"],["max","Maximum"],["ultracode","Ultracode"]].map(([value,label]) => `<option value="${value}"${selectedReasoning === value ? " selected" : ""}>${label}</option>`).join("");
      return `<fieldset><legend>${phase[0].toUpperCase()}${phase.slice(1)}</legend><div class="grid two"><label class="field"><span>Model</span><select name="${phase}_model">${models}</select></label><label class="field"><span>Reasoning level</span><select name="${phase}_reasoning_level">${reasoning}</select></label></div></fieldset>`;
    };
    const execRuns = runsResult.rows.filter((run) => run.run_type === "execution");
    const executionGate = await checkPlanApprovalGate(pool, ticket.id);
    const panel = (index: number, content: string) => `<div role="tabpanel" id="panel-${index}" aria-labelledby="tab-${index}"${index === 0 ? "" : " hidden"}>${content}</div>`;
    const submissionValues = { ...(ticket.custom_values_json ?? {}), ...ticket };
    const overviewPanel = `<div class="grid two"><section class="card"><div class="card-head">Original submission <button class="button" type="button" data-edit-ticket>Edit</button></div><div class="card-body">
      <div data-ticket-view><p>${escapeHtml(ticket.description)}</p><dl><dt>Category</dt><dd>${escapeHtml(ticket.category)}</dd><dt>Environment</dt><dd>${escapeHtml(ticket.environment)}</dd><dt>Source URL</dt><dd>${escapeHtml(ticket.source_url)}</dd></dl></div>
      <form data-ticket-edit-form data-ticket-id="${ticket.id}" hidden>
        ${formControls(sourceFields, projectsResult.rows, submissionValues, "admin")}
        <button class="button" type="submit">Save</button> <button class="button" type="button" data-cancel-edit-ticket>Cancel</button><p class="error" role="alert"></p>
      </form>
      </div></section>
      <section class="card"><div class="card-head">Internal notes</div><div class="card-body notes">${notes.map((note) => `<div class="note"><strong>${escapeHtml(note.username ?? "Administrator")}</strong><p>${escapeHtml(note.body)}</p></div>`).join("") || "<p>No notes yet.</p>"}<form data-notes-form><label class="field"><span>Add an internal note…</span><textarea name="body" placeholder="Add an internal note…" rows="3"></textarea></label><button class="button" type="submit">Save note</button><p class="error" role="alert"></p></form></div></section></div>
      <div class="grid rail"><section class="card"><div class="card-head">Ticket</div><div class="card-body"><dl><dt>Project</dt><dd>${escapeHtml(ticket.project_name)}</dd><dt>Category</dt><dd>${escapeHtml(ticket.category)}</dd><dt>Source form</dt><dd>${escapeHtml(ticket.form_name ?? "—")}</dd><dt>Created</dt><dd>${new Date(ticket.created_at).toLocaleDateString("nl-NL")}</dd></dl></div></section>
      <section class="card"><div class="card-head">Attachments</div><div class="card-body">${attachmentsResult.rows.map((a) => `<p><a href="/admin/attachments/${a.id}">${escapeHtml(a.original_name ?? "attachment")}</a> <span class="mono">${escapeHtml(a.media_type)} · ${Math.round(a.size_bytes / 1024)} kB</span></p>`).join("") || "<p>No attachments.</p>"}</div></section>
      ${approvalGatesCard(ticket)}
      <section class="card"><div class="card-head">Danger zone</div><div class="card-body"><p><button class="button" style="color:var(--t-danger);border-color:var(--t-danger)" type="button" data-reject-ticket${["Submitted", "Triage", "Needs Information"].includes(ticket.status) ? "" : " disabled"} title="${["Submitted", "Triage", "Needs Information"].includes(ticket.status) ? "" : "Can only reject early-stage tickets"}">Reject</button></p><p><button class="button" style="color:var(--t-danger);border-color:var(--t-danger)" type="button" data-cancel-ticket${["Planning Queued", "Planning", "Planning Failed", "Execution Queued", "Executing"].includes(ticket.status) ? "" : " disabled"} title="${["Planning Queued", "Planning", "Planning Failed", "Execution Queued", "Executing"].includes(ticket.status) ? "" : "Can only cancel in-progress tickets"}">Cancel</button></p><p><button class="button" style="color:var(--t-danger);border-color:var(--t-danger)" type="button" data-archive-ticket${["Completed", "Merged", "Rejected", "Cancelled"].includes(ticket.status) ? "" : " disabled"} title="${["Completed", "Merged", "Rejected", "Cancelled"].includes(ticket.status) ? "" : "Can only archive finished tickets"}">Archive</button></p></div></section></div>`;
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
        ${skillRows.map((skill) => `<label data-skill-option data-search="${escapeHtml(`${skill.name} ${skill.slug} ${skill.category}`.toLowerCase())}"><input type="checkbox" value="${skill.id}" data-skill-toggle data-slug="${escapeHtml(skill.slug)}" data-name="${escapeHtml(skill.name)}" data-path="${escapeHtml(skill.filesystem_path)}"${skill.projectAttached ? " data-project" : ""}${skill.automatic ? " data-auto" : ""}${skill.required ? " data-required" : ""}${skill.overridable ? " data-overridable" : ""}${skill.badge ? ` data-badge="${skill.badge}"` : ""}${skill.selected ? " checked" : ""}${!skill.removable || !skill.enabled ? " disabled" : ""}> ${escapeHtml(skill.name)} <small>${escapeHtml(skill.category)}${skill.required ? " · Required by project" : skill.automatic ? " · Automatically added by project" : ""}${!skill.enabled ? " · disabled" : ""}</small></label>`).join("")}</div>
      </div></section>
      <section class="card"><div class="card-head">Resolved references injected into the prompt (<span data-ref-count>${selectedSkills.length}</span>)</div><div class="card-body"><pre class="references" data-skill-references>Use the following skills:
${escapeHtml(referenceLines)}</pre></div></section>`;
    const promptPanel = `<section class="card"><div class="card-head">Assembled prompt</div><div class="card-body"><p>Compiled from the current prompt versions, project configuration, resolved AI configuration, resolved skills, and this ticket — without creating a run or snapshot.</p>
      <pre class="references">Use the following skills:
<span data-prompt-skills>${escapeHtml(referenceLines)}</span></pre>
      <a class="button" href="/api/admin/tickets/${ticket.id}/prompt-preview">Open full planning prompt preview</a></div></section>`;
    const planVersions = planVersionsResult.rows;
    const currentPlanVersion = planVersions.find((version) => version.id === version.current_version_id);
    // ponytail: no dedicated status column on plan_versions — derive the
    // label from what already exists (approval pointer, current-version
    // pointer, ticket status) instead of adding a migration for it.
    const planVersionStatus = (version: (typeof planVersions)[number]) => {
      if (ticket.approved_plan_version_id === version.id) return "Approved";
      if (version.id !== version.current_version_id) return "Revision requested";
      if (ticket.status === "Rejected") return "Rejected";
      return "Ready for review";
    };
    const plansPanel = `<section class="card"><div class="card-head">Planning</div>${planVersions.length ? planVersions.map((version) =>
      `<a class="ticket-row" href="/admin/tickets/${ticket.ticket_number}/plans/${version.version}"><span class="mono">v${version.version}</span><strong>${escapeHtml(planVersionStatus(version))}</strong><span>${escapeHtml(version.model)} · ${escapeHtml(version.reasoning_level)}</span><time>${new Date(version.created_at).toLocaleString("nl-NL")}</time></a>`,
    ).join("") : '<div class="card-body"><p>No plan has been generated yet.</p></div>'}</section>`;
    const runsPanel = ticketAiUsagePanel(runsResult.rows);
    const validationPanel = `<section class="card"><div class="card-head">Validation</div><div class="card-body">${execRuns.map((run) =>
      `<p>${statusBadge(run.status)} ${run.error_code === "validation_failed" ? "<strong>Validation failed</strong> — " : ""}${escapeHtml(run.error_message ?? "")}</p>`,
    ).join("") || "<p>Greyed out until an execution attempt exists.</p>"}</div></section>`;
    const prPanel = `<section class="card"><div class="card-head">Pull request</div>${prsResult.rows.map((item) => {
      const policy = !item.current_policy_snapshot_id || !item.head_sha
        ? "Unavailable"
        : item.policy_stale
        ? `Stale${item.policy_error_code ? `: ${item.policy_error_code}` : ""}`
        : !item.policy_complete
        ? "Incomplete"
        : item.review_state ?? "Unknown";
      const synced = item.policy_synced_at ? ` · ${new Date(item.policy_synced_at).toLocaleString("nl-NL")}` : "";
      return `<a class="ticket-row" href="/admin/pull-requests/${item.id}"><span class="mono">#${item.number}</span><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.head_branch)}</span><span class="status ${policy === "Current" ? "ok" : "warn"}">GitHub: ${escapeHtml(policy)}${synced}</span><time>${new Date(item.created_at).toLocaleDateString("nl-NL")}</time></a>`;
    }).join("") || '<div class="card-body"><p>No pull request yet — the worker opens a draft PR after a validated execution.</p></div>'}</section>`;
    const activityPanel = `<section class="card"><div class="card-head">Status history</div><div class="card-body">${history.map((item) => `<p><span class="mono">${new Date(item.created_at).toLocaleString("nl-NL")}</span> ${escapeHtml(item.previous_status ?? "New")} → <strong>${escapeHtml(item.new_status)}</strong>${item.reason ? `<br><span style="color:var(--text2)">${escapeHtml(item.reason)}</span>` : ""}</p>`).join("") || "<p>No recorded transitions.</p>"}</div></section>
      <section class="card"><div class="card-head">Notification history</div><div class="card-body">${notificationsResult.rows.map((item) =>
        `<p><strong>${escapeHtml(item.event_type)}</strong> · ${escapeHtml(item.provider ?? "Unknown provider")} · ${escapeHtml(item.recipient ?? "default recipient")} · ${escapeHtml(item.status)} · attempts ${item.attempt_count ?? 0}${item.response_status ? ` · HTTP ${item.response_status}` : ""}${item.sent_at ? ` · ${new Date(item.sent_at).toLocaleString("nl-NL")}` : ""}${item.error_message ? `<br><span class="error">${escapeHtml(item.error_message)}</span>` : ""}</p>`,
      ).join("") || "<p>No notifications yet.</p>"}</div></section>`;
    const failedPlanningRun = ticket.status === "Planning Failed"
      ? runsResult.rows.find((run) =>
          (run.run_type === "planning" || run.run_type === "plan_revision")
          && run.status === "failed"
          && (run.error_code === "planning_failed" || run.error_code === "invalid_plan_structure"),
        )
      : null;
    // ponytail: with an existing plan, "approve for planning" would enqueue a
    // fresh planning.generate whose v1.md write collides (flag:"wx") — point
    // the retry at the revision flow instead.
    const planningFailureBanner = failedPlanningRun
      ? `<div style="border:1px solid var(--t-danger);border-left:3px;background:var(--s-danger);border-radius:5px;padding:13px 16px;margin:14px 0"><strong>Planning failed.</strong> <em>${escapeHtml(failedPlanningRun.error_message ?? failedPlanningRun.error_code ?? "planning failed")}</em> <a href="/admin/runs/${failedPlanningRun.id}">View failed run</a> — ${planVersions.length ? "request a revision of the existing plan to retry" : "approve for planning to retry"}.</div>`
      : "";
    const currentPlanLink = currentPlanVersion ? `/admin/tickets/${ticket.ticket_number}/plans/${currentPlanVersion.version}` : "";
    const approvedPlanVersion = planVersions.find((version) => version.id === ticket.approved_plan_version_id);
    const approvedPlanLink = approvedPlanVersion ? `/admin/tickets/${ticket.ticket_number}/plans/${approvedPlanVersion.version}` : "";
    const workflowAction = !currentPlanVersion && ["Triage", "Needs Information", "Planning Failed"].includes(ticket.status)
      ? `<button class="button primary" type="button" data-start-planning>Start planning</button>`
      : currentPlanLink && ["Needs Information", "Planning Failed"].includes(ticket.status)
      ? `<a class="button primary" href="${currentPlanLink}">Revise plan</a>`
      : ticket.status === "Plan Ready for Review" && currentPlanLink
      ? `<a class="button primary" href="${currentPlanLink}">Review plan</a>`
      : ticket.status === "Plan Approved" && approvedPlanLink
      ? `<button class="button primary" type="button" data-start-execution${executionGate.valid ? "" : " disabled"} title="${executionGate.valid ? "" : executionGate.message}">Start execution</button><a class="button" href="${approvedPlanLink}">Update plan</a>`
      : ticket.status === "Execution Failed" && approvedPlanLink
      ? `<button class="button primary" type="button" data-start-execution${executionGate.valid ? "" : " disabled"} title="${executionGate.valid ? "" : executionGate.message}">Retry execution</button><a class="button" href="${approvedPlanLink}">Update plan</a>`
      : "";
    const body = `<div class="eyebrow">${escapeHtml(ticket.ticket_number)} · ${escapeHtml(ticket.project_name)}</div><h1>${escapeHtml(ticket.title)}</h1>
      <div class="toolbar">${statusBadge(ticket.status)}
        ${["Completed", "Merged", "Closed Without Merge"].includes(ticket.status) ? `<button class="button" style="color:var(--t-danger);border-color:var(--t-danger)" type="button" data-reopen-ticket>Reopen</button>` : `<button class="button" type="button" data-open-preview>Preview prompt</button>
        ${workflowAction}`}</div>
      ${planningFailureBanner}
      <dialog data-preview-dialog aria-label="Prompt preview"><div class="card-head">Prompt preview</div><p>This is the exact, complete prompt sent to Claude — including global instructions, project context, resolved AI configuration, resolved skills, and ticket content.</p><pre class="references">Loading…</pre><button class="button" type="button" data-close-dialog>Close</button></dialog>
      <dialog data-commit-dialog aria-label="Uncommitted changes"><div class="card-head">Uncommitted changes</div><div class="card-body"><p>This repository has uncommitted changes. Commit them before planning can start:</p><ul data-commit-files></ul><label class="field"><span>Commit message</span><input name="commit_message" value="chore: pre-planning snapshot"></label><p class="error" role="alert"></p></div><div style="padding:12px 18px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px"><button class="button" type="button" data-close-commit-dialog>Cancel</button><button class="button primary" type="button" data-submit-commit>Commit &amp; Approve</button></div></dialog>
      <div class="tabs" role="tablist">${["Overview", "AI & skills", "Prompt", "Plans", "AI usage", "Validation", "Pull request", "Activity"].map((label, index) => `<button type="button" role="tab" id="tab-${index}" aria-controls="panel-${index}" aria-selected="${index === 0}">${label}</button>`).join("")}</div>
      ${[overviewPanel, aiPanel, promptPanel, plansPanel, runsPanel, validationPanel, prPanel, activityPanel].map((content, index) => panel(index, content)).join("")}`;
    return { status: 200, title: ticket.ticket_number, body };
  }
  return null;
}
