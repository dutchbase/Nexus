import { randomUUID } from "node:crypto";
import { enqueueJob } from "./index.ts";

export type JamState = "queued" | "fetching" | "ready" | "partial" | "failed" | "not_configured";
export type JamErrorCode = "not_configured" | "access_denied" | "not_found" | "rate_limited" | "timeout" | "unavailable" | "unsupported_schema" | "invalid_response";
export type JamSource = { id: string; url: string };
export type JamEvidence = { source_url: string; generation: string; state: JamState; data_json: unknown; content_hash: string | null; error_code: JamErrorCode | null; fetched_at: string | null };
type QueryClient = { query: (sql: string, values?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

const invalid = (): never => { throw Object.assign(new Error("invalid Jam link"), { status: 422 }); };

export function normalizeJamUrl(value: unknown): JamSource | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || value.length > 2048) return invalid();
  const trimmed = value.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try { parsed = new URL(trimmed); } catch { return invalid(); }
  const match = /^\/c\/([A-Za-z0-9_-]{1,128})\/?$/.exec(parsed.pathname);
  if (parsed.protocol !== "https:" || parsed.hostname !== "jam.dev" || parsed.username || parsed.password || parsed.port || !match) return invalid();
  return { id: match[1], url: `https://jam.dev/c/${match[1]}` };
}

export async function setTicketJamSource(client: QueryClient, ticketId: string, value: unknown): Promise<void> {
  const source = normalizeJamUrl(value);
  const ticket = (await client.query("SELECT jam_url FROM tickets WHERE id=$1 FOR UPDATE", [ticketId])).rows[0];
  if (!ticket) throw Object.assign(new Error("ticket not found"), { status: 404 });
  if ((ticket.jam_url ?? null) === source?.url) return;
  await client.query("UPDATE tickets SET jam_url=$2 WHERE id=$1", [ticketId, source?.url ?? null]);
  if (!source) await client.query("DELETE FROM ticket_jam_contexts WHERE ticket_id=$1", [ticketId]);
  else {
    const generation = randomUUID();
    await client.query(
      `INSERT INTO ticket_jam_contexts(ticket_id,source_url,generation,state,data_json,content_hash,error_code,fetched_at,updated_at)
       VALUES($1,$2,$3,'queued',NULL,NULL,NULL,NULL,now())
       ON CONFLICT(ticket_id) DO UPDATE SET source_url=excluded.source_url,generation=excluded.generation,state='queued',
         data_json=NULL,content_hash=NULL,error_code=NULL,fetched_at=NULL,updated_at=now()`,
      [ticketId, source.url, generation],
    );
    await enqueueJob({ type: "ticket.jam_enrich", payload: { ticket_id: ticketId, generation }, idempotencyKey: `ticket-jam:${ticketId}:${generation}`, maxAttempts: 3 }, client as any);
  }
  await client.query("SELECT mark_ticket_plan_potentially_stale($1)", [ticketId]);
}

export async function queueJamRetry(client: QueryClient, ticketId: string): Promise<void> {
  const context = (await client.query("SELECT source_url FROM ticket_jam_contexts WHERE ticket_id=$1 FOR UPDATE", [ticketId])).rows[0];
  if (!context) throw Object.assign(new Error("Jam link not found"), { status: 404 });
  const generation = randomUUID();
  await client.query(
    "UPDATE ticket_jam_contexts SET generation=$2,state='queued',data_json=NULL,content_hash=NULL,error_code=NULL,fetched_at=NULL,updated_at=now() WHERE ticket_id=$1",
    [ticketId, generation],
  );
  await enqueueJob({ type: "ticket.jam_enrich", payload: { ticket_id: ticketId, generation }, idempotencyKey: `ticket-jam:${ticketId}:${generation}`, maxAttempts: 3 }, client as any);
}

export async function ticketJamEvidence(client: QueryClient, ticketId: string): Promise<JamEvidence | null> {
  return (await client.query(
    "SELECT source_url,generation,state,data_json,content_hash,error_code,fetched_at FROM ticket_jam_contexts WHERE ticket_id=$1",
    [ticketId],
  )).rows[0] ?? null;
}
