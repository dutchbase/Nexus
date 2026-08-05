import { inTransaction, pool } from "@dcc/database";

export const NOTIFICATION_EVENTS = [
  "ticket.created", "planning.started", "planning.failed", "plan.ready_for_review",
  "execution.started", "execution.completed", "pr.ready_for_review",
] as const;
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

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
  assertOwned: () => Promise<void> = async () => {},
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
  await assertOwned();
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

export async function claimNotificationDelivery(workerId: string) {
  return inTransaction(async (client) => {
    const result = await client.query(
      `WITH candidate AS (
         SELECT nd.id,np.type provider_type,np.configuration_encrypted_json
         FROM notification_deliveries nd JOIN notification_providers np ON np.id=nd.provider_id
         WHERE np.enabled=true AND nd.status IN ('queued','failed') AND nd.next_attempt_at<=now()
         ORDER BY nd.next_attempt_at,nd.created_at FOR UPDATE OF nd SKIP LOCKED LIMIT 1
       )
       UPDATE notification_deliveries nd
       SET status='sending', claimed_by=$1, lease_expires_at = now() + interval '60 seconds', updated_at=now()
       FROM candidate
       WHERE nd.id=candidate.id AND nd.status IN ('queued','failed')
       RETURNING nd.*,candidate.provider_type,candidate.configuration_encrypted_json`,
      [workerId],
    );
    return result.rows[0] ?? null;
  });
}

export async function renewNotificationDeliveryLease(id: string, workerId: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE notification_deliveries SET lease_expires_at = now() + interval '60 seconds', updated_at=now()
     WHERE id=$1 AND status='sending' AND claimed_by=$2 AND lease_expires_at > now()`,
    [id, workerId],
  );
  return result.rowCount === 1;
}

export async function completeNotificationDelivery(id: string, workerId: string, responseStatus?: number): Promise<boolean> {
  const result = await pool.query(
    `UPDATE notification_deliveries
     SET attempt_count=COALESCE(attempt_count,0)+1,status='sent',response_status=COALESCE($3,response_status),
         error_message=NULL,sent_at=now(),claimed_by=NULL,lease_expires_at=NULL,updated_at=now()
     WHERE id=$1 AND status='sending' AND claimed_by=$2 AND lease_expires_at > now()`,
    [id, workerId, responseStatus ?? null],
  );
  return result.rowCount === 1;
}

export async function failNotificationDelivery(id: string, workerId: string, error: unknown, responseStatus?: number): Promise<boolean> {
  const message = error instanceof Error ? error.message : "Notification delivery failed";
  const result = await pool.query(
    `UPDATE notification_deliveries
     SET attempt_count=COALESCE(attempt_count,0)+1,status='failed',response_status=COALESCE($4,response_status),
         error_message=$3,next_attempt_at=now() + interval '2 seconds' * power(2,LEAST(COALESCE(attempt_count,0),8)),
         claimed_by=NULL,lease_expires_at=NULL,updated_at=now()
     WHERE id=$1 AND status='sending' AND claimed_by=$2 AND lease_expires_at > now()`,
    [id, workerId, message, responseStatus ?? null],
  );
  return result.rowCount === 1;
}
