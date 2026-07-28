import { escapeHtml, pool, shortRef, shortRefs } from "./shared.ts";
import type { PageResult, Session } from "./shared.ts";

export async function render(url: URL, _session: Session, _metrics: Record<string, number>): Promise<PageResult> {
  if (url.pathname === "/admin/runs") {
    const runs = (await pool.query(
      `SELECT ar.*,t.ticket_number,p.name project_name FROM agent_runs ar
       LEFT JOIN tickets t ON t.id=ar.ticket_id LEFT JOIN projects p ON p.id=ar.project_id
       ORDER BY ar.started_at DESC NULLS LAST LIMIT 200`,
    )).rows;
    const runLabels = shortRefs("RUN", runs);
    const rows = runs.map((run) =>
      `<a class="ticket-row" href="/admin/runs/${run.id}"><span class="mono">${runLabels.get(run.id)}</span><strong>${escapeHtml(run.run_type)}</strong><span>${escapeHtml(run.ticket_number ?? "")} · ${escapeHtml(run.project_name ?? "")}</span><span>${escapeHtml(run.model)} · ${escapeHtml(run.reasoning_level)}</span><span class="status">${escapeHtml(run.status)}</span><time>${run.started_at ? new Date(run.started_at).toLocaleString("nl-NL") : ""}</time></a>`,
    ).join("");
    const body = `<div class="eyebrow">Work</div><h1>Runs</h1><section class="card"><div class="list-head"><span>Run</span><span>Type</span><span>Ticket</span><span>AI</span><span>Status</span><span>Started</span></div>${rows || '<div class="card-body"><p>No runs recorded.</p></div>'}</section>`;
    return { status: 200, title: "Runs", body };
  }
  const runPageMatch = url.pathname.match(/^\/admin\/runs\/([0-9a-f-]+)$/i);
  if (runPageMatch) {
    const run = (await pool.query(
      `SELECT ar.*,t.ticket_number,p.name project_name FROM agent_runs ar
       LEFT JOIN tickets t ON t.id=ar.ticket_id LEFT JOIN projects p ON p.id=ar.project_id WHERE ar.id=$1`,
      [runPageMatch[1]],
    )).rows[0];
    if (!run) return { status: 404, title: "Run not found", body: "<h1>Run not found</h1>" };
    const meta = run.metadata_json ?? {};
    const statusLine = run.status === "timed_out"
      ? `Timed out at ${escapeHtml(meta.turn ?? "?")}/${escapeHtml(meta.max_turns ?? "?")} turns`
      : `${escapeHtml(run.status)}${meta.turn != null ? ` · turn ${escapeHtml(meta.turn)}/${escapeHtml(meta.max_turns ?? "?")}` : ""}`;
    const body = `<div class="eyebrow">${escapeHtml(run.ticket_number ?? "")} · ${escapeHtml(run.project_name ?? "")}</div>
      <h1>${shortRef("RUN", run.id)} · ${escapeHtml(run.run_type)}</h1>
      <p><span class="status">${escapeHtml(run.status)}</span> ${statusLine}</p>
      <section class="card"><div class="card-head">Run snapshot</div><div class="card-body"><dl>
        <dt>Model</dt><dd>${escapeHtml(run.model)} · ${escapeHtml(run.reasoning_level)}</dd>
        <dt>Session</dt><dd class="mono">${escapeHtml(run.claude_session_id ?? "")}</dd>
        <dt>Working directory</dt><dd class="mono">${escapeHtml(run.working_directory ?? "")}</dd>
        <dt>Started</dt><dd>${run.started_at ? new Date(run.started_at).toLocaleString("nl-NL") : "Not started"}</dd>
        <dt>Finished</dt><dd>${run.finished_at ? new Date(run.finished_at).toLocaleString("nl-NL") : "Running"}</dd>
      </dl>${run.error_message ? `<p class="error">${escapeHtml(run.error_code ?? "")}: ${escapeHtml(run.error_message)}</p>` : ""}</div></section>`;
    return { status: 200, title: "Run detail", body };
  }
  return null;
}
