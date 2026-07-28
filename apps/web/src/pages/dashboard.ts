import { escapeHtml, pool, shortRef } from "./shared.ts";
import type { PageResult, Session } from "./shared.ts";

function since(date: string | Date) {
  const minutes = Math.round(Math.abs(Date.now() - new Date(date).getTime()) / 60000);
  return minutes < 60 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
}

function kpiTile(label: string, value: number, detail: string, tone: string, href: string) {
  return `<a href="${escapeHtml(href)}" style="display:grid;grid-template-rows:auto 1fr auto;gap:12px;padding:18px;background:var(--surface);border:1px solid var(--border);border-radius:6px;text-decoration:none;color:inherit;cursor:pointer;transition:all .2s ease;outline:2px solid transparent;outline-offset:-2px" onmouseover="this.style.borderColor='var(--border2)';this.style.background='var(--surface2)'" onmouseout="this.style.borderColor='var(--border)';this.style.background='var(--surface)'">
    <div style="font-size:13px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--text2)">${escapeHtml(label)}</div>
    <div style="font-family:'Cormorant Garamond',serif;font-size:38px;font-weight:700;color:var(--t-${tone})">${escapeHtml(String(value))}</div>
    <div style="font-size:12px;color:var(--text3)">${escapeHtml(detail)}</div>
  </a>`;
}

function waitingRow(ticketNum: string, title: string, meta: string, pillLabel: string, pillTone: string, href: string) {
  return `<a href="${escapeHtml(href)}" style="display:grid;grid-template-columns:80px 1fr auto;gap:16px;align-items:center;padding:13px 18px;border-bottom:1px solid var(--border);text-decoration:none;color:inherit;cursor:pointer" onmouseover="this.style.background='var(--surface2)'" onmouseout="this.style.background='transparent'">
    <div style="font-family:'JetBrains Mono',monospace;font-size:12px;font-weight:600">${escapeHtml(ticketNum)}</div>
    <div>
      <div style="font-size:13px;font-weight:500">${escapeHtml(title)}</div>
      <div style="font-size:12px;color:var(--text3);margin-top:3px">${escapeHtml(meta)}</div>
    </div>
    <span style="font-size:11.5px;font-weight:600;color:var(--t-${pillTone});background:var(--s-${pillTone});padding:3px 9px;border-radius:3px;white-space:nowrap">${escapeHtml(pillLabel)}</span>
  </a>`;
}

function runRow(runId: string, type: string, ticketNum: string, model: string, effort: string, turns: number, maxTurns: number, elapsed: string) {
  const pct = Math.round((turns / maxTurns) * 100);
  return `<div style="display:grid;grid-template-rows:auto auto;gap:10px;padding:13px 18px;border-bottom:1px solid var(--border)">
    <div style="display:flex;align-items:center;gap:10px">
      <span style="width:6px;height:6px;border-radius:50%;background:var(--t-run);animation:dccPulse 1.4s ease-in-out infinite;flex-shrink:0"></span>
      <span style="font-family:'JetBrains Mono',monospace;font-size:12px;font-weight:600">${escapeHtml(runId)}</span>
      <span style="font-size:12px;color:var(--text3)">${escapeHtml(type)}</span>
      <span style="font-size:12px;color:var(--text3)">${escapeHtml(ticketNum)}</span>
    </div>
    <div style="display:grid;grid-template-columns:1fr auto;gap:12px;align-items:center">
      <div style="height:3px;background:var(--surface2);border-radius:99px;overflow:hidden">
        <div style="width:${pct}%;height:100%;background:var(--t-run)"></div>
      </div>
      <div style="font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--text3);white-space:nowrap">${escapeHtml(model)} · turn ${turns}/${maxTurns} · ${escapeHtml(elapsed)}</div>
    </div>
  </div>`;
}

function healthRow(label: string, value: string, tone: string) {
  return `<div style="display:flex;justify-content:space-between;gap:10px;padding:7px 15px;font-size:12.5px;border-bottom:1px solid var(--border)">
    <span style="color:var(--text3)">${escapeHtml(label)}</span>
    <span style="color:var(--t-${tone});font-weight:600">${escapeHtml(value)}</span>
  </div>`;
}

function blockedRow(title: string, detail: string, tone: string) {
  return `<div style="padding:13px 18px;border-bottom:1px solid var(--border);border-left:3px solid var(--t-${tone})">
    <div style="font-size:13px;font-weight:500">${escapeHtml(title)}</div>
    <div style="font-size:12px;color:var(--text3);margin-top:3px">${escapeHtml(detail)}</div>
  </div>`;
}

