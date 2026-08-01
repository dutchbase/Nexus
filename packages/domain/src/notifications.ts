export type NotificationEvent =
  | "ticket.created" | "planning.started" | "planning.failed" | "plan.ready_for_review"
  | "execution.started" | "execution.completed" | "pr.ready_for_review";

export function buildNotificationPayload(input: {
  event: NotificationEvent;
  occurredAt?: Date;
  ticket: { id: string; ticket_number: string; title: string; status: string; priority: string };
  project: { id: string; name: string };
  run?: { id: string; run_type: string; model: string; reasoning_level: string } | null;
  dashboardUrl?: string;
}) {
  return {
    event: input.event,
    occurredAt: (input.occurredAt ?? new Date()).toISOString(),
    ticket: {
      id: input.ticket.id, number: input.ticket.ticket_number, title: input.ticket.title,
      status: input.ticket.status, priority: input.ticket.priority,
    },
    project: { id: input.project.id, name: input.project.name },
    ...(input.run ? {
      run: {
        id: input.run.id, type: input.run.run_type,
        model: input.run.model, reasoningLevel: input.run.reasoning_level,
      },
    } : {}),
    dashboardUrl: input.dashboardUrl
      ?? `${process.env.APP_BASE_URL ?? "http://127.0.0.1:3000"}/admin/tickets/${input.ticket.ticket_number}`,
  };
}

export async function enqueueNotification(
  client: { query: (text: string, values?: unknown[]) => Promise<any> },
  event: NotificationEvent,
  ticketId: string,
  entityId: string,
  options: { runId?: string | null; pullRequestId?: string | null } = {},
) {
  const row = (await client.query(
    `SELECT t.id,t.ticket_number,t.title,t.status,t.priority,p.id project_id,p.name project_name,
            ar.id run_id,ar.run_type,ar.model,ar.reasoning_level
     FROM tickets t JOIN projects p ON p.id=t.project_id
     LEFT JOIN agent_runs ar ON ar.id=$2
     WHERE t.id=$1`,
    [ticketId, options.runId ?? null],
  )).rows[0];
  if (!row) return;
  const payload = buildNotificationPayload({
    event,
    ticket: row,
    project: { id: row.project_id, name: row.project_name },
    run: row.run_id ? row : null,
  });
  await client.query(
    `INSERT INTO notification_deliveries
       (provider_id,event_type,ticket_id,project_id,run_id,pull_request_id,idempotency_key,payload_json,status,attempt_count)
     SELECT np.id,$1,$2,$3,$4,$5,$6 || ':' || np.id,$7,'queued',0
     FROM notification_providers np WHERE np.enabled=true
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [event, ticketId, row.project_id, options.runId ?? null, options.pullRequestId ?? null,
      `${event}:${entityId}`, payload],
  );
}
