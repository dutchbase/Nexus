import { escapeHtml, fmtDateTime, pool, prFreshness, renderMarkdown, shortRef, statusBadge } from "./shared.ts";
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

// Changed files & validation reads from the run's validation_output, which is
// either a success record ({ results, changed_files }) or a failure record
// ({ check, message, output, results }). Never dump the raw JSON — render
// the human summary, or a plain sentence when nothing was recorded.
function validationCard(validation: any): string {
  const changedFiles: string[] = Array.isArray(validation?.changed_files) ? validation.changed_files : [];
  const results: Array<{ check: string; status: string; detail?: string }> = Array.isArray(validation?.results) ? validation.results : [];
  if (!changedFiles.length && !results.length && !validation?.message) {
    return "<p>No changed files or validation results recorded.</p>";
  }
  const failure = validation?.message
    ? `<div class="banner-danger" style="margin:0 0 14px">Validation failed at ${escapeHtml(validation.check ?? "unknown check")}: ${escapeHtml(validation.message)}</div>`
    : "";
  const files = changedFiles.length
    ? `<p><strong>${changedFiles.length} changed file${changedFiles.length === 1 ? "" : "s"}</strong></p><ul>${changedFiles.map((file) => `<li class="mono">${escapeHtml(file)}</li>`).join("")}</ul>`
    : "<p>No changed files recorded.</p>";
  const checks = results.length
    ? `<p><strong>Validation checks</strong></p><ul style="list-style:none;padding:0;margin:0">${results.map((result) => `<li style="padding:4px 0">${statusBadge(result.status ?? "")} <span class="mono">${escapeHtml(result.check)}</span>${result.detail ? ` <span style="color:var(--text3)">· ${escapeHtml(result.detail)}</span>` : ""}</li>`).join("")}</ul>`
    : "";
  return `${failure}${files}${checks}`;
}

export type BulkMergeClassification = { eligible: true } | { eligible: false; reason: string };

// TODO(plan 01 dependency): once packages/domain/src/pull-request-policy-status.ts
// (derivePolicyStatus) lands, replace this function's policy-check block with a call
// to it instead of re-deriving the same logic — see plans/09-pull-requests-bulk-actions.md
// Task 3 Global Constraints for why this duplication is temporary and intentional.
export function classifyBulkMergeEligibility(row: {
  state: string; head_sha: string | null; current_policy_snapshot_id: string | null;
  policy_stale: boolean; policy_complete: boolean | null; review_state: string | null;
  check_state: string | null; is_draft: boolean | null; merge_conflicts: boolean | null;
}, requireFreshPolicyBinding: boolean): BulkMergeClassification {
  if (row.state !== "open") return { eligible: false, reason: `pull request is ${row.state}, not open` };
  if (row.is_draft) return { eligible: false, reason: "pull request is a draft" };
  if (row.merge_conflicts) return { eligible: false, reason: "pull request has merge conflicts" };
  if (!row.head_sha) return { eligible: false, reason: "GitHub head SHA is unavailable" };
  if (requireFreshPolicyBinding && !row.current_policy_snapshot_id) return { eligible: false, reason: "GitHub policy snapshot is unavailable" };
  if (requireFreshPolicyBinding && row.policy_stale) return { eligible: false, reason: "GitHub policy is stale" };
  if (requireFreshPolicyBinding && !row.policy_complete) return { eligible: false, reason: "GitHub policy is incomplete" };
  if (requireFreshPolicyBinding && !["approved", "not_required"].includes(row.review_state ?? "")) return { eligible: false, reason: `GitHub reviews are ${row.review_state ?? "unknown"}` };
  if (requireFreshPolicyBinding && !["success", "not_required"].includes(row.check_state ?? "")) return { eligible: false, reason: `GitHub checks are ${row.check_state ?? "unknown"}` };
  return { eligible: true };
}

