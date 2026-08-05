import { escapeHtml, pool, runProgress, shortRef, shortRefs } from "./shared.ts";
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
      `<a class="ticket-row runs-row" href="/admin/runs/${run.id}"><span class="mono">${runLabels.get(run.id)}</span><strong>${escapeHtml(run.run_type)}</strong><span>${escapeHtml(run.ticket_number ?? "")} · ${escapeHtml(run.project_name ?? "")}</span><span>${escapeHtml(run.model)} · ${escapeHtml(run.reasoning_level)}</span><span class="status">${escapeHtml(run.status)}</span><time>${run.started_at ? new Date(run.started_at).toLocaleString("nl-NL") : ""}</time></a>`,
    ).join("");
    const body = `<div class="eyebrow">Work</div><h1>Runs</h1><section class="card"><div class="list-head runs-head"><span>Run</span><span>Type</span><span>Ticket</span><span>AI</span><span>Status</span><span>Started</span></div>${rows || `<div style="padding:48px 20px;text-align:center;color:var(--text3);font-size:13.5px">No runs recorded.</div>`}</section>`;
    return { status: 200, title: "Runs", body };
  }
  const runPageMatch = url.pathname.match(/^\/admin\/runs\/([0-9a-f-]+)$/i);
  if (runPageMatch) {
    const run = (await pool.query(
      `SELECT ar.*,t.ticket_number,t.status ticket_status,p.name project_name FROM agent_runs ar
       LEFT JOIN tickets t ON t.id=ar.ticket_id LEFT JOIN projects p ON p.id=ar.project_id WHERE ar.id=$1`,
      [runPageMatch[1]],
    )).rows[0];
    if (!run) return { status: 404, title: "Run not found", body: "<h1>Run not found</h1>" };
    // PRD G10-F04: a repair opens a new execution_attempts row (and its own
    // agent_runs row) rather than overwriting the one it repairs, so a prior
    // attempt's execution log is never hidden or deleted — surface every
    // attempt's log for this ticket here, each linking to its own run's
    // existing /api/admin/runs/:id/log route via ea.agent_run_id.
    const attemptLogs = run.ticket_id ? (await pool.query(
      `SELECT a.id, a.execution_attempt_id, ea.attempt_number, ea.agent_run_id, a.status, a.created_at
       FROM artifacts a JOIN execution_attempts ea ON ea.id = a.execution_attempt_id
       WHERE a.artifact_type='execution_log' AND ea.ticket_id = $1 ORDER BY ea.attempt_number DESC`,
      [run.ticket_id],
    )).rows : [];
    const meta = run.metadata_json ?? {};
    const isActive = ["running", "queued"].includes(run.status);
    const canCancel = ["running", "cancellation_requested"].includes(run.status);
    const canRepair = run.error_code === "validation_failed";
    const canRetry = run.ticket_status === "PR Creation Failed";
    const progress = isActive ? runProgress({ phase: run.phase, heartbeat_at: run.heartbeat_at, turn: meta.turn ?? null, max_turns: meta.max_turns ?? null }) : null;
    const statusLine = (run.status === "timed_out"
      ? `Timed out at ${escapeHtml(meta.turn ?? "?")}/${escapeHtml(meta.max_turns ?? "?")} turns`
      : `${escapeHtml(run.status)}${meta.turn != null ? ` · turn ${escapeHtml(meta.turn)}/${escapeHtml(meta.max_turns ?? "?")}` : ""}`)
      + (progress ? ` · ${escapeHtml(progress.label)}` : "");
    const body = `<div class="eyebrow">${escapeHtml(run.ticket_number ?? "")} · ${escapeHtml(run.project_name ?? "")}</div>
      <h1>${shortRef("RUN", run.id)} · ${escapeHtml(run.run_type)}</h1>
      <div style="display:flex;gap:12px;align-items:center;margin-bottom:20px">
        <span class="status">${escapeHtml(run.status)}</span>
        <span>${statusLine}</span>
        <a href="/api/admin/runs/${run.id}/log" class="button secondary" download>Download logs</a>
        <button data-run-cancel data-run-id="${run.id}" class="button secondary" style="color:var(--t-danger);border-color:var(--t-danger)" ${!canCancel ? `disabled title="Run is not active"` : ""}>Cancel run</button>
        <button data-run-repair data-run-id="${run.id}" class="button secondary" ${!canRepair ? `disabled title="Run validation did not fail"` : ""}>Repair</button>
        <button data-run-retry data-run-id="${run.id}" class="button secondary" ${!canRetry ? `disabled title="PR creation did not fail"` : ""}>Retry</button>
      </div>
      ${isActive ? `<div data-run-stream id="run-stream" style="background:var(--code-bg);border:1px solid var(--border);border-radius:6px;padding:12px;font-family:'JetBrains Mono',monospace;font-size:12px;max-height:560px;overflow:auto;color:var(--text2);white-space:pre-wrap;word-break:break-word"></div>` : ""}
      <section class="card"><div class="card-head">Run snapshot</div><div class="card-body"><dl>
        <dt>Model</dt><dd>${escapeHtml(run.model)} · ${escapeHtml(run.reasoning_level)}</dd>
        <dt>Session</dt><dd class="mono">${escapeHtml(run.claude_session_id ?? "")}</dd>
        <dt>Working directory</dt><dd class="mono">${escapeHtml(run.working_directory ?? "")}</dd>
        <dt>Started</dt><dd>${run.started_at ? new Date(run.started_at).toLocaleString("nl-NL") : "Not started"}</dd>
        <dt>Finished</dt><dd>${run.finished_at ? new Date(run.finished_at).toLocaleString("nl-NL") : "Running"}</dd>
      </dl>${run.error_message ? `<p class="error">${escapeHtml(run.error_code ?? "")}: ${escapeHtml(run.error_message)}</p>` : ""}</div></section>
      <section class="card"><div class="card-head">Attempt logs</div>${attemptLogs.length ? attemptLogs.map((log) =>
        `<a class="ticket-row" href="/api/admin/runs/${log.agent_run_id}/log" download><span class="mono">Attempt ${log.attempt_number}</span><span class="status">${escapeHtml(log.status)}</span><time>${new Date(log.created_at).toLocaleString("nl-NL")}</time></a>`,
      ).join("") : '<div class="card-body"><p>No attempt logs recorded.</p></div>'}</section>
      <dialog data-repair-dialog style="border:none;border-radius:8px;box-shadow:var(--shadow);width:100%;max-width:660px">
        <div style="padding:20px;border-bottom:1px solid var(--border)"><h2 style="font-size:16px;font-weight:600;margin:0">Repair with instructions</h2></div>
        <div style="padding:20px"><label style="display:flex;flex-direction:column;gap:8px"><span style="font-size:11.5px;font-weight:600;color:var(--text2)">Instructions</span><textarea name="feedback" data-repair-feedback style="border:1px solid var(--border);background:var(--bg);border-radius:4px;padding:9px 11px;font-size:13px;font-family:monospace;resize:vertical;min-height:120px" required></textarea></label></div>
        <div style="padding:20px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px"><button data-close-dialog class="button secondary">Cancel</button><button data-submit-repair class="button primary">Start repair</button></div>
      </dialog>`;
    return { status: 200, title: shortRef("RUN", run.id), body };
  }
  return null;
}
