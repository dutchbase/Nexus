import { completeJob, failJob } from "@dcc/domain";
import { inTransaction } from "@dcc/database";
import { normalizeJamUrl } from "../../../packages/domain/src/ticket-jam.ts";
import { fetchJamContext, JamImportError, type JamImportResult } from "./jam-client.ts";

export type JamJob = {
  id: string;
  type: string;
  attempt: number;
  max_attempts: number;
  claimed_by?: string;
  payload_json: Record<string, unknown>;
};

type Lease = { signal: AbortSignal; assertOwned(): Promise<void> };
type Fetcher = (source: { id: string; url: string }, options: { token: string; signal: AbortSignal }) => Promise<JamImportResult>;

function input(job: JamJob) {
  const ticketId = job.payload_json.ticket_id;
  const generation = job.payload_json.generation;
  if (typeof ticketId !== "string" || typeof generation !== "string") throw new JamImportError("invalid_response", false);
  return { ticketId, generation };
}

export async function runJamEnrichment(job: JamJob, lease: Lease, fetcher: Fetcher = fetchJamContext): Promise<void> {
  const { ticketId, generation } = input(job);
  const sourceUrl = await inTransaction(async (client) => {
    await lease.assertOwned();
    if (job.claimed_by && !(await client.query(
      "SELECT 1 FROM jobs WHERE id=$1 AND status='running' AND claimed_by=$2 AND lease_expires_at>now() FOR UPDATE",
      [job.id, job.claimed_by],
    )).rowCount) return null;
    const row = (await client.query(
      `SELECT c.source_url FROM ticket_jam_contexts c JOIN tickets t ON t.id=c.ticket_id
       WHERE c.ticket_id=$1 AND c.generation=$2 AND c.source_url=t.jam_url
         AND t.submitter_deleted_at IS NULL FOR UPDATE OF c,t`,
      [ticketId, generation],
    )).rows[0];
    if (!row) return null;
    await client.query(
      "UPDATE ticket_jam_contexts SET state='fetching',error_code=NULL,updated_at=now() WHERE ticket_id=$1 AND generation=$2",
      [ticketId, generation],
    );
    return row.source_url as string;
  });
  if (!sourceUrl) return;

  const token = process.env.DCC_JAM_TOKEN;
  if (!token) throw new JamImportError("not_configured", false);
  const source = normalizeJamUrl(sourceUrl);
  if (!source) throw new JamImportError("invalid_response", false);
  const result = await fetcher(source, { token, signal: lease.signal });

  await inTransaction(async (client) => {
    await lease.assertOwned();
    if (job.claimed_by && !(await client.query(
      "SELECT 1 FROM jobs WHERE id=$1 AND status='running' AND claimed_by=$2 AND lease_expires_at>now() FOR UPDATE",
      [job.id, job.claimed_by],
    )).rowCount) return;
    const current = (await client.query(
      `SELECT c.content_hash FROM ticket_jam_contexts c JOIN tickets t ON t.id=c.ticket_id
       WHERE c.ticket_id=$1 AND c.generation=$2 AND c.source_url=t.jam_url
         AND t.submitter_deleted_at IS NULL FOR UPDATE OF c,t`,
      [ticketId, generation],
    )).rows[0];
    if (!current) return;
    const materialChange = current.content_hash !== result.contentHash;
    await client.query(
      `UPDATE ticket_jam_contexts SET state=$3,data_json=$4,content_hash=$5,error_code=NULL,
         fetched_at=now(),updated_at=now() WHERE ticket_id=$1 AND generation=$2`,
      [ticketId, generation, result.state, result.evidence, result.contentHash],
    );
    if (materialChange) {
      await client.query("SELECT mark_ticket_plan_potentially_stale($1)", [ticketId]);
      await client.query("UPDATE tickets SET updated_at=now() WHERE id=$1", [ticketId]);
    }
  });
}

export async function failJamEnrichment(job: JamJob, workerId: string, error: JamImportError, lease: Lease): Promise<void> {
  const { ticketId, generation } = input(job);
  await inTransaction(async (client) => {
    await lease.assertOwned();
    if (!error.retryable) {
      const completed = await completeJob(job.id, workerId, client);
      if (!completed) return;
      await client.query(
        `UPDATE ticket_jam_contexts c SET state=$3,error_code=$4,updated_at=now()
         FROM tickets t WHERE c.ticket_id=t.id AND c.ticket_id=$1 AND c.generation=$2
           AND c.source_url=t.jam_url AND t.submitter_deleted_at IS NULL`,
        [ticketId, generation, error.code === "not_configured" ? "not_configured" : "failed", error.code],
      );
      return;
    }
    if (!(await failJob(job.id, workerId, error, client))) return;
    if (error.retryAfterSeconds) {
      await client.query(
        "UPDATE jobs SET available_at=GREATEST(available_at,now()+make_interval(secs=>$2)) WHERE id=$1 AND status='queued'",
        [job.id, Math.min(300, Math.max(0, error.retryAfterSeconds))],
      );
    }
    await client.query(
      `UPDATE ticket_jam_contexts c SET state=$3,error_code=$4,updated_at=now()
       FROM tickets t WHERE c.ticket_id=t.id AND c.ticket_id=$1 AND c.generation=$2
         AND c.source_url=t.jam_url AND t.submitter_deleted_at IS NULL`,
      [ticketId, generation, job.attempt < job.max_attempts ? "queued" : "failed", error.code],
    );
  });
}
