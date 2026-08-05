import { escapeHtml, keysetCondition, nextCursor, pageRequest, pagerHtml, pool } from "./shared.ts";
import type { PageResult, Session } from "./shared.ts";

function auditTone(action: string | null): string {
  if (!action) return "muted";
  if (action.includes("failed")) return "danger";
  if (action.includes("revision_requested") || action.includes("locked")) return "warn";
  if (action.includes("succeeded") || action.includes("approved") || action.includes("completed")) return "ok";
  return "info";
}

function formatTime(date: string | Date) {
  const d = new Date(date);
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function actorLabel(event: any): string {
  if (event.actor_type === "admin" && event.actor_id) return "Administrator";
  if (event.actor_type === "anonymous") return "Unknown";
  return event.actor_type || "—";
}

export async function render(url: URL, _session: Session, _metrics: Record<string, number>): Promise<PageResult> {
  if (url.pathname !== "/admin/audit") return null;

  const search = url.searchParams.get("search") ?? "";
  const { limit, cursor } = pageRequest(url);
  const values: any[] = [];
  const conditions: string[] = [];

  if (search) {
    values.push(`%${search}%`);
    const idx = values.length;
    conditions.push(
      `(ae.action ILIKE $${idx} OR ae.entity_type ILIKE $${idx} OR ae.actor_type ILIKE $${idx})`
    );
  }

  const keyset = keysetCondition(cursor, "ae.created_at", "ae.id", values);
  if (keyset) conditions.push(keyset);

  values.push(limit);
  const limitIdx = values.length;

  const [events] = await Promise.all([
    pool.query(
      `SELECT ae.* FROM audit_events ae
       ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
       ORDER BY ae.created_at DESC, ae.id DESC LIMIT $${limitIdx}`,
      values,
    ),
  ]);
  const next = nextCursor(events.rows, limit, "created_at");

  const rows = events.rows.map((event) => {
    const tone = auditTone(event.action);
    return `<div class="ticket-row audit-row">
      <span style="font-size:12px;color:var(--text2)">${escapeHtml(formatTime(event.created_at))}</span>
      <span style="font-size:12px;color:var(--text2)">${escapeHtml(actorLabel(event))}</span>
      <span class="mono" style="font-size:12px;color:var(--t-${tone});font-weight:500">${escapeHtml(event.action)}</span>
      <span style="font-size:12px;color:var(--text2)">${event.entity_type ? escapeHtml(`${event.entity_type}${event.entity_id ? "#" + event.entity_id.slice(0, 8) : ""}`) : "—"}</span>
      <span class="mono" style="font-size:12px;color:var(--text3);text-align:right">${event.ip_address ? escapeHtml(event.ip_address) : "—"}</span>
    </div>`;
  }).join("");

  const body = `<div style="display:flex;align-items:flex-end;justify-content:space-between;gap:18px;flex-wrap:wrap">
      <div><div class="eyebrow">Immutable event record</div><h1>Audit log</h1></div>
    </div>
    <form class="toolbar" style="margin-top:16px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <input type="search" name="search" placeholder="Search action, entity or actor…" value="${escapeHtml(search)}" style="flex:0 1 400px;min-width:180px;padding:9px 12px;font-size:13.5px;border:1px solid var(--border);border-radius:4px;background:var(--bg)">
      <button type="submit" class="button" style="border:1px solid var(--border);background:transparent;color:var(--text2);border-radius:4px;padding:9px 14px;font-size:13px">Search</button>
      <a class="button" href="/admin/audit" style="border:1px solid var(--border);background:transparent;color:var(--text2);border-radius:4px;padding:9px 14px;font-size:13px;text-decoration:none">Reset</a>
      <span style="margin-left:auto;font-size:12px;color:var(--text3);font-variant-numeric:tabular-nums">${events.rows.length} shown</span>
    </form>
    <section class="card">
      <div class="list-head audit-head">
        <span style="font-size:10px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--text3)">When</span>
        <span style="font-size:10px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--text3)">Actor</span>
        <span style="font-size:10px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--text3)">Action</span>
        <span style="font-size:10px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--text3)">Entity</span>
        <span style="font-size:10px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--text3);text-align:right">IP</span>
      </div>
      ${rows || `<div style="padding:48px 20px;text-align:center;color:var(--text3);font-size:13.5px"><p>No audit events match your search.</p></div>`}
    </section>
    ${pagerHtml(url, next)}`;
  return { status: 200, title: "Audit log", body };
}
