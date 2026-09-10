import { pool } from "@dcc/database";
import { adminPage, escapeHtml } from "../ui.ts";
import { WORKER_STALE_AFTER_MS } from "@dcc/domain";

export { pool, adminPage, escapeHtml };

// One semantic color scale for every status/state badge in the app:
// ok=green done/approved/enabled, danger=red failed/rejected, warn=amber
// needs attention/blocked, info=blue queued/intake, run=purple actively
// executing, muted=gray organizational/unknown. Ticket statuses use their
// exact display casing; worker-side states (runs, jobs, deliveries) are
// matched lowercase. Unknown labels fall back to muted so a new status can
// never render as the alarming default.
const ticketStatusTones: Record<string, string> = {
  "Submitted": "info", "Triage": "info", "Needs Information": "warn",
  "Approved for Planning": "ok", "Planning Queued": "info", "Planning": "run", "Planning Failed": "danger",
  "Plan Ready for Review": "run", "Plan Revision Requested": "warn", "Plan Revision Queued": "run", "Plan Approved": "ok",
  "Execution Queued": "info", "Executing": "run", "Validating": "run", "Validation Failed": "danger",
  "Execution Failed": "danger", "PR Creation Failed": "danger",
  "PR Ready for Review": "warn", "PR Changes Requested": "warn", "PR Approved": "ok",
  "Merged": "ok", "Completed": "ok", "Rejected": "danger", "Cancelled": "muted", "Archived": "muted",
  "Closed Without Merge": "muted",
};
const stateTones: Record<string, string> = {
  queued: "info", running: "run", completed: "ok", failed: "danger", cancelled: "muted",
  timed_out: "warn", cancellation_requested: "warn",
  blocked_auth: "warn", blocked_auth_configuration: "warn",
  sent: "ok", pending: "info", exhausted: "danger",
  staged: "info", finalized: "ok",
  passed: "ok", skipped: "muted",
  enabled: "ok", disabled: "muted", active: "ok", inactive: "muted", historic: "muted",
  captured: "ok", legacy: "muted", unpriced: "warn", unavailable: "warn",
  healthy: "ok", repository_dirty: "danger", inspection_error: "danger", stale: "warn", unknown: "muted",
  published: "ok", draft: "muted", placeholder: "muted",
  approved: "ok", rejected: "danger", error: "danger", resolved: "ok", open: "info", closed: "muted",
  unhealthy: "danger", unreachable: "warn", "pending_approval": "warn", deploying: "run",
  requested: "info", "on schedule": "ok", "never reported": "muted", overdue: "warn", "last run failed": "danger",
};

export function statusTone(label: unknown): string {
  const value = String(label ?? "").trim();
  return ticketStatusTones[value] ?? stateTones[value.toLowerCase()] ?? "muted";
}

export function statusBadge(label: unknown, extraClass = ""): string {
  return `<span class="status ${statusTone(label)}${extraClass ? ` ${extraClass}` : ""}">${escapeHtml(String(label ?? ""))}</span>`;
}

export function promptVersionsLabel(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  return Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, id]) => `${name}: ${id}`)
    .join(" · ");
}

// Derives worker health from the `workers` table's own heartbeat_at rather
// than from job-claim activity (PRD G10-F01): an idle-but-alive worker no
// longer reads as stale, and a dead worker stops reading as healthy
// WORKER_STALE_AFTER_MS after its last heartbeat instead of after its last
// claimed job.
export function workerHealth(
  row: { id: string; heartbeat_at: string | Date; capabilities: string[]; version: string | null } | undefined,
  now = Date.now(),
): { tone: "ok" | "warn"; label: string; detail: string } {
  if (!row) {
    return { tone: "warn", label: "no worker registered", detail: "No row in workers.heartbeat_at yet — the worker process has not sent a heartbeat." };
  }
  const ageMs = now - new Date(row.heartbeat_at).getTime();
  const stale = ageMs >= WORKER_STALE_AFTER_MS;
  const ageSecs = Math.round(ageMs / 1000);
  const capabilityCount = row.capabilities.length;
  const capabilityLabel = `${capabilityCount} job type${capabilityCount === 1 ? "" : "s"}`;
  const detail = `Source: workers.heartbeat_at · ${ageSecs}s ago · ${capabilityLabel}${row.version ? ` · v${row.version}` : ""}`;
  return { tone: stale ? "warn" : "ok", label: stale ? "stale" : "healthy", detail };
}

