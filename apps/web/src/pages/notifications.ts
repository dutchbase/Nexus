import { escapeHtml, pool, shortRefs } from "./shared.ts";
import type { PageResult, Session } from "./shared.ts";

export async function render(url: URL, _session: Session, _metrics: Record<string, number>): Promise<PageResult> {
  if (url.pathname !== "/admin/notifications") return null;
  const [providers, deliveries] = await Promise.all([
    pool.query("SELECT * FROM notification_providers ORDER BY name"),
    pool.query(
      `SELECT nd.*,np.name provider FROM notification_deliveries nd
       LEFT JOIN notification_providers np ON np.id=nd.provider_id ORDER BY nd.created_at DESC LIMIT 200`,
    ),
  ]);
  const providerPanel = providers.rows.map((provider) =>
    `<section class="card"><div class="card-head">${escapeHtml(provider.name)}${provider.type === "whatsapp" ? " · Placeholder" : ""}</div><div class="card-body"><p>Type: ${escapeHtml(provider.type)} · ${provider.enabled ? "Enabled" : "Disabled"}</p></div></section>`,
  ).join("") || "<p>No providers configured.</p>";
  const deliveryLabels = shortRefs("ND", deliveries.rows);
  const deliveryRows = deliveries.rows.map((delivery) =>
    `<div class="ticket-row"><span class="mono">${deliveryLabels.get(delivery.id)}</span><span>${escapeHtml(delivery.event_type ?? "")}</span><span>${escapeHtml(delivery.provider ?? "")}</span><span class="status">${escapeHtml(delivery.status ?? "")}</span><span>${delivery.response_status ?? ""}</span><span>${escapeHtml(delivery.error_message ?? "")}</span></div>`,
  ).join("");
  const body = `<div class="eyebrow">Operate</div><h1>Notifications</h1>
      <div class="tabs" role="tablist">${["Event rules", "Providers", "Templates", "Deliveries"].map((label, index) => `<button type="button" role="tab" id="tab-${index}" aria-controls="panel-${index}" aria-selected="${index === 0}">${label}</button>`).join("")}</div>
      <div role="tabpanel" id="panel-0" aria-labelledby="tab-0"><section class="card"><div class="card-body"><p>The required workflow events notify through the configured provider. Delivery problems never block the ticket workflow.</p></div></section></div>
      <div role="tabpanel" id="panel-1" aria-labelledby="tab-1" hidden>${providerPanel}</div>
      <div role="tabpanel" id="panel-2" aria-labelledby="tab-2" hidden><section class="card"><div class="card-body"><p>Message templates use {{ticket.number}}-style placeholders, rendered literally.</p></div></section></div>
      <div role="tabpanel" id="panel-3" aria-labelledby="tab-3" hidden><section class="card"><div class="list-head"><span>Delivery</span><span>Event</span><span>Provider</span><span>Status</span><span>HTTP</span><span>Error</span></div>${deliveryRows || '<div class="card-body"><p>No deliveries yet.</p></div>'}</section></div>`;
  return { status: 200, title: "Notifications", body };
}
