import { escapeHtml, pool, renderMarkdown, shortRef } from "./shared.ts";
import type { PageResult, Session } from "./shared.ts";
import { aiModels, reasoningLevels } from "@dcc/domain";

const detailQuery = `SELECT pr.*,p.name project_name,p.slug project_slug,t.ticket_number,t.title ticket_title,t.status ticket_status,t.approved_plan_hash,
              pv.content_markdown approved_plan,ar.id run_id,ar.model run_model,ar.reasoning_level run_reasoning_level,
              ar.metadata_json,ea.result_commit,jsonb_array_length(ss.skills_json) skills_applied
       FROM pull_requests pr JOIN projects p ON p.id=pr.project_id
       LEFT JOIN tickets t ON t.id=pr.ticket_id
       LEFT JOIN plan_versions pv ON pv.id=t.approved_plan_version_id
       LEFT JOIN execution_attempts ea ON ea.id=pr.execution_attempt_id
       LEFT JOIN agent_runs ar ON ar.id=ea.agent_run_id
       LEFT JOIN skill_snapshots ss ON ss.run_id=ar.id`;

// Shared by both the uuid route (/admin/pull-requests/{uuid}) and the slug
// route (/admin/pull-requests/{projectSlug}/{number}) so the two never drift.
function renderDetail(item: any, aiReviews: any[]): PageResult {
  if (!item) return { status: 404, title: "Pull request not found", body: "<h1>Pull request not found</h1>" };
  const validation = item.metadata_json?.validation_output ?? {};
  const changes = (item.additions != null || item.deletions != null || item.changed_files != null)
    ? `+${item.additions ?? 0} −${item.deletions ?? 0} · ${item.changed_files ?? 0} files` : "Unknown";
  const canMarkReviewed = item.internal_review_state !== "reviewed";
  const canApprove = item.internal_review_state !== "approved";
  const canRequestChanges = item.internal_review_state !== "changes_requested";
  const canCloseTicket = Boolean(item.ticket_id) && !["Completed", "Closed Without Merge"].includes(item.ticket_status);
  const canStartRepair = Boolean(item.run_id);
  const button = (attr: string, label: string, allowed: boolean, deniedReason: string, extraClass = "") =>
    `<button class="button${extraClass}" type="button" ${attr}${allowed ? "" : " disabled"} title="${allowed ? "" : escapeHtml(deniedReason)}">${label}</button>`;
  const body = `<div class="eyebrow">${escapeHtml(item.project_name)} · ${escapeHtml(item.repository)}</div>
    <p class="mono">${escapeHtml(item.project_slug)}/${escapeHtml(item.repository)} #${item.number}</p>
    <h1>${escapeHtml(item.title)}</h1>
    <div class="toolbar" data-pr-id="${item.id}">
      <span class="status">${escapeHtml(item.is_draft ? "Draft" : item.state)}</span>
      <span class="status">${escapeHtml(item.review_state ?? "Review pending")}</span>
      <span class="status">${escapeHtml(item.internal_review_state ?? "Not reviewed")}</span>
      ${item.merge_conflicts ? `<span class="status danger">Conflicts</span>` : ""}
      <a class="button" href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">Open on GitHub ↗</a>
      <button class="button" type="button" data-pr-refresh>Refresh</button>
      ${button("data-pr-request-changes", "Request changes", canRequestChanges, "Changes already requested")}
      ${button("data-pr-mark-reviewed", "Mark reviewed", canMarkReviewed, "Already marked reviewed")}
      <input type="text" data-pr-target-branch value="${escapeHtml(item.base_branch)}" placeholder="Target branch" style="width:120px" title="Branch to merge into (defaults to current base)">
      ${button("data-pr-approve", "Approve & merge", canApprove, "Already approved internally", " primary")}
      ${button("data-pr-close-ticket", "Close ticket", canCloseTicket, item.ticket_id ? "Ticket is already closed" : "No linked ticket")}
      <button class="button" type="button" data-open-create-ticket data-project-id="${item.project_id}" data-title="Follow-up: ${escapeHtml(item.title)}">Create follow-up ticket</button>
    </div>
    <div class="toolbar" data-ai-review-controls>
      <select data-ai-review-mode>
        <option value="review_only">Review only</option>
        <option value="review_and_merge">Review &amp; merge</option>
      </select>
      <details>
        <summary>Override model/effort</summary>
        <select data-ai-review-model><option value="">(default)</option>${aiModels.map((m) => `<option value="${m}">${escapeHtml(m)}</option>`).join("")}</select>
        <select data-ai-review-reasoning><option value="">(default)</option>${reasoningLevels.map((r) => `<option value="${r}">${escapeHtml(r)}</option>`).join("")}</select>
      </details>
      <button class="button primary" type="button" data-pr-ai-review>Run AI Review</button>
    </div>
    <dialog data-create-ticket-dialog aria-label="Create follow-up ticket"><div class="card-head">Create follow-up ticket</div><form data-create-ticket-form><div class="card-body"><label class="field"><span>Title</span><input name="title" required></label><label class="field"><span>Description</span><textarea name="description" rows="4"></textarea></label><p class="error" role="alert"></p></div><div style="padding:12px 18px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px"><button class="button" type="button" data-close-dialog>Cancel</button><button class="button primary" type="submit">Create</button></div></form></dialog>
    <div class="grid two"><section class="card"><div class="card-head">Metadata</div><div class="card-body"><dl>
    <dt>Ticket</dt><dd>${item.ticket_number ? `<a href="/admin/tickets/${escapeHtml(item.ticket_number)}">${escapeHtml(item.ticket_number)} · ${escapeHtml(item.ticket_title)}</a> (${escapeHtml(item.ticket_status)})` : `<span style="color:var(--text3)">Not linked</span>`}</dd>
    <dt>Author</dt><dd>${escapeHtml(item.author)}</dd><dt>Branches</dt><dd>${escapeHtml(item.head_branch)} → ${escapeHtml(item.base_branch)}</dd>
    <dt>Checks</dt><dd>${escapeHtml(item.check_state ?? "Unknown")}</dd><dt>Internal review</dt><dd>${escapeHtml(item.internal_review_state ?? "Not reviewed")}</dd>
    <dt>Changes</dt><dd class="mono">${escapeHtml(changes)}</dd>
    <dt>Model used</dt><dd>${item.run_model ? `${escapeHtml(item.run_model)} · ${escapeHtml(item.run_reasoning_level)}` : "Not run by the platform"}</dd>
    <dt>Run</dt><dd>${item.run_id ? `<a href="/admin/runs/${item.run_id}">${shortRef("RUN", item.run_id)}</a>` : "Not linked"}</dd>
    <dt>Plan hash</dt><dd class="mono">${item.approved_plan_hash ? escapeHtml(item.approved_plan_hash.slice(0, 12)) : "—"}</dd>
    <dt>Skills applied</dt><dd>${item.skills_applied != null ? escapeHtml(String(item.skills_applied)) : "—"}</dd>
    <dt>Created</dt><dd>${item.created_at_provider ? new Date(item.created_at_provider).toLocaleString() : "—"}</dd>
    <dt>Last synced</dt><dd>${item.last_synced_at ? new Date(item.last_synced_at).toLocaleString("nl-NL") : "Never"}</dd></dl></div></section>
    <section class="card"><div class="card-head">Changed files & validation</div><div class="card-body"><pre>${escapeHtml(JSON.stringify({ changed_files: validation.changed_files ?? [], results: validation.results ?? [] }, null, 2))}</pre></div></section></div>
    ${item.body ? `<section class="card"><h2>Description</h2>${renderMarkdown(item.body)}</section>` : ""}
    <section class="card"><div class="card-head">Approved plan</div><div class="card-body">${item.approved_plan ? renderMarkdown(item.approved_plan) : "<p>No approved plan linked.</p>"}</div></section>
    <section class="card"><div class="card-head">Implementation & commits</div><div class="card-body"><p>${escapeHtml(item.metadata_json?.implementation_summary ?? "No separate implementation summary recorded.")}</p><p class="mono">${escapeHtml(item.result_commit ?? "No commit recorded")}</p></div></section>
    <section class="card"><div class="card-head">Repair</div><div class="card-body">
      <label class="field"><span>Instructions for the repair run…</span><textarea rows="4" data-pr-repair-text placeholder="Instructions for the repair run…">${escapeHtml(item.internal_notes ?? "")}</textarea></label>
      <p><button class="button" type="button" data-pr-save-instructions>Save instructions</button>
      ${button("data-pr-start-repair", "Start repair workflow", canStartRepair, "No linked execution run to repair", " primary")}</p>
      <p style="font-size:12px;color:var(--text3)">Approving merges this pull request on GitHub immediately.</p>
    </div></section>
    <section class="card"><div class="card-head">AI Review history</div><div class="card-body">${aiReviews.length === 0 ? "<p>No AI reviews yet.</p>" : aiReviews.map((r) => `
      <div class="ai-review-entry ai-review-${escapeHtml(r.status)}" style="padding:10px 0;border-bottom:1px solid var(--border)">
        <strong>${escapeHtml(r.status.toUpperCase())}</strong> (${escapeHtml(r.mode)}, ${escapeHtml(r.model)}/${escapeHtml(r.reasoning_level)}) — ${new Date(r.created_at).toLocaleString()}
        <p>${escapeHtml(r.status === "error" ? (r.error_message ?? "Review failed.") : (r.summary ?? "Running…"))}</p>
        ${r.github_comment_url ? `<a href="${escapeHtml(r.github_comment_url)}" target="_blank" rel="noreferrer">View on GitHub</a>` : ""}
      </div>`).join("")}</div></section>`;
  return { status: 200, title: `#${item.number}`, body };
}

