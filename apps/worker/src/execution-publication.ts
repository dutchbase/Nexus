export class PublicationError extends Error {}

export type FailureState = "failed" | "published" | "missing";
type Client = { query: (sql: string, values?: any[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

export async function failExecutionPublication(
  client: Client,
  input: { attemptId: string; jobId: string; errorMessage: string; reason: string },
): Promise<FailureState> {
  const publication = (await client.query(
    `SELECT ep.id,ep.status,ea.ticket_id,ea.agent_run_id,ea.plan_version_id
     FROM execution_publications ep
     JOIN execution_attempts ea ON ea.id=ep.execution_attempt_id
     WHERE ep.execution_attempt_id=$1 FOR UPDATE OF ep,ea`,
    [input.attemptId],
  )).rows[0];
  if (!publication) return "missing";
  if (publication.status === "published") return "published";
  if (publication.status === "failed") return "failed";

  const transitioned = await client.query(
    `UPDATE execution_publications
     SET status='failed',error_message=$2,updated_at=now()
     WHERE id=$1 AND status IN ('pending','publishing') RETURNING id`,
    [publication.id, input.errorMessage],
  );
  if (transitioned.rowCount !== 1) return "failed";
  await client.query(
    "UPDATE execution_attempts SET validation_status='pr_creation_failed',completed_at=now() WHERE id=$1",
    [input.attemptId],
  );
  if (publication.agent_run_id) {
    await client.query(
      "UPDATE agent_runs SET status='failed',error_code='pr_creation_failed',error_message=$2 WHERE id=$1",
      [publication.agent_run_id, input.errorMessage],
    );
  }
  const ticket = (await client.query("SELECT status FROM tickets WHERE id=$1 FOR UPDATE", [publication.ticket_id])).rows[0];
  if (ticket && ticket.status !== "PR Creation Failed") {
    await client.query("UPDATE tickets SET status='PR Creation Failed',updated_at=now() WHERE id=$1", [publication.ticket_id]);
    await client.query(
      `INSERT INTO ticket_status_history
       (ticket_id,previous_status,new_status,reason,actor_type,related_job_id,related_run_id,related_plan_version_id)
       VALUES ($1,$2,'PR Creation Failed',$3,'worker',$4,$5,$6)`,
      [publication.ticket_id, ticket.status, input.reason, input.jobId, publication.agent_run_id, publication.plan_version_id],
    );
  }
  await client.query(
    `INSERT INTO audit_events (actor_type,action,entity_type,entity_id,after_json)
     VALUES ('worker','execution.publication.failed','execution_publication',$1,$2)`,
    [publication.id, { error: input.errorMessage, job_id: input.jobId }],
  );
  return "failed";
}

export async function publishExternalResult<T>(input: {
  push: () => Promise<void>;
  find: () => Promise<T | null>;
  create: () => Promise<T>;
  complete: (pullRequest: T) => Promise<void>;
  fail: (error: Error) => Promise<FailureState>;
}): Promise<void> {
  try {
    await input.push();
    const pullRequest = await input.find() ?? await input.create();
    await input.complete(pullRequest);
  } catch (error) {
    const cause = error instanceof Error ? error : new Error(String(error));
    if (await input.fail(cause) === "published") return;
    throw new PublicationError(cause.message);
  }
}