// PRD G10-F03: dashboards previously read metadata_json->>'turn', a value the
// worker sets once at run start and never updates again — a run stuck for
// hours still showed "turn 1/50" as if it were progressing. agent_runs now
// carries a live heartbeat_at/phase pair (migration 047) that the worker
// updates on a throttled cadence during execution; this derives a label from
// that instead, and never fabricates a percentage when turn is unknown.
export const RUN_STALE_AFTER_MS = 60_000;

export function runProgress(
  row: { phase: string | null; heartbeat_at: string | Date | null; turn: number | null; max_turns: number | null },
  now = Date.now(),
): { label: string; stale: boolean } {
  if (!row.heartbeat_at) {
    return { label: row.phase ? `phase ${row.phase} · no heartbeat yet` : "no heartbeat yet", stale: true };
  }
  const ageMs = now - new Date(row.heartbeat_at).getTime();
  const stale = ageMs >= RUN_STALE_AFTER_MS;
  const phaseLabel = row.phase ? `phase ${row.phase}` : "no phase reported";
  if (stale) {
    const ageMinutes = Math.max(1, Math.round(ageMs / 60000));
    return { label: `${phaseLabel} · no heartbeat for ${ageMinutes} min`, stale: true };
  }
  const ageSecs = Math.max(0, Math.round(ageMs / 1000));
  return { label: `${phaseLabel} · updated ${ageSecs} s ago`, stale: false };
}

// PRD G10-F03: pull_requests.last_synced_at can silently go stale (sync job
// failing, GitHub API down) while the UI keeps showing the last cached
// state as if it were current. Flag rows whose sync age exceeds the
// threshold instead of presenting stale cache data as live.
export const PR_STALE_AFTER_MS = 15 * 60_000;

export function prFreshness(lastSyncedAt: string | Date | null, now = Date.now()): { stale: boolean; label: string } {
  if (!lastSyncedAt) return { stale: true, label: "never synced" };
  const ageMs = now - new Date(lastSyncedAt).getTime();
  const stale = ageMs >= PR_STALE_AFTER_MS;
  const ageMinutes = Math.max(0, Math.round(ageMs / 60000));
  return { stale, label: `last synced ${ageMinutes} min ago` };
}

// Shared by both the admin page renderers and the admin API.
export const validStatuses = new Set([
  "Submitted", "Triage", "Needs Information", "Rejected", "Approved for Planning", "Planning Queued",
  "Planning", "Planning Failed", "Plan Ready for Review", "Plan Revision Requested", "Plan Revision Queued", "Plan Approved",
  "Execution Queued", "Executing", "Validating", "Validation Failed", "Execution Failed", "PR Creation Failed",
  "PR Ready for Review", "PR Changes Requested", "PR Approved", "Merged", "Closed Without Merge", "Completed",
  "Cancelled", "Archived",
]);

export const allowedTemplateVariables = new Set([
  "project.slug", "project.name", "project.description", "project.repository_path", "project.agent_start_path", "project.default_branch",
  "ticket.title", "ticket.description", "ticket.category", "ticket.priority",
  "pr.number", "pr.title", "pr.url", "pr.author", "pr.head_branch", "pr.base_branch", "pr.body", "pr.diff", "feedback",
  "superpowers.code-reviewer",
]);

export function lineDiff(before: string, after: string) {
  const left = before.split("\n");
  const right = after.split("\n");
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < left.length - prefix && suffix < right.length - prefix
    && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]) suffix += 1;
  const oldLines = left.slice(prefix, left.length - suffix), newLines = right.slice(prefix, right.length - suffix);
  const lines = left.slice(0, prefix).map((line) => ` ${line}`);
  if (oldLines.length * newLines.length > 1_000_000) {
    lines.push("@@ Diff simplified: changed section too large to align safely @@");
    lines.push(...oldLines.map((line) => `-${line}`), ...newLines.map((line) => `+${line}`));
    lines.push(...left.slice(left.length - suffix).map((line) => ` ${line}`));
    return lines.join("\n");
  }
  const common = Array.from({ length: oldLines.length + 1 }, () => new Uint32Array(newLines.length + 1));
  for (let i = oldLines.length - 1; i >= 0; i -= 1) for (let j = newLines.length - 1; j >= 0; j -= 1) {
    common[i][j] = oldLines[i] === newLines[j] ? common[i + 1][j + 1] + 1 : Math.max(common[i + 1][j], common[i][j + 1]);
  }
  let i = 0, j = 0;
  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) { lines.push(` ${oldLines[i++]}`); j += 1; }
    else if (j < newLines.length && (i === oldLines.length || common[i][j + 1] >= common[i + 1][j])) lines.push(`+${newLines[j++]}`);
    else lines.push(`-${oldLines[i++]}`);
  }
  lines.push(...left.slice(left.length - suffix).map((line) => ` ${line}`));
  return lines.join("\n");
}