export async function render(url: URL, _session: Session, _metrics: Record<string, number>): Promise<PageResult> {
  if (url.pathname === "/admin/pull-requests") {
    const values: any[] = [];
    const conditions: string[] = [];
    const search = url.searchParams.get("search") ?? "";
    if (search) {
      values.push(`%${search}%`);
      conditions.push(`(pr.title ILIKE $${values.length} OR t.ticket_number ILIKE $${values.length})`);
    }
    const repository = url.searchParams.get("repository") ?? "";
    if (repository) { values.push(repository); conditions.push(`pr.repository=$${values.length}`); }
    const tab = url.searchParams.get("tab") ?? "all";
    if (tab === "open") conditions.push("pr.state='open' AND pr.is_draft IS NOT TRUE");
    else if (tab === "draft") conditions.push("pr.is_draft=true");
    else if (tab === "merged") conditions.push("pr.merged_at IS NOT NULL");
    else if (tab === "closed") conditions.push("pr.state='closed' AND pr.merged_at IS NULL");
    const [pullRequests, repositories, lastSynced] = await Promise.all([
      pool.query(
        `SELECT pr.*,p.name project_name,p.slug project_slug,t.ticket_number,t.status ticket_status
         FROM pull_requests pr JOIN projects p ON p.id=pr.project_id
         LEFT JOIN tickets t ON t.id=pr.ticket_id
         ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
         ORDER BY COALESCE(pr.updated_at_provider,pr.updated_at) DESC LIMIT 200`,
        values,
      ),
      pool.query("SELECT DISTINCT repository FROM pull_requests ORDER BY repository"),
      pool.query("SELECT MAX(last_synced_at) synced FROM pull_requests"),
    ]);
    const rows = pullRequests.rows.map((item) => {
      const changes = (item.additions != null || item.deletions != null || item.changed_files != null)
        ? `+${item.additions ?? 0} −${item.deletions ?? 0} · ${item.changed_files ?? 0} files` : "Unknown";
      return `<a class="ticket-row prs-row" href="/admin/pull-requests/${escapeHtml(item.project_slug)}/${item.number}"><span class="mono">#${item.number}</span><strong>${escapeHtml(item.title)}</strong><span>${item.ticket_number ? escapeHtml(item.ticket_number) : `<span style="color:var(--text3)">Not linked</span>`}</span><span>${escapeHtml(item.check_state ?? "Unknown")}</span><span class="status">${escapeHtml(item.review_state ?? item.state)}</span><span class="mono">${escapeHtml(changes)}</span><span>${escapeHtml(item.project_name)}</span><span>${item.merge_conflicts ? `<span class="status danger">Conflicts</span>` : ""}</span><span>${item.created_at_provider ? new Date(item.created_at_provider).toLocaleString() : "—"}</span></a>`;
    }).join("");
    const tabs = [["all", "All"], ["open", "Open"], ["draft", "Draft"], ["merged", "Merged"], ["closed", "Closed"]] as const;
    const withTab = (value: string) => {
      const params = new URLSearchParams(url.search);
      if (value === "all") params.delete("tab"); else params.set("tab", value);
      const query = params.toString();
      return `/admin/pull-requests${query ? `?${query}` : ""}`;
    };
    const tabsNav = `<nav class="tabs" style="margin-top:14px">${tabs.map(([value, label]) =>
      `<a class="button${tab === value ? " primary" : ""}" href="${withTab(value)}">${label}</a>`).join("")}</nav>`;
    const syncedAt = lastSynced.rows[0]?.synced;
    const syncedLabel = syncedAt ? `last ${Math.max(0, Math.round((Date.now() - new Date(syncedAt).getTime()) / 60000))} min ago` : "never synced";
    const body = `<div class="eyebrow">All configured repositories</div><h1>Pull requests</h1>
      <div class="toolbar"><button class="button" type="button" data-sync-prs>Sync all · ${escapeHtml(syncedLabel)}</button></div>
      ${tabsNav}
      <form class="toolbar"><input class="search" name="search" placeholder="Search title, number or ticket…" value="${escapeHtml(search)}">
      <select name="repository"><option value="">All repositories</option>${repositories.rows.map((row) => `<option value="${escapeHtml(row.repository)}"${repository === row.repository ? " selected" : ""}>${escapeHtml(row.repository)}</option>`).join("")}</select>
      ${tab !== "all" ? `<input type="hidden" name="tab" value="${escapeHtml(tab)}">` : ""}
      <button class="button" type="submit">Filter</button><a class="button" href="/admin/pull-requests">Reset</a><span aria-live="polite">${pullRequests.rows.length} shown</span></form>
      <section class="card"><div class="list-head prs-head"><span>PR</span><span>Title</span><span>Ticket</span><span>Checks</span><span>Review</span><span>Changes</span><span>Project</span><span>Conflicts</span><span>Created</span></div>${rows || `<div style="padding:48px 20px;text-align:center;color:var(--text3);font-size:13.5px">No pull requests match these filters.</div>`}</section>`;
    return { status: 200, title: "Pull requests", body };
  }
  const pullRequestSlugMatch = url.pathname.match(/^\/admin\/pull-requests\/([^/]+)\/(\d+)$/);
  if (pullRequestSlugMatch) {
    const item = (await pool.query(`${detailQuery} WHERE p.slug=$1 AND pr.number=$2`, [decodeURIComponent(pullRequestSlugMatch[1]), Number(pullRequestSlugMatch[2])])).rows[0];
    const aiReviews = item ? (await pool.query("SELECT * FROM pr_ai_reviews WHERE pull_request_id=$1 ORDER BY created_at DESC", [item.id])).rows : [];
    return renderDetail(item, aiReviews);
  }
  const pullRequestPageMatch = url.pathname.match(/^\/admin\/pull-requests\/([0-9a-f-]+)$/i);
  if (pullRequestPageMatch) {
    const item = (await pool.query(`${detailQuery} WHERE pr.id=$1`, [pullRequestPageMatch[1]])).rows[0];
    const aiReviews = item ? (await pool.query("SELECT * FROM pr_ai_reviews WHERE pull_request_id=$1 ORDER BY created_at DESC", [item.id])).rows : [];
    return renderDetail(item, aiReviews);
  }
  return null;
}
