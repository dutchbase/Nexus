import { pool } from "@dcc/database";
import { adminPage, escapeHtml } from "../ui.ts";
import { WORKER_STALE_AFTER_MS } from "@dcc/domain";

export { pool, adminPage, escapeHtml };

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
  const lines: string[] = [];
  const maximum = Math.max(left.length, right.length);
  for (let index = 0; index < maximum; index += 1) {
    if (left[index] === right[index]) lines.push(` ${left[index] ?? ""}`);
    else {
      if (left[index] !== undefined) lines.push(`-${left[index]}`);
      if (right[index] !== undefined) lines.push(`+${right[index]}`);
    }
  }
  return lines.join("\n");
}

export function renderMarkdown(content: string) {
  return content.split("\n").map((line) => {
    if (line.startsWith("### ")) return `<h3>${escapeHtml(line.slice(4))}</h3>`;
    if (line.startsWith("## ")) return `<h2>${escapeHtml(line.slice(3))}</h2>`;
    if (line.startsWith("# ")) return `<h1>${escapeHtml(line.slice(2))}</h1>`;
    if (line.startsWith("- ")) return `<p>• ${escapeHtml(line.slice(2))}</p>`;
    return line ? `<p>${escapeHtml(line)}</p>` : "<br>";
  }).join("");
}

export const standardFields = [
  { field_key: "project_id", field_type: "project_selector", label: "Welk project betreft het?", required: false, position: 10 },
  { field_key: "category", field_type: "category_selector", label: "Categorie", required: false, position: 20, options_json: ["Bug", "UI", "Feature", "Performance"] },
  { field_key: "title", field_type: "short_text", label: "Korte samenvatting", required: true, position: 30, validation_json: { max_length: 200 } },
  { field_key: "description", field_type: "long_text", label: "Wat gaat er mis of wat mist er?", required: true, position: 40, validation_json: { max_length: 10000 } },
  { field_key: "source_url", field_type: "url", label: "Op welke pagina gebeurt dit?", required: false, position: 50 },
  { field_key: "environment", field_type: "environment_selector", label: "Omgeving", required: false, position: 60, options_json: ["Productie", "Staging", "Lokaal"] },
  { field_key: "screenshot", field_type: "image_upload", label: "Schermafbeelding", required: false, position: 70 },
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

export type Session = { username: string; user_id: string };
export type PageResult = { status: number; title: string; body: string } | null;
export type PageModule = { render(url: URL, session: Session, metrics: Record<string, number>): Promise<PageResult> };