function inlineMarkdown(value: string) {
  let output = "", cursor = 0;
  for (const match of value.matchAll(/\[([^\]]+)\]\(([^\s)]+)\)/g)) {
    output += escapeHtml(value.slice(cursor, match.index));
    let safe = false;
    try { safe = match[2].startsWith("/") || ["http:", "https:"].includes(new URL(match[2]).protocol); } catch { /* plain text */ }
    output += safe ? `<a href="${escapeHtml(match[2])}" rel="noopener">${escapeHtml(match[1])}</a>` : escapeHtml(match[0]);
    cursor = (match.index ?? 0) + match[0].length;
  }
  return output + escapeHtml(value.slice(cursor));
}

export function renderMarkdown(content: string) {
  const lines = content.split("\n"), output: string[] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    const fence = /^```([\w-]*)\s*$/.exec(line);
    if (fence) {
      const code: string[] = [];
      for (index += 1; index < lines.length && !/^```\s*$/.test(lines[index]); index += 1) code.push(lines[index]);
      if (index < lines.length) index += 1;
      output.push(`<pre><code${fence[1] ? ` class="language-${escapeHtml(fence[1])}"` : ""}>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }
    if (/^\|.*\|\s*$/.test(line) && /^\|(?:\s*:?-+:?\s*\|)+\s*$/.test(lines[index + 1] ?? "")) {
      const cells = (row: string) => row.trim().slice(1, -1).split("|").map((cell) => cell.trim());
      output.push(`<table><thead><tr>${cells(line).map((cell) => `<th>${inlineMarkdown(cell)}</th>`).join("")}</tr></thead><tbody>`);
      index += 2;
      while (index < lines.length && /^\|.*\|\s*$/.test(lines[index])) output.push(`<tr>${cells(lines[index++]).map((cell) => `<td>${inlineMarkdown(cell)}</td>`).join("")}</tr>`);
      output.push("</tbody></table>");
      continue;
    }
    if (/^\s*-\s+/.test(line)) {
      let depth = -1;
      while (index < lines.length) {
        const item = /^(\s*)-\s+(.*)$/.exec(lines[index]);
        if (!item) break;
        const nextDepth = depth < 0 ? 0 : Math.min(Math.floor(item[1].length / 2), depth + 1);
        if (depth < 0) { output.push("<ul><li>"); depth = 0; }
        else if (nextDepth > depth) { output.push("<ul><li>"); depth = nextDepth; }
        else { while (depth > nextDepth) { output.push("</li></ul>"); depth -= 1; } output.push("</li><li>"); }
        output.push(inlineMarkdown(item[2]));
        index += 1;
      }
      while (depth >= 0) { output.push("</li></ul>"); depth -= 1; }
      continue;
    }
    if (line.startsWith("### ")) output.push(`<h3>${inlineMarkdown(line.slice(4))}</h3>`);
    else if (line.startsWith("## ")) output.push(`<h2>${inlineMarkdown(line.slice(3))}</h2>`);
    else if (line.startsWith("# ")) output.push(`<h1>${inlineMarkdown(line.slice(2))}</h1>`);
    else if (line) output.push(`<p>${inlineMarkdown(line)}</p>`);
    index += 1;
  }
  return output.join("");
}

export const standardFields = [
  { field_key: "project_id", field_type: "project_selector", label: "Welk project betreft het?", required: false, position: 10 },
  { field_key: "category", field_type: "category_selector", label: "Categorie", required: false, position: 20, options_json: ["Bug", "UI", "Feature", "Performance"] },
  { field_key: "title", field_type: "short_text", label: "Korte samenvatting", required: true, position: 30, validation_json: { max_length: 200 } },
  { field_key: "description", field_type: "long_text", label: "Wat gaat er mis of wat mist er?", required: true, position: 40, validation_json: { max_length: 10000 } },
  { field_key: "source_url", field_type: "url", label: "Op welke pagina gebeurt dit?", required: false, position: 50 },
  { field_key: "environment", field_type: "environment_selector", label: "Omgeving", required: false, position: 60, options_json: ["Productie", "Staging", "Lokaal"] },
  { field_key: "screenshots", field_type: "image_upload", label: "Screenshots", required: false, position: 70 },
  { field_key: "submitter_email", field_type: "email", label: "E-mailadres (optioneel)", required: false, position: 80 },
  { field_key: "website", field_type: "hidden", label: "Website", required: false, position: 90 },
];

export async function fieldsFor(formId: string) {
  const rows = (await pool.query("SELECT * FROM form_fields WHERE form_id = $1 ORDER BY position, created_at", [formId])).rows;
  return rows.length ? rows : standardFields.map((field) => ({ ...field, form_id: formId, validation_json: field.validation_json ?? {}, options_json: field.options_json ?? [] }));
}

// Human-readable short reference for uuid-keyed rows (e.g. RUN-0898, ND-8841):
// the last 4 hex characters of the uuid, uppercased. Purely presentational.
export const shortRef = (prefix: string, id: string, length = 4) => `${prefix}-${id.replace(/-/g, "").slice(-length).toUpperCase()}`;

// PRD §26 gives agent_runs / notification_deliveries no sequential number
// column, so their human reference has to come from the uuid — and a 4-hex
// suffix does collide once a list holds enough rows. Within one rendered list,
// the earliest row keeps the short reference and later collisions widen until
// they are distinct, so no two visible rows ever share a label.
export function shortRefs(prefix: string, rows: Array<{ id: string }>) {
  const labels = new Map<string, string>();
  const taken = new Set<string>();
  for (const row of [...rows].reverse()) {
    let length = 4;
    let label = shortRef(prefix, row.id, length);
    while (taken.has(label) && length < 32) label = shortRef(prefix, row.id, (length += 2));
    taken.add(label);
    labels.set(row.id, label);
  }
  return labels;
}

// PRD G10-F04: admin list pages (audit log, notification deliveries, tickets)
// used ORDER BY <col> DESC LIMIT 200 with no way to page past row 200 — older
// records became silently unreachable once a list grew past the limit. These
// are shared keyset ("seek") pagination helpers: pageRequest reads
// ?limit=&cursor=<iso>,<uuid> off the URL (clamping/validating both),
// keysetCondition builds the `(at,id) < ($n,$n+1)` WHERE predicate, and
// nextCursor/pagerHtml surface a "Next" link only when a full page came back
// — a short page means there is nothing left to page to.
export const PAGE_SIZE_DEFAULT = 50;
export const PAGE_SIZE_MAX = 200;

export function pageRequest(url: URL): { limit: number; cursor: { at: string; id: string } | null } {
  const limitParam = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(limitParam) && limitParam > 0
    ? Math.min(Math.trunc(limitParam), PAGE_SIZE_MAX)
    : PAGE_SIZE_DEFAULT;

  const cursorParam = url.searchParams.get("cursor");
  let cursor: { at: string; id: string } | null = null;
  if (cursorParam) {
    const commaIndex = cursorParam.indexOf(",");
    if (commaIndex > 0) {
      const at = cursorParam.slice(0, commaIndex);
      const id = cursorParam.slice(commaIndex + 1);
      if (at && id && !Number.isNaN(new Date(at).getTime())) cursor = { at, id };
    }
  }
  return { limit, cursor };
}

export function keysetCondition(
  cursor: { at: string; id: string } | null,
  atColumn: string,
  idColumn: string,
  values: any[],
): string | null {
  if (!cursor) return null;
  values.push(cursor.at, cursor.id);
  const idIndex = values.length;
  return `(${atColumn}, ${idColumn}) < ($${idIndex - 1}, $${idIndex})`;
}

export function nextCursor(rows: any[], limit: number, atKey: string): string | null {
  if (rows.length < limit) return null;
  const last = rows[rows.length - 1];
  const at = last[atKey] instanceof Date ? last[atKey].toISOString() : last[atKey];
  return `${at},${last.id}`;
}

export function pagerHtml(url: URL, next: string | null): string {
  if (!next) return "";
  const params = new URLSearchParams(url.search);
  params.set("cursor", next);
  return `<div class="pager"><a class="button" data-pager-next href="${escapeHtml(`${url.pathname}?${params.toString()}`)}">Next</a></div>`;
}

// Dates render dd-mm-yyyy (the house standard) regardless of the visitor's
// browser locale; UI copy stays English. Date-only ISO strings are formatted
// manually so a UTC parse can never shift the day across timezones.
export function fmtDate(value: unknown): string {
  if (!value) return "—";
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split("-");
    return `${day}-${month}-${year}`;
  }
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("nl-NL");
}

export function fmtDateTime(value: unknown): string {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("nl-NL");
}

// dd-mm-yyyy → ISO yyyy-mm-dd for API round-trips; null when empty/invalid.
export function parseDateInput(value: string): string | null {
  const match = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(value.trim());
  if (!match) return null;
  const day = Number(match[1]); const month = Number(match[2]); const year = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export type Session = { username: string; user_id: string };
export type PageResult = { status: number; title: string; body: string } | null;
export type PageModule = { render(url: URL, session: Session, metrics: Record<string, number>): Promise<PageResult> };
