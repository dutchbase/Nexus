import type { ProviderPullRequest } from "@dcc/github-provider";

export class PublicationError extends Error {}

export type FailureState = "failed" | "published" | "published_by_other_job" | "missing" | "retryable";
type Client = { query: (sql: string, values?: any[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

export async function storePublishedPullRequest(client: Client, input: {
  projectId: string;
  ticketId: string;
  attemptId: string;
  repository: string;
  pullRequest: ProviderPullRequest;
  commit: string;
  changedFiles: number;
}) {
  const pullRequest = input.pullRequest;
  return (await client.query(
    `INSERT INTO pull_requests
     (project_id,ticket_id,execution_attempt_id,provider,repository,number,url,title,author,state,
      is_draft,head_branch,base_branch,head_sha,merge_commit_sha,created_at_provider,
      updated_at_provider,merged_at,closed_at,last_synced_at,changed_files)
     VALUES ($1,$2,$3,'github',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,now(),$19)
     ON CONFLICT (project_id,number) DO UPDATE SET
       ticket_id=COALESCE(pull_requests.ticket_id, EXCLUDED.ticket_id),
       execution_attempt_id=COALESCE(pull_requests.execution_attempt_id, EXCLUDED.execution_attempt_id),
       url=EXCLUDED.url,title=EXCLUDED.title,author=EXCLUDED.author,state=EXCLUDED.state,
       is_draft=EXCLUDED.is_draft,head_branch=EXCLUDED.head_branch,base_branch=EXCLUDED.base_branch,
       head_sha=EXCLUDED.head_sha,merge_commit_sha=EXCLUDED.merge_commit_sha,
       created_at_provider=EXCLUDED.created_at_provider,updated_at_provider=EXCLUDED.updated_at_provider,
       merged_at=EXCLUDED.merged_at,closed_at=EXCLUDED.closed_at,last_synced_at=now(),
       changed_files=EXCLUDED.changed_files,updated_at=now()
     RETURNING *`,
    [input.projectId, input.ticketId, input.attemptId, input.repository,
     pullRequest.number, pullRequest.html_url, pullRequest.title, pullRequest.user?.login ?? null,
     pullRequest.state, false, pullRequest.head.ref, pullRequest.base.ref, input.commit,
     pullRequest.merge_commit_sha ?? null, pullRequest.created_at, pullRequest.updated_at,
     pullRequest.merged_at ?? null, pullRequest.closed_at ?? null, input.changedFiles],
  )).rows[0];
}

export async function prepareExecutionPublication(
  client: Client,
  input: { attemptId: string; jobId: string; commit: string; committedNow: boolean },
) {
  const intent = (await client.query(
    `INSERT INTO execution_publications (execution_attempt_id,idempotency_key,status)
     VALUES ($1,$2,'pending')
     ON CONFLICT (execution_attempt_id) DO UPDATE
     SET updated_at=execution_publications.updated_at
     RETURNING *`,
    [input.attemptId, `execution-publication:${input.attemptId}`],
  )).rows[0];
  if (intent.status === "published" && intent.last_job_id === input.jobId) return intent;

  await client.query(
    "UPDATE execution_attempts SET result_commit=$2,validation_status='validated' WHERE id=$1",
    [input.attemptId, input.commit],
  );
  if (input.committedNow) {
    await client.query(
      `INSERT INTO audit_events (actor_type,action,entity_type,entity_id,after_json)
       VALUES ('worker','execution.commit','execution_attempt',$1,$2)`,
      [input.attemptId, { commit: input.commit }],
    );
  }
  if (intent.status !== "published") return intent;

  const reset = await client.query(
    `UPDATE execution_publications
     SET status='pending',last_job_id=NULL,error_message=NULL,published_at=NULL,updated_at=now()
     WHERE id=$1 AND status='published' AND last_job_id IS DISTINCT FROM $2
     RETURNING *`,
    [intent.id, input.jobId],
  );
  if (reset.rowCount !== 1) throw new Error("published execution belongs to the current job");
  return reset.rows[0];
}

export async function failExecutionPublication(
  client: Client,
  input: { attemptId: string; jobId: string; errorMessage: string; reason: string; preserveRetryable?: boolean },
): Promise<FailureState> {
  const publication = (await client.query(
    `SELECT ep.id,ep.status,ep.last_job_id,ea.ticket_id,ea.agent_run_id,ea.plan_version_id
     FROM execution_publications ep
     JOIN execution_attempts ea ON ea.id=ep.execution_attempt_id
     WHERE ep.execution_attempt_id=$1 FOR UPDATE OF ep,ea`,
    [input.attemptId],
  )).rows[0];
  if (!publication) return "missing";
  if (publication.status === "published") return publication.last_job_id === input.jobId ? "published" : "published_by_other_job";
  if (publication.status === "failed") {
    if (!input.preserveRetryable) return "failed";
    const reopened = await client.query(
      `UPDATE execution_publications
       SET status='pending',last_job_id=NULL,error_message=NULL,published_at=NULL,updated_at=now()
       WHERE id=$1 AND status='failed' RETURNING id`,
      [publication.id],
    );
    return reopened.rowCount === 1 ? "retryable" : "failed";
  }
  if (input.preserveRetryable) return "retryable";

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

export async function handleExecutionPublicationFailure(
  error: unknown,
  fail: (error: Error) => Promise<FailureState>,
): Promise<void> {
  const cause = error instanceof Error ? error : new Error(String(error));
  const state = await fail(cause);
  if (state === "published") return;
  if (state === "missing" || state === "published_by_other_job") throw cause;
  throw new PublicationError(cause.message);
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
    await handleExecutionPublicationFailure(error, input.fail);
  }
}
