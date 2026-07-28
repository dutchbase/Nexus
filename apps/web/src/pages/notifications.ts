import { escapeHtml, pool, shortRefs } from "./shared.ts";
import type { PageResult, Session } from "./shared.ts";

const REQUIRED_EVENTS = [
  "ticket.created", "planning.started", "plan.ready_for_review",
  "execution.started", "execution.completed", "pr.ready_for_review",
];
const OPTIONAL_EVENTS = [
  "ticket.rejected", "planning.failed", "plan.revision_requested", "validation.failed",
  "pr.changes_requested", "pr.merged", "system.claude_auth_expiring", "system.worker_offline",
];

export async function render(url: URL, _session: Session, _metrics: Record<string, number>): Promise<PageResult> {
  if (url.pathname !== "/admin/notifications") return null;
  const [providers, deliveries] = await Promise.all([
    pool.query("SELECT * FROM notification_providers ORDER BY name"),
    pool.query(
      `SELECT nd.*,np.name provider FROM notification_deliveries nd
       LEFT JOIN notification_providers np ON np.id=nd.provider_id ORDER BY nd.created_at DESC LIMIT 200`,
    ),
  ]);
  const whatsapp = providers.rows.find((provider) => provider.type === "whatsapp") ?? null;
  const webhook = providers.rows.find((provider) => provider.type === "webhook") ?? null;
  const webhookConfig = webhook?.configuration_encrypted_json ?? {};
  const auth = webhookConfig.authentication ?? {};

  const eventRow = (event: string, required: boolean) =>
    `<div class="ticket-row"><span class="mono">${escapeHtml(event)}</span><span class="status">${required ? "Required" : "Optional"}</span></div>`;

  const whatsappCard = `<section class="card"><div class="card-head">WhatsApp server <span class="status">Placeholder</span></div><div class="card-body">
      <p>The API contract is not specified yet. The provider interface is implemented; only base URL, endpoint and token remain.</p>
      <p>Base URL: <span class="mono">${escapeHtml(whatsapp?.configuration_encrypted_json?.base_url ?? "not set")}</span></p>
      <p>Endpoint: <span class="mono">${escapeHtml(whatsapp?.configuration_encrypted_json?.endpoint ?? "not set")}</span></p>
      <p>State: ${whatsapp?.enabled ? "Enabled" : "Disabled"}</p>
    </div></section>`;

  const webhookCard = `<section class="card"><div class="card-head">Generic webhook <span class="status">${webhook?.enabled ? "Enabled" : "Disabled"}</span></div><div class="card-body">
      <form data-webhook-provider-form data-provider-id="${webhook?.id ?? ""}">
        <label class="field"><span>Name</span><input name="name" value="${escapeHtml(webhook?.name ?? "Generic webhook")}" required></label>
        <label class="field"><span>Base URL</span><input name="base_url" value="${escapeHtml(webhookConfig.base_url ?? "")}" placeholder="https://ops-hooks.internal"></label>
        <label class="field"><span>Endpoint</span><input name="endpoint" value="${escapeHtml(webhookConfig.endpoint ?? "")}" placeholder="/dcc"></label>
        <label class="field"><span>Auth type</span><select name="auth_type"><option value="none"${auth.type === "none" || !auth.type ? " selected" : ""}>None</option><option value="bearer"${auth.type === "bearer" ? " selected" : ""}>Bearer</option><option value="header"${auth.type === "header" ? " selected" : ""}>Header key</option></select></label>
        <label class="field"><span>Secret reference</span><input name="secret_reference" class="mono" value="${escapeHtml(auth.secret_reference ?? "")}" placeholder="WHATSAPP_SERVER_API_TOKEN"></label>
        <label class="field"><span>Timeout (s)</span><input name="timeout_seconds" type="number" value="${webhookConfig.timeout_seconds ?? 10}"></label>
        <label class="field"><span>Max attempts</span><input name="max_attempts" type="number" value="${webhookConfig.max_attempts ?? 5}"></label>
        <label style="display:flex;gap:9px;align-items:center;font-size:13px;margin:10px 0"><input type="checkbox" name="enabled"${webhook?.enabled ?? true ? " checked" : ""}> Enable provider</label>
        <button class="button primary" type="submit">Save</button>
        <button class="button" type="button" data-test-provider${webhook ? "" : " disabled"}>Send test notification</button>
        <p class="error" role="alert"></p>
      </form>
    </div></section>`;

  const deliveryLabels = shortRefs("ND", deliveries.rows);
  const deliveryRows = deliveries.rows.map((delivery) =>
    `<div class="ticket-row"><span class="mono">${deliveryLabels.get(delivery.id)}</span><span>${escapeHtml(delivery.event_type ?? "")}</span><span>${escapeHtml(delivery.provider ?? "")}</span><span class="status">${escapeHtml(delivery.status ?? "")}</span><span>${delivery.response_status ?? ""}</span><span>${escapeHtml(delivery.error_message ?? "")}</span>${delivery.status === "failed" ? `<button class="button" type="button" data-retry-delivery="${delivery.id}">Retry</button>` : ""}</div>`,
  ).join("");

  const body = `<div class="eyebrow">Event-driven · provider independent</div><h1>Notifications</h1>
      <div class="tabs" role="tablist">${["Event rules", "Providers", "Templates", "Deliveries"].map((label, index) => `<button type="button" role="tab" id="tab-${index}" aria-controls="panel-${index}" aria-selected="${index === 0}">${label}</button>`).join("")}</div>
      <div role="tabpanel" id="panel-3" aria-labelledby="tab-3" hidden><section class="card"><div class="list-head"><span>Delivery</span><span>Event</span><span>Provider</span><span>Status</span><span>HTTP</span><span>Error</span></div>${deliveryRows || '<div class="card-body"><p>No deliveries yet.</p></div>'}</section></div>
      <div role="tabpanel" id="panel-1" aria-labelledby="tab-1" hidden class="grid two">${whatsappCard}${webhookCard}</div>
      <div role="tabpanel" id="panel-2" aria-labelledby="tab-2" hidden><section class="card"><div class="card-body"><p>Message templates use {{ticket.number}}-style placeholders, rendered literally.</p></div></section></div>
      <div role="tabpanel" id="panel-0" aria-labelledby="tab-0"><section class="card"><div class="card-head">Event rules</div><div class="card-body">
        <p>The required workflow events notify through the configured provider. Delivery problems never block the ticket workflow. Muting individual events is not yet supported.</p>
        ${REQUIRED_EVENTS.map((event) => eventRow(event, true)).join("")}${OPTIONAL_EVENTS.map((event) => eventRow(event, false)).join("")}
      </div></section></div>`;
  return { status: 200, title: "Notifications", body };
}
