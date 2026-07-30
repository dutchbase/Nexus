import { escapeHtml, pool, shortRef } from "./shared.ts";
import type { PageResult, Session } from "./shared.ts";

const cap = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

// Coarse relative-duration label ("14 min" / "3 h") — minutes below an hour,
// hours above. Direction (ago/in) is added by the caller.
function since(date: string | Date) {
  const minutes = Math.round(Math.abs(Date.now() - new Date(date).getTime()) / 60000);
  return minutes < 60 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
}

function availability(job: any) {
  if (job.status === "completed") return job.completed_at ? `${since(job.completed_at)} ago` : "—";
  if (job.status === "failed") {
    if (job.attempt >= job.max_attempts) return "—";
    if (job.available_at && new Date(job.available_at) > new Date()) return `retry in ${since(job.available_at)}`;
    return "retry pending";
  }
  if (job.status === "running") return job.claimed_at ? `${since(job.claimed_at)} ago` : "—";
  if (job.available_at && new Date(job.available_at) > new Date()) return `in ${since(job.available_at)}`;
  return "ready";
}

export async function render(url: URL, _session: Session, _metrics: Record<string, number>): Promise<PageResult> {
  if (url.pathname !== "/admin/queue") return null;

  const status = url.searchParams.get("status") ?? "";
  const type = url.searchParams.get("type") ?? "";
  const values: any[] = [];
  const conditions: string[] = [];
  if (status) { values.push(status); conditions.push(`j.status=$${values.length}`); } else { conditions.push(`j.status != 'completed'`); }
  if (type) { values.push(type); conditions.push(`j.type=$${values.length}`); }

  const [jobs, statuses, types, depth, heartbeat] = await Promise.all([
    pool.query(
      `SELECT j.*,COALESCE(t.ticket_number,j.payload_json->>'ticket') ticket_label,p.name project_name
       FROM jobs j
       LEFT JOIN tickets t ON t.id::text=j.payload_json->>'ticket_id' OR t.ticket_number=j.payload_json->>'ticket'
       LEFT JOIN projects p ON p.id=t.project_id
       ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
       ORDER BY j.created_at DESC LIMIT 200`,
      values,
    ),
    pool.query("SELECT DISTINCT status FROM jobs ORDER BY status"),
    pool.query("SELECT DISTINCT type FROM jobs ORDER BY type"),
    pool.query("SELECT status,count(*)::int c FROM jobs GROUP BY status"),
    pool.query("SELECT MAX(claimed_at) hb FROM jobs"),
  ]);

  const depthByStatus = new Map(depth.rows.map((row) => [row.status, row.c]));
  const depthLabel = depth.rows.length
    ? depth.rows.map((row) => `${row.c} ${row.status}`).join(" · ")
    : "0 jobs";
  const hb = heartbeat.rows[0]?.hb;
  const hbFresh = hb && Date.now() - new Date(hb).getTime() < 5 * 60_000;
  const heartbeatLabel = hb ? `${since(hb)} ago` : "no recent activity";

  const rows = jobs.rows.map((job) => `<div class="ticket-row queue-row">
      <span class="mono">${shortRef("JOB", job.id)}</span>
      <span class="mono">${escapeHtml(job.type)}</span>
      <span>${job.ticket_label ? escapeHtml(job.ticket_label) : `<span style="color:var(--text3)">—</span>`}${job.project_name ? ` · ${escapeHtml(job.project_name)}` : ""}</span>
      <span>${escapeHtml(cap(job.priority))}</span>
      <span class="mono">${job.attempt} / ${job.max_attempts}</span>
      <span class="status">${escapeHtml(cap(job.status))}</span>
      <span style="text-align:right">${escapeHtml(availability(job))}</span>
    </div>`).join("");

  const body = `<div style="display:flex;align-items:flex-end;justify-content:space-between;gap:18px;flex-wrap:wrap">
      <div><div class="eyebrow">Work · PostgreSQL queue</div><h1>Job queue</h1></div>
      <div style="display:flex;gap:14px;flex-wrap:wrap">
        <div><div class="eyebrow">Queue depth</div><div style="font-size:13px;color:var(--text2);margin-top:3px">${escapeHtml(depthLabel)}</div></div>
        <div><div class="eyebrow">Claude concurrency</div><div style="font-size:13px;color:var(--text2);margin-top:3px">1 global · 1 per project</div></div>
        <div><div class="eyebrow">Worker heartbeat</div><div style="font-size:13px;color:${hbFresh ? "var(--t-ok)" : "var(--text3)"};margin-top:3px">${escapeHtml(heartbeatLabel)}</div></div>
      </div>
    </div>
    <form class="toolbar" style="margin-top:16px">
      <select name="status" onchange="this.form.submit()"><option value="">All statuses</option>${statuses.rows.map((row) => `<option value="${escapeHtml(row.status)}"${status === row.status ? " selected" : ""}>${escapeHtml(cap(row.status))}</option>`).join("")}</select>
      <select name="type" onchange="this.form.submit()"><option value="">All types</option>${types.rows.map((row) => `<option value="${escapeHtml(row.type)}"${type === row.type ? " selected" : ""}>${escapeHtml(row.type)}</option>`).join("")}</select>
      <a class="button" href="/admin/queue">Reset</a><span aria-live="polite">${jobs.rows.length} shown</span>
    </form>
    <section class="card"><div class="list-head queue-head"><span>Job</span><span>Type</span><span>Ticket · project</span><span>Priority</span><span>Attempt</span><span>Status</span><span style="text-align:right">Available</span></div>${rows || `<div style="padding:48px 20px;text-align:center;color:var(--text3);font-size:13.5px">${status || type ? "No jobs match these filters." : "The queue is empty."}</div>`}</section>`;
  return { status: 200, title: "Job queue", body };
}
