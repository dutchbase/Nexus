import { escapeHtml, keysetCondition, nextCursor, pageRequest, pagerHtml, pool, promptVersionsLabel } from "./shared.ts";
import type { PageResult, Session } from "./shared.ts";
import { aiInvocationPhases, aiLifecycleGroup } from "@dcc/domain";

function usd(value: unknown) {
  if (value == null) return "Not captured";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 8 }).format(Number(value));
}

function usageLabel(status: string | null) {
  return status === "captured" ? "Captured" : status === "pending" ? "Pending" : "Not captured";
}

function billingModeLabel(mode: string | null) {
  return mode === "api" ? "Metered API" : mode === "subscription" ? "Subscription" : "—";
}

function filters(url: URL) {
  const values: unknown[] = [aiInvocationPhases];
  const conditions: string[] = ["ar.run_type = ANY($1::text[])"];
  const allTime = url.searchParams.get("all_time") === "1";
  const from = url.searchParams.get("from") || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const to = url.searchParams.get("to") || "";
  if (!allTime) { values.push(`${from}T00:00:00.000Z`); conditions.push(`ar.started_at >= $${values.length}`); }
  if (to) { values.push(`${to}T00:00:00.000Z`); conditions.push(`ar.started_at < $${values.length} + interval '1 day'`); }
  const project = url.searchParams.get("project");
  if (project) { values.push(`%${project}%`); conditions.push(`(p.slug ILIKE $${values.length} OR p.name ILIKE $${values.length})`); }
  const lifecycle = url.searchParams.get("lifecycle");
  if (lifecycle === "planning" || lifecycle === "execution" || lifecycle === "pr_work") {
    values.push(aiInvocationPhases.filter((runType) => aiLifecycleGroup(runType) === lifecycle));
    conditions.push(`ar.run_type = ANY($${values.length}::text[])`);
  }
  for (const [param, column] of [["run_type", "ar.run_type"], ["model", "ar.model"], ["usage_status", "ar.ai_usage_status"], ["billing_mode", "ar.billing_mode"]] as const) {
    const value = url.searchParams.get(param);
    if (value) { values.push(value); conditions.push(`${column} = $${values.length}`); }
  }
  const search = url.searchParams.get("search");
  if (search) { values.push(`%${search}%`); conditions.push(`(t.ticket_number ILIKE $${values.length} OR pr.number::text ILIKE $${values.length} OR pr.url ILIKE $${values.length})`); }
  return { values, conditions, allTime, from, to };
}