export async function render(url: URL, _session: Session, _metrics: Record<string, number>): Promise<PageResult> {
  if (url.pathname !== "/admin") return null;

  const [awaiting, plansReview, activeRuns, prsReview, failedJobs, waitingTickets, runningRuns, healthData, dirtyProjects, failedDeliveries] = await Promise.all([
    pool.query("SELECT count(*)::int c FROM tickets WHERE status IN ('Submitted','Triage')"),
    pool.query("SELECT count(*)::int c FROM tickets WHERE status = 'Plan Ready for Review'"),
    pool.query("SELECT count(*)::int c FROM agent_runs WHERE status = 'running'"),
    pool.query("SELECT count(*)::int c FROM pull_requests WHERE state='open'"),
    pool.query("SELECT count(*)::int c FROM jobs WHERE status = 'failed'"),
    pool.query(`SELECT t.ticket_number, t.title, t.status, t.priority, t.updated_at FROM tickets t
      WHERE t.status IN ('Submitted','Triage','Plan Ready for Review','Validation Failed')
      ORDER BY t.updated_at DESC LIMIT 8`),
    pool.query(`SELECT ar.id, ar.run_type, t.ticket_number, ar.model, ar.reasoning_level effort,
      (ar.metadata_json->>'turn')::int turn, (ar.metadata_json->>'max_turns')::int max_turns,
      CASE WHEN ar.finished_at IS NOT NULL THEN (EXTRACT(EPOCH FROM (ar.finished_at - ar.started_at)))::int
           ELSE (EXTRACT(EPOCH FROM (now() - ar.started_at)))::int END elapsed_secs
      FROM agent_runs ar JOIN tickets t ON t.id = ar.ticket_id
      WHERE ar.status = 'running' LIMIT 10`),
    pool.query(`SELECT
      (SELECT bool_or(CLAUDE_CODE_OAUTH_TOKEN IS NOT NULL) FROM (SELECT current_setting('$user') CLAUDE_CODE_OAUTH_TOKEN) x) auth,
      (SELECT MAX(claimed_at) FROM jobs WHERE claimed_at IS NOT NULL) heartbeat,
      (SELECT count(*)::int FROM projects WHERE health_status = 'repository_dirty') dirty_projects`),
    pool.query("SELECT slug, name FROM projects WHERE health_status = 'repository_dirty' LIMIT 5"),
    pool.query("SELECT count(*)::int c FROM notification_deliveries WHERE status = 'failed'"),
  ]);

  const awaitingCount = awaiting.rows[0]?.c ?? 0;
  const plansCount = plansReview.rows[0]?.c ?? 0;
  const runsCount = activeRuns.rows[0]?.c ?? 0;
  const prsCount = prsReview.rows[0]?.c ?? 0;
  const jobsCount = failedJobs.rows[0]?.c ?? 0;
  const totalNeedAttention = awaitingCount + plansCount + runsCount + prsCount + jobsCount;
  const needsPlural = totalNeedAttention === 1 ? "thing" : "things";

  const hb = healthData.rows[0]?.heartbeat;
  const hbFresh = hb && Date.now() - new Date(hb).getTime() < 5 * 60_000;

  // Format elapsed time
  const formatElapsed = (secs: number) => {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  };

  const waitingRows = waitingTickets.rows.map((row) => {
    let pillLabel = "Triage";
    let pillTone = "info";
    let href = `/admin/tickets/${escapeHtml(row.ticket_number)}`;

    if (row.status === "Plan Ready for Review") {
      pillLabel = "Review plan";
      pillTone = "warn";
      href = `/admin/tickets/${escapeHtml(row.ticket_number)}/plans`;
    } else if (row.status === "Validation Failed") {
      pillLabel = "Repair";
      pillTone = "danger";
      href = `/admin/tickets/${escapeHtml(row.ticket_number)}`;
    }

    const meta = row.status === "Submitted" || row.status === "Triage"
      ? `Updated ${since(row.updated_at)} ago · ${row.priority}`
      : `${row.status} · ${row.priority}`;

    return waitingRow(row.ticket_number, row.title, meta, pillLabel, pillTone, href);
  }).join("");

  const runRows = runningRuns.rows.map((row) => {
    const elapsed = formatElapsed(row.elapsed_secs || 0);
    return runRow(
      shortRef("RUN", row.id),
      row.run_type,
      row.ticket_number,
      row.model,
      row.effort,
      row.turn || 0,
      row.max_turns || 1,
      elapsed
    );
  }).join("");

  const healthRows = [
    healthRow("Claude Code", "subscription auth", "ok"),
    healthRow("Worker", hb ? `${since(hb)} ago` : "no worker", hbFresh ? "ok" : "warn"),
    healthRow("Project health", `${healthData.rows[0]?.dirty_projects || 0} blocked`, healthData.rows[0]?.dirty_projects > 0 ? "danger" : "ok"),
    healthRow("Failed deliveries", `${failedDeliveries.rows[0]?.c || 0}`, failedDeliveries.rows[0]?.c > 0 ? "warn" : "ok"),
  ].join("");

  const blockedRows = dirtyProjects.rows.length
    ? dirtyProjects.rows.map((p) => blockedRow(`${p.name} repository is dirty`, "Uncommitted changes block planning and execution", "warn")).join("")
    : "";

  const dateStr = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });

  const body = `
    <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:18px;flex-wrap:wrap">
      <div>
        <div style="font-size:10px;font-weight:700;letter-spacing:.2em;text-transform:uppercase;color:var(--text3);margin-bottom:6px">${escapeHtml(dateStr)}</div>
        <h1>${escapeHtml(totalNeedAttention)} ${escapeHtml(needsPlural)} need you.</h1>
      </div>
      <div style="display:flex;gap:8px">
        <a class="button" href="/admin/queue" style="border:1px solid var(--border);background:transparent;color:var(--text2);border-radius:4px;padding:9px 14px;font-size:13px;text-decoration:none;cursor:pointer" onmouseover="this.style.borderColor='var(--border2)';this.style.color='var(--text)'" onmouseout="this.style.borderColor='var(--border)';this.style.color='var(--text2)'">Job queue</a>
        <a class="button" href="/admin/tickets?status=Triage" style="border:0;background:var(--accent);color:var(--accent-fg);border-radius:4px;padding:9px 16px;font-size:13px;font-weight:600;text-decoration:none;cursor:pointer" onmouseover="this.style.filter='brightness(1.08)'" onmouseout="this.style.filter='brightness(1)'" >Open triage</a>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(168px,1fr));gap:1px;background:var(--border);margin-top:18px;border-radius:6px;overflow:hidden">
      ${kpiTile("Awaiting triage", awaitingCount, "", "text", "/admin/tickets?status=Triage")}
      ${kpiTile("Plans to review", plansCount, "", "warn", "/admin/tickets?status=Plan%20Ready%20for%20Review")}
      ${kpiTile("Active runs", runsCount, "", "run", "/admin/runs")}
      ${kpiTile("PRs to review", prsCount, "", "text", "/admin/prs")}
      ${kpiTile("Failed jobs", jobsCount, "", "danger", "/admin/queue")}
    </div>

    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:22px;margin-top:22px">
      <section class="card" style="margin-top:0">
        <div class="card-head">Waiting on your decision</div>
        ${waitingRows ? `<div style="max-height:400px;overflow-y:auto">${waitingRows}</div>` : `<div style="padding:20px 18px;color:var(--text3);font-size:13px">No tickets waiting for your decision.</div>`}
      </section>

      <section class="card" style="margin-top:0">
        <div style="padding:13px 18px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
          <div style="font-size:11.5px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--text2)">Active Claude runs</div>
          <a href="/admin/runs" style="font-size:12px;color:var(--accent);text-decoration:none" onmouseover="this.style.textDecoration='underline'" onmouseout="this.style.textDecoration='none'">All runs →</a>
        </div>
        ${runRows ? `<div style="max-height:400px;overflow-y:auto">${runRows}</div>` : `<div style="padding:20px 18px;color:var(--text3);font-size:13px">No active runs.</div>`}
      </section>

      <section class="card" style="margin-top:0">
        <div style="padding:13px 18px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between">
          <div style="font-size:11.5px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--text2)">System health</div>
          <a href="/admin/system" style="font-size:12px;color:var(--accent);text-decoration:none" onmouseover="this.style.textDecoration='underline'" onmouseout="this.style.textDecoration='none'">Details →</a>
        </div>
        ${healthRows}
      </section>

      ${blockedRows ? `<section class="card" style="margin-top:0">
        <div class="card-head">Blocked</div>
        ${blockedRows}
      </section>` : ''}
    </div>
  `;

  return { status: 200, title: "Dashboard", body };
}
