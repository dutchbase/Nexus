import { escapeHtml, pool, renderMarkdown } from "./shared.ts";
import type { PageResult, Session } from "./shared.ts";

export async function render(url: URL, _session: Session, _metrics: Record<string, number>): Promise<PageResult> {
  if (url.pathname === "/admin/pull-requests") {
    const values: any[] = [];
    const conditions: string[] = [];
    const search = url.searchParams.get("search") ?? "";
    if (search) {
      values.push(`%${search}%`);
      conditions.push(`(pr.title ILIKE $${values.length} OR t.ticket_number ILIKE $${values.length})`);
    }
    const state = url.searchParams.get("state") ?? "";
    if (state) { values.push(state); conditions.push(`pr.state=$${values.length}`); }
    const pullRequests = (await pool.query(
      `SELECT pr.*,p.name project_name,t.ticket_number,t.status ticket_status
       FROM pull_requests pr JOIN projects p ON p.id=pr.project_id
       LEFT JOIN tickets t ON t.id=pr.ticket_id
       ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
       ORDER BY COALESCE(pr.updated_at_provider,pr.updated_at) DESC LIMIT 200`,
      values,
    )).rows;
    const rows = pullRequests.map((item) =>
      `<a class="ticket-row" href="/admin/pull-requests/${item.id}"><span class="mono">#${item.number}</span><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.project_name)}</span><span>${escapeHtml(item.repository)}</span><span class="status">${escapeHtml(item.review_state ?? item.state)}</span><time>${new Date(item.updated_at_provider ?? item.updated_at).toLocaleDateString("nl-NL")}</time></a>`,
    ).join("");
    const body = `<div class="eyebrow">Work</div><h1>Pull requests</h1>
      <form class="toolbar"><input class="search" name="search" placeholder="Search title or ticket" value="${escapeHtml(search)}">
      <select name="state"><option value="">All states</option><option value="open"${state === "open" ? " selected" : ""}>Open</option><option value="closed"${state === "closed" ? " selected" : ""}>Closed</option></select>
      <button class="button" type="submit">Filter</button><a class="button" href="/admin/pull-requests">Reset</a></form>
      <section class="card"><div class="list-head"><span>PR</span><span>Title</span><span>Project</span><span>Repository</span><span>Review</span><span>Updated</span></div>${rows || "<p>No pull requests found.</p>"}</section>`;
    return { status: 200, title: "Pull requests", body };
  }
  const pullRequestPageMatch = url.pathname.match(/^\/admin\/pull-requests\/([0-9a-f-]+)$/i);
  if (pullRequestPageMatch) {
    const item = (await pool.query(
      `SELECT pr.*,p.name project_name,t.ticket_number,t.title ticket_title,t.status ticket_status,
              pv.content_markdown approved_plan,ar.metadata_json,ea.result_commit
       FROM pull_requests pr JOIN projects p ON p.id=pr.project_id
       LEFT JOIN tickets t ON t.id=pr.ticket_id
       LEFT JOIN plan_versions pv ON pv.id=t.approved_plan_version_id
       LEFT JOIN execution_attempts ea ON ea.id=pr.execution_attempt_id
       LEFT JOIN agent_runs ar ON ar.id=ea.agent_run_id WHERE pr.id=$1`,
      [pullRequestPageMatch[1]],
    )).rows[0];
    if (!item) return { status: 404, title: "Pull request not found", body: "<h1>Pull request not found</h1>" };
    const validation = item.metadata_json?.validation_output ?? {};
    const body = `<div class="eyebrow">${escapeHtml(item.project_name)} · ${escapeHtml(item.repository)}</div>
      <h1>#${item.number} ${escapeHtml(item.title)}</h1>
      <p><span class="status">${escapeHtml(item.state)}</span> <span class="status">${escapeHtml(item.review_state ?? "Review pending")}</span>
      <a class="button primary" href="${escapeHtml(item.url)}">Open on GitHub</a></p>
      <div class="grid two"><section class="card"><div class="card-head">Metadata</div><div class="card-body"><dl>
      <dt>Ticket</dt><dd>${item.ticket_number ? `<a href="/admin/tickets/${escapeHtml(item.ticket_number)}">${escapeHtml(item.ticket_number)} · ${escapeHtml(item.ticket_title)}</a> (${escapeHtml(item.ticket_status)})` : "Unlinked"}</dd>
      <dt>Author</dt><dd>${escapeHtml(item.author)}</dd><dt>Branches</dt><dd>${escapeHtml(item.head_branch)} → ${escapeHtml(item.base_branch)}</dd>
      <dt>Checks</dt><dd>${escapeHtml(item.check_state ?? "Unknown")}</dd><dt>Internal review</dt><dd>${escapeHtml(item.internal_review_state ?? "Not reviewed")}</dd></dl></div></section>
      <section class="card"><div class="card-head">Changed files & validation</div><div class="card-body"><pre>${escapeHtml(JSON.stringify({ changed_files: validation.changed_files ?? [], results: validation.results ?? [] }, null, 2))}</pre></div></section></div>
      <section class="card"><div class="card-head">Approved plan</div><div class="card-body">${item.approved_plan ? renderMarkdown(item.approved_plan) : "<p>No approved plan linked.</p>"}</div></section>
      <section class="card"><div class="card-head">Implementation & commits</div><div class="card-body"><p>${escapeHtml(item.metadata_json?.implementation_summary ?? "No separate implementation summary recorded.")}</p><p class="mono">${escapeHtml(item.result_commit ?? "No commit recorded")}</p></div></section>
      <section class="card"><div class="card-head">Internal notes</div><div class="card-body"><p>${escapeHtml(item.internal_notes ?? "No internal notes.")}</p></div></section>`;
    return { status: 200, title: `PR #${item.number}`, body };
  }
  return null;
}