export async function render(url: URL, _session: Session, _metrics: Record<string, number>): Promise<PageResult> {
  if (url.pathname !== "/admin/ai-usage") return null;
  const { values, conditions, allTime, from, to } = filters(url);
  const { limit, cursor } = pageRequest(url);
  const listValues = [...values];
  const keyset = keysetCondition(cursor, "ar.started_at", "ar.id", listValues);
  if (keyset) conditions.push(keyset);
  listValues.push(limit);
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const summaryWhere = filters(url);
  const summaryClause = summaryWhere.conditions.length ? `WHERE ${summaryWhere.conditions.join(" AND ")}` : "";
  const [runsResult, totalsResult] = await Promise.all([
    pool.query(`SELECT ar.id,ar.started_at,ar.run_type,ar.model,ar.provider,ar.billing_mode,ar.ai_usage_status,ar.input_tokens,ar.output_tokens,ar.reasoning_tokens,ar.cache_read_tokens,ar.cache_write_tokens,ar.total_tokens,ar.estimated_cost_usd,
      t.ticket_number,p.name project_name,pr.id pr_id,pr.number pr_number,pr.url pr_url,ps.phase prompt_name,ps.metadata_json->'promptVersionIds' prompt_versions
      FROM agent_runs ar LEFT JOIN tickets t ON t.id=ar.ticket_id LEFT JOIN projects p ON p.id=ar.project_id LEFT JOIN pull_requests pr ON pr.id=ar.pull_request_id LEFT JOIN prompt_snapshots ps ON ps.id=ar.prompt_snapshot_id
      ${where} ORDER BY ar.started_at DESC, ar.id DESC LIMIT $${listValues.length}`, listValues),
    pool.query(`SELECT count(*)::integer AS invocations, COALESCE(sum(ar.total_tokens) FILTER (WHERE ar.ai_usage_status='captured'),0)::bigint AS captured_tokens,
      COALESCE(sum(ar.estimated_cost_usd) FILTER (WHERE ar.ai_usage_status='captured' AND ar.billing_mode='api'),0)::numeric AS metered_cost_usd,
      COALESCE(sum(ar.estimated_cost_usd) FILTER (WHERE ar.ai_usage_status='captured' AND ar.billing_mode='subscription'),0)::numeric AS subscription_cost_usd,
      count(*) FILTER (WHERE ar.ai_usage_status IS DISTINCT FROM 'captured' OR (ar.ai_usage_status='captured' AND ar.estimated_cost_usd IS NULL))::integer AS coverage_exceptions
      FROM agent_runs ar LEFT JOIN tickets t ON t.id=ar.ticket_id LEFT JOIN projects p ON p.id=ar.project_id LEFT JOIN pull_requests pr ON pr.id=ar.pull_request_id ${summaryClause}`, summaryWhere.values),
  ]);
  const totals = totalsResult.rows[0] ?? { invocations: 0, captured_tokens: 0, metered_cost_usd: 0, subscription_cost_usd: 0, coverage_exceptions: 0 };
  const runs = runsResult.rows;
  const rows = runs.map((run) => `<div class="ticket-row"><a href="/admin/runs/${escapeHtml(run.id)}">${escapeHtml(run.started_at ? new Date(run.started_at).toLocaleString("nl-NL") : "Not started")}</a><strong>${escapeHtml(run.run_type ?? "—")}</strong><span>${escapeHtml(run.model ?? "—")} · ${escapeHtml(run.provider ?? "—")}</span><span>${billingModeLabel(run.billing_mode)}</span><span>${run.ai_usage_status === "captured" ? `${escapeHtml(run.input_tokens)} in · ${escapeHtml(run.output_tokens)} out · ${escapeHtml(run.total_tokens)} total` : "Not captured"}</span><span>${escapeHtml(usd(run.estimated_cost_usd))}</span><span>${run.ticket_number ? `<a href="/admin/tickets/${escapeHtml(encodeURIComponent(run.ticket_number))}">${escapeHtml(run.ticket_number)}</a>` : "—"}${run.pr_id ? ` · <a href="/admin/pull-requests/${escapeHtml(run.pr_id)}">PR #${escapeHtml(run.pr_number)}</a>` : ""}</span><span>${escapeHtml(run.prompt_name ?? "—")}${promptVersionsLabel(run.prompt_versions) ? ` · ${escapeHtml(promptVersionsLabel(run.prompt_versions))}` : ""}</span><span class="status">${usageLabel(run.ai_usage_status)}</span></div>`).join("");
  const input = (name: string, value: string, type = "text") => `<input type="${type}" name="${name}" value="${escapeHtml(value)}">`;
  const body = `<div class="eyebrow">Operate</div><h1>AI usage</h1>
    <section class="grid two"><div class="card"><div class="card-body"><div class="eyebrow">Invocations</div><strong>${escapeHtml(totals.invocations)}</strong></div></div><div class="card"><div class="card-body"><div class="eyebrow">Captured tokens</div><strong>${escapeHtml(totals.captured_tokens)}</strong></div></div><div class="card"><div class="card-body"><div class="eyebrow">Metered API cost</div><strong>${escapeHtml(usd(totals.metered_cost_usd))}</strong></div></div><div class="card"><div class="card-body"><div class="eyebrow">Subscription-equivalent cost</div><strong>${escapeHtml(usd(totals.subscription_cost_usd))}</strong></div></div><div class="card"><div class="card-body"><div class="eyebrow">Coverage exceptions</div><strong>${escapeHtml(totals.coverage_exceptions)}</strong></div></div></section>
    <form class="toolbar" style="margin-top:16px;display:flex;gap:8px;flex-wrap:wrap"><label>From ${input("from", from, "date")}</label><label>To ${input("to", to, "date")}</label><label>Project ${input("project", url.searchParams.get("project") ?? "")}</label><label>Lifecycle <select name="lifecycle"><option value="">All</option>${["planning", "execution", "pr_work"].map((value) => `<option value="${value}"${url.searchParams.get("lifecycle") === value ? " selected" : ""}>${value === "pr_work" ? "PR work" : value}</option>`).join("")}</select></label><label>Run type ${input("run_type", url.searchParams.get("run_type") ?? "")}</label><label>Model ${input("model", url.searchParams.get("model") ?? "")}</label><label>Usage status ${input("usage_status", url.searchParams.get("usage_status") ?? "")}</label><label>Billing <select name="billing_mode"><option value="">All</option>${["subscription", "api"].map((value) => `<option value="${value}"${url.searchParams.get("billing_mode") === value ? " selected" : ""}>${value === "api" ? "Metered API" : "Subscription"}</option>`).join("")}</select></label><label>Ticket / PR ${input("search", url.searchParams.get("search") ?? "", "search")}</label><label><input type="checkbox" name="all_time" value="1"${allTime ? " checked" : ""}> All time</label><button class="button" type="submit">Filter</button><a class="button" href="/admin/ai-usage">Reset</a></form>
    <section class="card"><div class="list-head"><span>Started</span><span>Lifecycle</span><span>Model / provider</span><span>Billing</span><span>Tokens</span><span>Cost</span><span>Ticket / PR</span><span>Prompt</span><span>Status</span></div>${rows || `<div class="card-body">No AI invocations match these filters.</div>`}</section>${pagerHtml(url, nextCursor(runs, limit, "started_at"))}`;
  return { status: 200, title: "AI usage", body };
}