// Shared by both the uuid route (/admin/pull-requests/{uuid}) and the slug
// route (/admin/pull-requests/{projectSlug}/{number}) so the two never drift.
function renderDetail(item: any, aiReviews: any[], conflictResolutions: any[], requireFreshPolicyBinding: boolean): PageResult {
  if (!item) return { status: 404, title: "Pull request not found", body: "<h1>Pull request not found</h1>" };
  const validation = item.metadata_json?.validation_output ?? {};
  const changes = (item.additions != null || item.deletions != null || item.changed_files != null)
    ? `+${item.additions ?? 0} −${item.deletions ?? 0} · ${item.changed_files ?? 0} files` : "Unknown";
  const canMarkReviewed = item.internal_review_state !== "reviewed";
  const canRequestChanges = item.internal_review_state !== "changes_requested";
  const canCloseTicket = Boolean(item.ticket_id) && !["Completed", "Closed Without Merge"].includes(item.ticket_status);
  const canStartRepair = Boolean(item.run_id);
  const button = (attr: string, label: string, allowed: boolean, deniedReason: string, extraClass = "") =>
    `<button class="button${extraClass}" type="button" ${attr}${allowed ? "" : " disabled"} title="${allowed ? "" : escapeHtml(deniedReason)}">${label}</button>`;
  const policyIssue = !item.current_policy_snapshot_id
    ? "Unavailable: policy snapshot missing"
    : !item.head_sha
    ? "Unavailable: head SHA missing"
    : item.policy_stale
    ? `Stale${item.policy_error_code ? `: ${item.policy_error_code}` : ""}${item.policy_retry_after ? `; retry after ${new Date(item.policy_retry_after).toLocaleString("nl-NL")}` : ""}`
    : !item.policy_complete
    ? `Incomplete${item.policy_error_code ? `: ${item.policy_error_code}` : ""}`
    : "Current";
  const mergeBlocker = !item.head_sha
    ? "GitHub head SHA is unavailable"
    : requireFreshPolicyBinding && !item.current_policy_snapshot_id
    ? "GitHub policy snapshot is unavailable"
    : requireFreshPolicyBinding && item.policy_stale
    ? "GitHub policy is stale"
    : requireFreshPolicyBinding && !item.policy_complete
    ? "GitHub policy is incomplete"
    : requireFreshPolicyBinding && !["approved", "not_required"].includes(item.review_state)
    ? `GitHub reviews are ${item.review_state ?? "unknown"}`
    : requireFreshPolicyBinding && !["success", "not_required"].includes(item.check_state)
    ? `GitHub checks are ${item.check_state ?? "unknown"}`
    : "";
  const policyAllowsMerge = !mergeBlocker;
  const requestedReviewers = Array.isArray(item.requested_reviewers)
    ? item.requested_reviewers.map((reviewer: any) => `${reviewer.type === "team" ? "team " : ""}${reviewer.name ?? "unknown"}`).join(", ") || "None"
    : "Unknown";
  const latestAiReview = aiReviews[0] ?? null;
  const stateBadge = item.is_draft
    ? { cls: "muted", label: "Draft" }
    : item.merged_at
    ? { cls: "ok", label: "Merged" }
    : item.state === "closed"
    ? { cls: "danger", label: "Closed" }
    : { cls: "info", label: "Open" };
  const reviewBadge = ({
    approved: { cls: "ok", label: "Admin: Approved" },
    changes_requested: { cls: "warn", label: "Admin: Changes requested" },
    reviewed: { cls: "info", label: "Admin: Reviewed" },
  } as Record<string, { cls: string; label: string }>)[item.internal_review_state ?? ""] ?? { cls: "muted", label: "Admin: Not reviewed" };
  const aiBadge = latestAiReview
    ? ({
        running: { cls: "run", label: "AI: Running…" },
        approved: { cls: "ok", label: "AI: Approved" },
        rejected: { cls: "danger", label: "AI: Rejected" },
        error: { cls: "danger", label: "AI: Error" },
      } as Record<string, { cls: string; label: string }>)[latestAiReview.status] ?? { cls: "muted", label: `AI: ${escapeHtml(latestAiReview.status)}` }
    : { cls: "muted", label: "AI: No review yet" };
  const latestConflictResolution = conflictResolutions[0] ?? null;
  const conflictResolutionBadge = latestConflictResolution
    ? ({
        running: { cls: "run", label: "Conflict resolution: Running…" },
        resolved: { cls: "ok", label: "Conflict resolution: Resolved" },
        error: { cls: "danger", label: "Conflict resolution: Error" },
      } as Record<string, { cls: string; label: string }>)[latestConflictResolution.status]
      ?? { cls: "muted", label: `Conflict resolution: ${escapeHtml(latestConflictResolution.status)}` }
    : null;
  const body = `<div class="eyebrow">${escapeHtml(item.project_name)} · ${escapeHtml(item.repository)}</div>
    <p class="mono">${escapeHtml(item.project_slug)}/${escapeHtml(item.repository)} #${item.number}</p>
    <h1>${escapeHtml(item.title)}</h1>
    <div class="toolbar" data-pr-id="${item.id}">
      <span class="status ${stateBadge.cls}">${escapeHtml(stateBadge.label)}</span>
      <span class="status ${reviewBadge.cls}">${escapeHtml(reviewBadge.label)}</span>
      <span class="status ${aiBadge.cls}" data-ai-review-status="${escapeHtml(latestAiReview?.status ?? "")}">${escapeHtml(aiBadge.label)}</span>
      <span class="status ${policyAllowsMerge ? "ok" : "warn"}">GitHub: ${escapeHtml(policyIssue)}</span>
      ${item.merge_conflicts ? `<span class="status danger">Conflicts</span>` : ""}
      ${conflictResolutionBadge ? `<span class="status ${conflictResolutionBadge.cls}" data-conflict-resolution-status="${escapeHtml(latestConflictResolution.status)}">${escapeHtml(conflictResolutionBadge.label)}</span>` : ""}
      ${item.merge_conflicts ? button("data-pr-resolve-conflicts", "Resolve conflicts (AI)", true, "") : ""}
      ${button(`data-pr-approve data-pr-head-sha="${escapeHtml(item.head_sha ?? "")}"${requireFreshPolicyBinding ? ` data-pr-policy-snapshot-id="${escapeHtml(item.current_policy_snapshot_id ?? "")}"` : ""}`, "Approve & merge", policyAllowsMerge, mergeBlocker, " primary")}
      ${button("data-pr-ai-review", "AI review", true, "")}
      <a class="button" href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">Open on GitHub ↗</a>
      <details class="menu">
        <summary class="button">More options ▾</summary>
        <div class="menu-panel">
          <button class="button" type="button" data-pr-refresh>Refresh</button>
          ${button("data-pr-request-changes", "Request changes", canRequestChanges, "Changes already requested")}
          ${button("data-pr-mark-reviewed", "Mark reviewed", canMarkReviewed, "Already marked reviewed")}
          ${button("data-pr-close-ticket", "Close ticket", canCloseTicket, item.ticket_id ? "Ticket is already closed" : "No linked ticket")}
          <button class="button" type="button" data-open-create-ticket data-project-id="${item.project_id}" data-title="Follow-up: ${escapeHtml(item.title)}">Create follow-up ticket</button>
          <label class="field"><span>AI model override</span><select data-ai-review-model><option value="">(default)</option>${aiModels.map((m) => `<option value="${m}">${escapeHtml(m)}</option>`).join("")}</select></label>
          <label class="field"><span>AI reasoning override</span><select data-ai-review-reasoning><option value="">(default)</option>${reasoningLevels.map((r) => `<option value="${r}">${escapeHtml(r)}</option>`).join("")}</select></label>
        </div>
      </details>
    </div>
    <dialog data-create-ticket-dialog aria-label="Create follow-up ticket"><div class="card-head">Create follow-up ticket</div><form data-create-ticket-form><div class="card-body"><label class="field"><span>Title</span><input name="title" required></label><label class="field"><span>Feedback for AI</span><textarea name="feedback" rows="4"></textarea></label><label class="field"><span>Description</span><textarea name="description" rows="4"></textarea></label><label><input name="generate_description" type="checkbox" checked> Generate a description with AI in the background</label><p class="error" role="alert"></p></div><div style="padding:12px 18px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px"><button class="button" type="button" data-close-dialog>Cancel</button><button class="button primary" type="submit">Create</button></div></form></dialog>
    <div class="grid two"><section class="card"><div class="card-head">Metadata</div><div class="card-body"><dl>
    <dt>Ticket</dt><dd>${item.ticket_number ? `<a href="/admin/tickets/${escapeHtml(item.ticket_number)}">${escapeHtml(item.ticket_number)} · ${escapeHtml(item.ticket_title)}</a> (${escapeHtml(item.ticket_status)})` : `<span style="color:var(--text3)">Not linked</span>`}</dd>
    <dt>Author</dt><dd>${escapeHtml(item.author)}</dd><dt>Branches</dt><dd>${escapeHtml(item.head_branch)} → ${escapeHtml(item.base_branch)}</dd>
    <dt>Head SHA</dt><dd class="mono">${escapeHtml(item.head_sha ?? "Unknown")}</dd><dt>Policy snapshot</dt><dd class="mono">${escapeHtml(item.current_policy_snapshot_id ?? "Unavailable")}</dd><dt>GitHub: reviews</dt><dd>${escapeHtml(item.review_state ?? "Unknown")}</dd>
    <dt>GitHub: checks</dt><dd>${escapeHtml(item.check_state ?? "Unknown")}</dd><dt>Requested reviewers</dt><dd>${escapeHtml(requestedReviewers)}</dd>
    <dt>GitHub policy</dt><dd>${escapeHtml(policyIssue)}${item.policy_synced_at ? ` · ${new Date(item.policy_synced_at).toLocaleString("nl-NL")}` : ""}</dd><dt>Internal review</dt><dd>${escapeHtml(item.internal_review_state ?? "Not reviewed")}</dd>
    <dt>Changes</dt><dd class="mono">${escapeHtml(changes)}</dd>
    <dt>Model used</dt><dd>${item.run_model ? `${escapeHtml(item.run_model)} · ${escapeHtml(item.run_reasoning_level)}` : "Not run by the platform"}</dd>
    <dt>Run</dt><dd>${item.run_id ? `<a href="/admin/runs/${item.run_id}">${shortRef("RUN", item.run_id)}</a>` : "Not linked"}</dd>
    <dt>Plan hash</dt><dd class="mono">${item.approved_plan_hash ? escapeHtml(item.approved_plan_hash.slice(0, 12)) : "—"}</dd>
    <dt>Skills applied</dt><dd>${item.skills_applied != null ? escapeHtml(String(item.skills_applied)) : "—"}</dd>
    <dt>Created</dt><dd>${item.created_at_provider ? fmtDateTime(item.created_at_provider) : "—"}</dd>
    <dt>Last synced</dt><dd>${item.last_synced_at ? new Date(item.last_synced_at).toLocaleString("nl-NL") : "Never"}</dd></dl></div></section>
    <section class="card"><div class="card-head">Changed files &amp; validation</div><div class="card-body">${validationCard(validation)}</div></section></div>
    ${item.body ? `<section class="card"><div class="card-head">Description</div><div class="card-body">${renderMarkdown(item.body)}</div></section>` : ""}
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
        <strong>${escapeHtml(r.status.toUpperCase())}</strong> (${escapeHtml(r.mode)}, ${escapeHtml(r.model)}/${escapeHtml(r.reasoning_level)}) — ${fmtDateTime(r.created_at)}
        <p>${escapeHtml(r.status === "error" ? (r.error_message ?? r.last_publication_error ?? "Review failed.") : (r.summary ?? "Running…"))}</p>
        <p class="mono">Publication ${escapeHtml(r.publication_id ?? "—")} · GitHub comment ${escapeHtml(String(r.github_comment_id ?? "—"))}</p>
        ${r.raw_output ? `<pre>${escapeHtml(r.raw_output)}</pre>` : ""}
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
    const tab = url.searchParams.get("tab") ?? "open";
    if (tab === "open") conditions.push("pr.state='open' AND pr.is_draft IS NOT TRUE");
    else if (tab === "draft") conditions.push("pr.is_draft=true");
    else if (tab === "merged") conditions.push("pr.merged_at IS NOT NULL");
    else if (tab === "closed") conditions.push("pr.state='closed' AND pr.merged_at IS NULL");
    const [pullRequests, repositories, lastSynced] = await Promise.all([
      pool.query(
        `SELECT pr.*,p.name project_name,p.slug project_slug,t.ticket_number,t.status ticket_status,
                (SELECT status FROM pr_ai_reviews WHERE pull_request_id=pr.id ORDER BY created_at DESC LIMIT 1) AS latest_ai_review_status
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
      const stateBadge = item.is_draft
        ? { cls: "muted", label: "Draft" }
        : item.merged_at
        ? { cls: "ok", label: "Merged" }
        : item.state === "closed"
        ? { cls: "danger", label: "Closed" }
        : { cls: "info", label: "Open" };
      const aiBadge = ({
        running: { cls: "run", label: "Running…" },
        approved: { cls: "ok", label: "Approved" },
        rejected: { cls: "danger", label: "Rejected" },
        error: { cls: "danger", label: "Error" },
      } as Record<string, { cls: string; label: string }>)[item.latest_ai_review_status ?? ""]
        ?? { cls: "muted", label: item.latest_ai_review_status ? escapeHtml(item.latest_ai_review_status) : "No review yet" };
      const href = `/admin/pull-requests/${escapeHtml(item.project_slug)}/${escapeHtml(item.number)}`;
      // PRD G10-F03: pull_requests is a cache of GitHub state kept fresh by a
      // sync job; if that job stalls, the row otherwise looks exactly like a
      // freshly synced one. Label rows whose last_synced_at has aged past
      // PR_STALE_AFTER_MS instead of presenting stale data as current.
      const freshness = prFreshness(item.last_synced_at);
      const selectCell = item.state === "open"
        ? `<span class="pr-select" data-label="Select"><input type="checkbox" data-pr-check="${item.id}" value="${item.id}" aria-label="Select pull request #${escapeHtml(item.number)}"></span>`
        : `<span class="pr-select" data-label="Select"></span>`;
      return `<div class="ticket-row prs-row" data-pr-id="${item.id}" data-pr-state="${escapeHtml(item.state)}" data-pr-draft="${item.is_draft ? "1" : "0"}"><a class="pr-row-link" href="${href}" aria-label="Open pull request #${escapeHtml(item.number)}"></a>${selectCell}<span class="mono" data-label="PR">#${escapeHtml(item.number)}</span><strong>${escapeHtml(item.title)}</strong><span data-label="Project">${escapeHtml(item.project_name)}</span><span class="status ${stateBadge.cls}" data-label="Merge status">${escapeHtml(stateBadge.label)}</span><span class="status ${aiBadge.cls}" data-label="AI status">${escapeHtml(aiBadge.label)}</span><span data-label="Conflicts">${item.merge_conflicts ? `<span class="status danger">Conflicts</span>` : ""}${freshness.stale ? `<span class="status warn">Stale · ${escapeHtml(freshness.label)}</span>` : ""}</span><time data-label="Created">${item.created_at_provider ? escapeHtml(new Date(item.created_at_provider).toLocaleDateString("nl-NL")) : "—"}</time><div class="pr-actions"><a class="button" href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">Open on GitHub ↗</a></div></div>`;
    }).join("");
    const tabs = [["all", "All"], ["open", "Open"], ["draft", "Draft"], ["merged", "Merged"], ["closed", "Closed"]] as const;
    const withTab = (value: string) => {
      const params = new URLSearchParams(url.search);
      if (value === "open") params.delete("tab"); else params.set("tab", value);
      const query = params.toString();
      return `/admin/pull-requests${query ? `?${query}` : ""}`;
    };
    const tabsNav = `<nav class="tabs">${tabs.map(([value, label]) =>
      `<a class="button${tab === value ? " primary" : ""}" href="${withTab(value)}">${label}</a>`).join("")}</nav>`;
    const syncedAt = lastSynced.rows[0]?.synced;
    const syncedLabel = syncedAt ? `last ${Math.max(0, Math.round((Date.now() - new Date(syncedAt).getTime()) / 60000))} min ago` : "never synced";
    const body = `<div class="eyebrow">All configured repositories</div><h1>Pull requests</h1>
      <div class="toolbar"><button class="button" type="button" data-sync-prs>Sync all · ${escapeHtml(syncedLabel)}</button></div>
      <div class="toolbar" style="margin-top:14px;justify-content:space-between;flex-wrap:wrap">
        ${tabsNav}
        <form class="toolbar" style="flex:1;min-width:min(300px,100%);justify-content:flex-end;flex-wrap:wrap">
          <div style="display:grid;grid-template-columns:2fr 1fr;gap:10px;flex:1;min-width:min(280px,100%)">
            <input class="search" name="search" placeholder="Search title, number or ticket…" value="${escapeHtml(search)}">
            <select name="repository"><option value="">All repositories</option>${repositories.rows.map((row) => `<option value="${escapeHtml(row.repository)}"${repository === row.repository ? " selected" : ""}>${escapeHtml(row.repository)}</option>`).join("")}</select>
          </div>
          ${tab !== "open" ? `<input type="hidden" name="tab" value="${escapeHtml(tab)}">` : ""}
          <button class="button" type="submit">Filter</button><a class="button" href="/admin/pull-requests">Reset</a><span aria-live="polite">${pullRequests.rows.length} shown</span>
        </form>
      </div>
      <section class="card prs-card">
        <div data-pr-bulk-toolbar hidden style="display:flex;gap:8px;padding:12px 18px;align-items:center;border-bottom:1px solid var(--border)">
          <span>Selected: <strong data-pr-selected-count>0</strong></span>
          <span style="flex:1"></span>
          <button class="button" type="button" data-pr-bulk="ai-review">AI review</button>
          <button class="button" type="button" data-pr-bulk="close" style="border:1px solid var(--t-danger);color:var(--t-danger)">Close PR</button>
          <button class="button primary" type="button" data-pr-bulk="merge">Approve &amp; merge</button>
          <button class="button" type="button" data-pr-clear-selection>Clear</button>
        </div>
        <div class="list-head prs-head"><span class="pr-select"><input type="checkbox" data-pr-check-all aria-label="Select all pull requests"></span><span>PR</span><span>Title</span><span>Project</span><span>Merge Status</span><span>AI Status</span><span>Conflicts</span><span>Created</span><span>Actions</span></div>${rows || `<div style="padding:48px 20px;text-align:center;color:var(--text3);font-size:13.5px">No pull requests match these filters.</div>`}</section>`;
    return { status: 200, title: "Pull requests", body };
  }
  const pullRequestSlugMatch = url.pathname.match(/^\/admin\/pull-requests\/([^/]+)\/(\d+)$/);
  if (pullRequestSlugMatch) {
    const item = (await pool.query(`${detailQuery} WHERE p.slug=$1 AND pr.number=$2`, [decodeURIComponent(pullRequestSlugMatch[1]), Number(pullRequestSlugMatch[2])])).rows[0];
    const aiReviews = item ? (await pool.query("SELECT * FROM pr_ai_reviews WHERE pull_request_id=$1 ORDER BY created_at DESC", [item.id])).rows : [];
    const conflictResolutions = item ? (await pool.query("SELECT * FROM pr_conflict_resolutions WHERE pull_request_id=$1 ORDER BY created_at DESC", [item.id])).rows : [];
    const settings = await pool.query("SELECT require_fresh_policy_binding FROM pull_request_merge_settings WHERE id=1");
    return renderDetail(item, aiReviews, conflictResolutions, settings.rows[0]?.require_fresh_policy_binding === true);
  }
  const pullRequestPageMatch = url.pathname.match(/^\/admin\/pull-requests\/([0-9a-f-]+)$/i);
  if (pullRequestPageMatch) {
    const item = (await pool.query(`${detailQuery} WHERE pr.id=$1`, [pullRequestPageMatch[1]])).rows[0];
    const aiReviews = item ? (await pool.query("SELECT * FROM pr_ai_reviews WHERE pull_request_id=$1 ORDER BY created_at DESC", [item.id])).rows : [];
    const conflictResolutions = item ? (await pool.query("SELECT * FROM pr_conflict_resolutions WHERE pull_request_id=$1 ORDER BY created_at DESC", [item.id])).rows : [];
    const settings = await pool.query("SELECT require_fresh_policy_binding FROM pull_request_merge_settings WHERE id=1");
    return renderDetail(item, aiReviews, conflictResolutions, settings.rows[0]?.require_fresh_policy_binding === true);
  }
  return null;
}
