import { statfsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { artifactDataRoot } from "../../../../packages/database/src/artifacts.ts";
import { escapeHtml, pool, shortRef, workerHealth } from "./shared.ts";
import type { PageResult, Session } from "./shared.ts";
import { aiModels, reasoningLevels } from "@dcc/domain";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
// Coarse relative-duration label — same rule as queue.ts (minutes below an
// hour, hours above); duplicated because these are the only two callers.
function since(date: string | Date) {
  const minutes = Math.round(Math.abs(Date.now() - new Date(date).getTime()) / 60000);
  return minutes < 60 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
}

// host/db name only — DATABASE_URL's credentials never reach the page.
function maskedDatabaseUrl() {
  const raw = process.env.DATABASE_URL;
  if (!raw) return "not configured";
  try {
    const parsed = new URL(raw);
    return `postgres://${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}${parsed.pathname}`;
  } catch {
    return "configured (unparsable)";
  }
}

export function capabilityLabel(row: { status: string; can_read: boolean; can_write: boolean; reason: string | null; checked_at: string | Date } | null): string {
  if (!row) return "never checked";
  const checked = `checked ${since(row.checked_at)} ago`;
  if (row.status === "ok" && row.can_read && row.can_write) return `read + write · ${checked}`;
  if (row.status === "ok" && row.can_read) return `read only · ${checked}`;
  return row.reason ? `${row.status} · ${row.reason} · ${checked}` : `${row.status} · ${checked}`;
}

function settingsBody(aiReviewSettings: any, cap: { status: string; can_read: boolean; can_write: boolean; reason: string | null; checked_at: string | Date } | null, systemAiSettings: any): string {
  const panel = (index: number, content: string) => `<div role="tabpanel" id="panel-${index}" aria-labelledby="tab-${index}"${index === 0 ? "" : " hidden"}>${content}</div>`;
  const field = (label: string, value: string) => `<div style="padding:10px 0;border-bottom:1px solid var(--border)"><div class="eyebrow">${escapeHtml(label)}</div><div class="mono" style="font-size:13px;margin-top:4px">${escapeHtml(value)}</div></div>`;
  const check = (label: string) => `<label style="display:flex;align-items:center;gap:8px;padding:6px 0;font-size:13px"><input type="checkbox" checked disabled>${escapeHtml(label)}</label>`;

  // sessionHours / lockoutThreshold / lockoutWindowMinutes are hard-coded
  // constants in server.ts (~lines 34-36), not a settings table — duplicated
  // here read-only rather than imported, since server.ts doesn't export them.
  const sessionHours = 8;
  const lockoutThreshold = 5;
  const lockoutWindowMinutes = 15;

  const general = `<section class="card">${field("Public base URL (APP_BASE_URL)", process.env.APP_BASE_URL ?? "http://127.0.0.1:3000")}${field("Database (host/name only)", maskedDatabaseUrl())}</section>`;

  const authentication = `<section class="card">
    ${field("Session lifetime", `${sessionHours} hours`)}
    ${field("Login rate limit", `${lockoutThreshold} attempts / ${lockoutWindowMinutes} min`)}
    ${field("Lockout duration", `${lockoutWindowMinutes} minutes`)}
    <div style="padding-top:10px">${check("Argon2id password hashing")}${check("Secure + HttpOnly + SameSite session cookie")}${check("CSRF token on every mutating request")}</div>
  </section>`;

  const claude = `<section class="card"><div class="card-body">
    <div class="card-head" style="margin:-18px -18px 14px;border-radius:6px 6px 0 0">Subscription-only authentication</div>
    <p style="font-size:13px;color:var(--text2)">Worker-only credentials are not exposed to the web process.</p>
    <p style="font-size:12.5px;color:var(--text3)">The worker rejects API authentication variables; there is no fallback path to the API.</p>
    <div class="eyebrow" style="margin-top:14px">Refused environment variables</div>
    <div style="font-size:12.5px;color:var(--text3);margin-top:8px">Anthropic API, Bedrock, Vertex, and Foundry credentials.</div>
    <div class="eyebrow" style="margin-top:14px">Configuration intent — worker defaults, not verified against GitHub</div>
    <p style="font-size:12.5px;color:var(--text3);margin-top:4px">Each value is the worker's fallback when a project's config_json does not override it — not a universal fact.</p>
    <div class="grid two" style="margin-top:10px">${field("Planning max turns", "40")}${field("Planning timeout (min)", "30")}${field("Execution max turns", "50")}${field("Execution timeout (min)", "30")}</div>
  </div></section>`;

  const github = `<section class="card">
    ${field("GitHub API base URL", process.env.GITHUB_API_BASE_URL ?? "not configured")}
    ${field("GitHub access", capabilityLabel(cap))}
    <div class="eyebrow" style="margin-top:14px">Configuration intent — not verified against GitHub</div>
    <div style="padding-top:4px">${field("Pull request draft policy", "Always open pull requests as draft")}${field("Merge policy", "Automatic merge permanently disabled")}</div>
  </section>`;

  const backupRetention = /^[1-9][0-9]*$/.test(process.env.DCC_BACKUP_RETENTION_DAYS ?? "") ? process.env.DCC_BACKUP_RETENTION_DAYS + " days" : "not configured";
  const retention = `<section class="card">${field("Worktree cleanup", "not configured")}${field("Run event retention", "not configured")}${field("Audit retention", "not configured")}${field("Backup retention", backupRetention)}${field("Backup schedule", "not configured · external cron")}</section>`;

  const aiReview = `<section class="card"><div class="card-body">
    <div class="card-head" style="margin:-18px -18px 14px;border-radius:6px 6px 0 0">AI PR Review defaults</div>
    <form data-ai-review-settings-form style="display:flex;flex-direction:column;gap:12px">
      <label class="field"><span>Model</span>
        <select name="default_model">
          ${aiModels.map(m => `<option value="${m}" ${m === aiReviewSettings?.default_model ? "selected" : ""}>${escapeHtml(m)}</option>`).join("")}
        </select>
      </label>
      <label class="field"><span>Reasoning level</span>
        <select name="default_reasoning_level">
          ${reasoningLevels.map(r => `<option value="${r}" ${r === aiReviewSettings?.default_reasoning_level ? "selected" : ""}>${escapeHtml(r)}</option>`).join("")}
        </select>
      </label>
      <div style="display:flex;gap:8px;margin-top:8px">
        <button class="button primary" type="submit">Save</button>
        <div class="error" style="flex:1;color:var(--t-danger);align-self:center;font-size:13px"></div>
      </div>
    </form>
  </div></section>`;

  const modelOptions = (selected: string | null) => aiModels.map((m) => `<option value="${m}" ${m === selected ? "selected" : ""}>${escapeHtml(m)}</option>`).join("");
  const reasoningOptions = (selected: string | null) => [`<option value="">(none)</option>`, ...reasoningLevels.map((r) => `<option value="${r}" ${r === selected ? "selected" : ""}>${escapeHtml(r)}</option>`)].join("");
  const phaseFieldset = (label: string, phase: string) => `<fieldset><legend>${escapeHtml(label)}</legend><div class="grid two">
    <label class="field"><span>Model</span><select name="${phase}_model"><option value="">(none)</option>${modelOptions(systemAiSettings?.[`${phase}_model`] ?? null)}</select></label>
    <label class="field"><span>Reasoning level</span><select name="${phase}_reasoning_level">${reasoningOptions(systemAiSettings?.[`${phase}_reasoning_level`] ?? null)}</select></label>
  </div></fieldset>`;
  const systemAi = `<section class="card"><div class="card-body">
    <div class="card-head" style="margin:-18px -18px 14px;border-radius:6px 6px 0 0">System AI defaults</div>
    <p style="font-size:13px;color:var(--text2)">Used for planning, execution, and repair when a project or ticket does not override it. Leave a phase's model blank to fall back to the default below.</p>
    <form data-system-ai-settings-form style="display:flex;flex-direction:column;gap:12px;margin-top:10px">
      <fieldset><legend>Default</legend><div class="grid two">
        <label class="field"><span>Model</span><select name="default_model">${modelOptions(systemAiSettings?.default_model ?? null)}</select></label>
        <label class="field"><span>Reasoning level</span><select name="default_reasoning_level">${reasoningLevels.map((r) => `<option value="${r}" ${r === (systemAiSettings?.default_reasoning_level ?? null) ? "selected" : ""}>${escapeHtml(r)}</option>`).join("")}</select></label>
      </div></fieldset>
      ${phaseFieldset("Planning", "planning")}
      ${phaseFieldset("Execution", "execution")}
      ${phaseFieldset("Repair", "repair")}
      <div style="display:flex;gap:8px;margin-top:8px">
        <button class="button primary" type="submit">Save</button>
        <div class="error" style="flex:1;color:var(--t-danger);align-self:center;font-size:13px"></div>
      </div>
    </form>
  </div></section>`;

  return `<div class="eyebrow">config / system.yaml</div><h1>Settings</h1>
    <div class="tabs" role="tablist">${["General", "Authentication", "Claude runtime", "GitHub", "AI", "Retention"].map((label, index) => `<button type="button" role="tab" id="tab-${index}" aria-controls="panel-${index}" aria-selected="${index === 0}">${label}</button>`).join("")}</div>
    ${panel(0, general)}${panel(1, authentication)}${panel(2, claude)}${panel(3, github)}${panel(4, systemAi + aiReview)}${panel(5, retention)}`;
}

function statCard(label: string, value: string, detail: string, tone: string) {
  return `<div class="card" style="margin-top:0;border-top:2px solid var(--t-${tone})"><div class="card-body">
    <div class="eyebrow">${escapeHtml(label)}</div>
    <div style="font-family:'Cormorant Garamond',serif;font-weight:700;font-size:26px;margin-top:4px">${escapeHtml(value)}</div>
    <div style="font-size:12px;color:var(--text3);margin-top:4px">${escapeHtml(detail)}</div>
  </div></div>`;
}

export function backupStatusCards(retentionDays: string | undefined, latest: { status: string; verified_at: string | Date } | null) {
  const configured = /^[1-9][0-9]*$/.test(retentionDays ?? "");
  const schedule = configured
    ? statCard("Backup schedule", "not configured", "retention " + retentionDays + " days · external cron required", "muted")
    : statCard("Backup schedule", "not configured", "Set DCC_BACKUP_RETENTION_DAYS and install the documented external cron", "muted");
  const verification = latest
    ? statCard("Recovery verification", latest.status, "verified " + since(latest.verified_at) + " ago", latest.status === "passed" ? "ok" : "danger")
    : statCard("Recovery verification", "not configured", "Run the documented restore drill after a backup", "muted");
  return schedule + verification;
}

async function systemBody(): Promise<string> {
  const [heartbeat, depth, projects, failedJobs, failedDeliveries, failedRuns, sessionCleanup, latestBackupVerification] = await Promise.all([
    pool.query("SELECT (SELECT row_to_json(w) FROM (SELECT id,heartbeat_at,capabilities,version FROM workers ORDER BY heartbeat_at DESC LIMIT 1) w) worker"),
    pool.query("SELECT status, count(*)::int c FROM jobs GROUP BY status"),
    pool.query("SELECT slug, name, repository_path, health_status FROM projects ORDER BY name"),
    pool.query("SELECT id, type, error_json->>'message' message, updated_at FROM jobs WHERE status='failed' ORDER BY updated_at DESC LIMIT 10"),
    pool.query("SELECT id, event_type, error_message, response_status, updated_at FROM notification_deliveries WHERE status='failed' ORDER BY updated_at DESC LIMIT 10"),
    pool.query("SELECT id, run_type, error_code, error_message, finished_at FROM agent_runs WHERE status='failed' ORDER BY finished_at DESC LIMIT 10"),
    pool.query("SELECT created_at, (metadata_json->>'deleted_count')::integer deleted_count FROM audit_events WHERE action='admin_sessions.cleanup' ORDER BY created_at DESC LIMIT 1"),
    pool.query("SELECT status, verified_at FROM backup_recovery_verifications ORDER BY verified_at DESC LIMIT 1"),
  ]);

  const worker = heartbeat.rows[0]?.worker;
  const health = workerHealth(worker);
  const capabilityCount = worker?.capabilities?.length ?? 0;
  const workerCard = statCard(
    "Worker",
    health.label,
    worker ? `${health.detail} · ${capabilityCount ? worker.capabilities.join(", ") : "no capabilities"}` : health.detail,
    health.tone,
  );

  const claudeVersion = process.env.CLAUDE_CODE_VERSION ?? "unknown";
  const claudeCard = statCard("Claude Code", claudeVersion, "subscription auth", claudeVersion === "unknown" ? "muted" : "ok");

  const cleanup = sessionCleanup.rows[0];
  const cleanupCard = statCard("Session cleanup", cleanup ? String(cleanup.deleted_count) : "not run", cleanup ? `last run ${since(cleanup.created_at)} ago` : "worker has not completed cleanup yet", cleanup ? "ok" : "muted");

  const depthByStatus = new Map(depth.rows.map((row) => [row.status, row.c]));
  const running = depthByStatus.get("running") ?? 0;
  const queued = depthByStatus.get("queued") ?? 0;
  const totalDepth = running + queued;
  const queueCard = statCard("Queue depth", String(totalDepth), `${running} running · ${queued} queued`, totalDepth > 0 ? "ok" : "muted");

  let diskCard: string;
  try {
    const stats = statfsSync(artifactDataRoot(REPO_ROOT));
    const total = Number(stats.blocks) * Number(stats.bsize);
    const free = Number(stats.bfree) * Number(stats.bsize);
    const usedPct = total > 0 ? Math.round(((total - free) / total) * 100) : 0;
    const gib = (n: number) => (n / 1024 ** 3).toFixed(1);
    diskCard = statCard("Disk · data volume", `${usedPct}%`, `${gib(total - free)} GB of ${gib(total)} GB`, usedPct >= 85 ? "danger" : usedPct >= 70 ? "warn" : "ok");
  } catch {
    diskCard = statCard("Disk · data volume", "unknown", "data directory not accessible", "muted");
  }

  const projectRows = projects.rows.length
    ? projects.rows.map((project) => {
        const tone = project.health_status === "healthy" || project.health_status === "unknown" ? "ok" : project.health_status === "repository_dirty" ? "warn" : "danger";
        return `<a href="/admin/projects/${escapeHtml(project.slug)}" style="display:flex;align-items:center;gap:10px;padding:10px 18px;border-bottom:1px solid var(--border);text-decoration:none;color:inherit">
          <span style="width:8px;height:8px;border-radius:99px;background:var(--t-${tone});flex-shrink:0"></span>
          <span style="flex:1;font-size:13px">${escapeHtml(project.name)}</span>
          <span class="mono" style="font-size:12px;color:var(--text3)">${escapeHtml(project.repository_path ?? "")}</span>
          <span class="status">${escapeHtml(project.health_status)}</span>
        </a>`;
      }).join("")
    : `<div class="card-body"><p>No projects registered yet.</p></div>`;

  type ErrorRow = { id: string; prefix: string; label: string; message: string; at: string | null };
  const errorRows: ErrorRow[] = [
    ...failedJobs.rows.map((row): ErrorRow => ({ id: row.id, prefix: "JOB", label: row.type, message: row.message ?? "failed", at: row.updated_at })),
    ...failedDeliveries.rows.map((row): ErrorRow => ({ id: row.id, prefix: "ND", label: row.event_type ?? "delivery", message: row.error_message ?? (row.response_status ? `HTTP ${row.response_status}` : "failed"), at: row.updated_at })),
    ...failedRuns.rows.map((row): ErrorRow => ({ id: row.id, prefix: "RUN", label: row.run_type ?? "run", message: row.error_message ?? row.error_code ?? "failed", at: row.finished_at })),
  ].filter((row) => row.at).sort((a, b) => new Date(b.at as string).getTime() - new Date(a.at as string).getTime()).slice(0, 10);

  const errorList = errorRows.length
    ? errorRows.map((row) => `<div style="padding:10px 18px;border-bottom:1px solid var(--border)">
        <div style="display:flex;justify-content:space-between;gap:10px"><span class="mono" style="font-size:12px">${escapeHtml(shortRef(row.prefix, row.id))} · ${escapeHtml(row.label)}</span><span style="font-size:12px;color:var(--text3)">${escapeHtml(since(row.at as string))} ago</span></div>
        <div style="font-size:12.5px;color:var(--text3);margin-top:2px">${escapeHtml(row.message)}</div>
      </div>`).join("")
    : `<div class="card-body"><p>No failures recorded — clean run.</p></div>`;

  const preflightDisabled = `disabled title="No maintenance jobs registered"`;

  const backupCards = backupStatusCards(process.env.DCC_BACKUP_RETENTION_DAYS, latestBackupVerification.rows[0] ?? null);

  return `<div style="display:flex;align-items:flex-end;justify-content:space-between;gap:18px;flex-wrap:wrap">
      <div><div class="eyebrow">Observability</div><h1>System health</h1></div>
      <button type="button" class="button" ${preflightDisabled}>Run all preflight checks</button>
    </div>
    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(230px,1fr));margin-top:16px">${workerCard}${claudeCard}${cleanupCard}${queueCard}${diskCard}${backupCards}</div>
    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(320px,1fr));margin-top:22px;align-items:start">
      <section class="card" style="margin-top:0"><div class="card-head">Project health</div>${projectRows}</section>
      <section class="card" style="margin-top:0"><div class="card-head">Recent system errors</div>${errorList}</section>
    </div>`;
}

export async function render(url: URL, _session: Session, _metrics: Record<string, number>): Promise<PageResult> {
  if (url.pathname === "/admin/settings") {
    const [aiReviewSettings, capability, systemAiSettings] = await Promise.all([
      pool.query("SELECT * FROM ai_review_settings WHERE id=1"),
      pool.query("SELECT * FROM github_capability WHERE id=1"),
      pool.query("SELECT * FROM system_ai_settings WHERE id=1"),
    ]);
    return { status: 200, title: "Settings", body: settingsBody(aiReviewSettings.rows[0], capability.rows[0] ?? null, systemAiSettings.rows[0]) };
  }
  if (url.pathname === "/admin/system") return { status: 200, title: "System health", body: await systemBody() };
  return null;
}
