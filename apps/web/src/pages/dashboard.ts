import type { PageResult, Session } from "./shared.ts";

export async function render(url: URL, _session: Session, metrics: Record<string, number>): Promise<PageResult> {
  if (url.pathname !== "/admin") return null;
  const body = `<div class="eyebrow">Overview</div><h1>Things that need your attention.</h1><div class="grid two"><section class="card"><div class="card-head">Open tickets</div><div class="card-body"><h2>${metrics.tickets}</h2><a class="button" href="/admin/tickets">Open triage</a></div></section><section class="card"><div class="card-head">Job queue</div><div class="card-body"><h2>${metrics.jobs}</h2><p>Queued and running jobs</p></div></section></div>`;
  return { status: 200, title: "Dashboard", body };
}
