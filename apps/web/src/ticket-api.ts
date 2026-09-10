import type { IncomingMessage, ServerResponse } from "node:http";
import type { TicketActor } from "@dcc/domain";
import { securityHeaders } from "./security.ts";
import {
  createSubmission, deleteOwnSubmission, getSubmission, listSubmissionProjects, listSubmissions, updateSubmission,
} from "./ticket-submissions.ts";

function json(response: ServerResponse, status: number, body?: unknown) {
  response.writeHead(status, { ...(body === undefined ? {} : { "content-type": "application/json; charset=utf-8" }), ...securityHeaders() });
  response.end(body === undefined ? undefined : JSON.stringify(body));
}

async function bodyOf(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) throw Object.assign(new Error("request too large"), { status: 413 });
    chunks.push(Buffer.from(chunk));
  }
  try { return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}; }
  catch { throw Object.assign(new Error("invalid JSON"), { status: 400 }); }
}

async function handleTicketApi(request: IncomingMessage, response: ServerResponse, url: URL, actor: TicketActor): Promise<boolean> {
  if (url.pathname === "/api/projects" && request.method === "GET") {
    json(response, 200, { projects: await listSubmissionProjects(actor) });
    return true;
  }
  if (url.pathname === "/api/tickets" && request.method === "GET") {
    const rawOffset = Number(url.searchParams.get("offset") ?? 0);
    json(response, 200, { tickets: await listSubmissions(actor, {
      project_id: url.searchParams.get("project_id") || undefined,
      search: url.searchParams.get("search") || undefined,
      offset: Number.isFinite(rawOffset) ? rawOffset : 0,
    }) });
    return true;
  }
  if (url.pathname === "/api/tickets" && request.method === "POST") {
    json(response, 201, { ticket: await createSubmission(actor, await bodyOf(request)) });
    return true;
  }
  const match = url.pathname.match(/^\/api\/tickets\/([^/]+)$/);
  if (!match) return false;
  const ref = decodeURIComponent(match[1]);
  if (request.method === "GET") {
    const ticket = await getSubmission(actor, ref);
    json(response, ticket ? 200 : 404, ticket ? { ticket } : { error: "ticket not found" });
    return true;
  }
  if (request.method === "PATCH") {
    json(response, 200, { ticket: await updateSubmission(actor, ref, await bodyOf(request)) });
    return true;
  }
  if (request.method === "DELETE") {
    await deleteOwnSubmission(actor, ref);
    json(response, 204);
    return true;
  }
  return false;
}

export async function ticketApi(request: IncomingMessage, response: ServerResponse, url: URL, actor: TicketActor): Promise<boolean> {
  try {
    return await handleTicketApi(request, response, url, actor);
  } catch (error: any) {
    json(response, Number(error?.status) || 500, {
      error: Number(error?.status) ? error.message : "internal server error",
      ...(error?.fields ? { fields: error.fields } : {}),
    });
    return true;
  }
}
