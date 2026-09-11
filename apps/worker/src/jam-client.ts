import { createHash } from "node:crypto";
import { Client, SdkError, SdkErrorCode, StreamableHTTPClientTransport, type AuthProvider, type Tool } from "@modelcontextprotocol/client";
import type { JamErrorCode, JamEvidence, JamSource } from "../../../packages/domain/src/ticket-jam.ts";

const ENDPOINT = "https://mcp.jam.dev/mcp";
const RESPONSE_LIMIT = 2 * 1024 * 1024;
const EVIDENCE_LIMIT = 256 * 1024;
const CALL_TIMEOUT = 10_000;
let jamFetch: typeof fetch = fetch;

export type JamImportResult = { state: "ready" | "partial"; evidence: JamEvidence; contentHash: string };
type JamClient = Pick<Client, "connect" | "listTools" | "callTool" | "close">;
type JamDependencies = { createClient?: () => JamClient; createTransport?: (token: string) => StreamableHTTPClientTransport; timeout?: (milliseconds: number) => AbortSignal };
export class JamImportError extends Error {
  constructor(public code: JamErrorCode, public retryable: boolean, public retryAfterSeconds?: number) { super(code); this.name = "JamImportError"; }
}
export function setJamFetchForTests(value: typeof fetch) { jamFetch = value; }
export function jamEndpoint(env = process.env): string {
  const override = env.DCC_JAM_TEST_ENDPOINT;
  if (!override || env.NODE_ENV === "production") return ENDPOINT;
  const url = new URL(override);
  if (url.protocol !== "http:" || !["127.0.0.1", "::1", "localhost"].includes(url.hostname)) throw new JamImportError("access_denied", false);
  return url.href;
}

const safeUrl = (value: unknown) => {
  if (typeof value !== "string") return undefined;
  return value.replace(/https?:\/\/[^\s"'<>]+/gi, (raw) => { try { const url = new URL(raw); return `${url.origin}${url.pathname}`; } catch { return "[redacted-url]"; } });
};
const secretKey = (key: string) => /password|secret|token|authorization|cookie|api[-_]?key|request[-_]?body|response[-_]?body|headers?/i.test(key);
export function redactJamValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactJamValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => !secretKey(key)).map(([key, child]) => [key, redactJamValue(child)]));
  if (typeof value === "string") return safeUrl(value)?.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").replace(/\b((?:access|refresh|client|api|auth)[-_ ]?(?:token|secret|key)|token|secret|password|cookie|auth(?:orization)?)\s*([=:])\s*(?:"[^"]*"|'[^']*'|[^\s,;&#]+)/gi, "$1$2[redacted]");
  return value;
}

export function safeJamSchema(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const schema = value as Record<string, unknown>, result: Record<string, unknown> = {};
  if (typeof schema.type === "string") result.type = schema.type;
  if (schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)) result.properties = Object.fromEntries(Object.entries(schema.properties).map(([name, child]) => [name, safeJamSchema(child)]));
  if (Array.isArray(schema.required)) result.required = schema.required.filter((name): name is string => typeof name === "string");
  if (schema.items) result.items = safeJamSchema(schema.items);
  return result;
}

function asRecord(value: unknown): Record<string, any> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {}; }
function rows(value: unknown): Record<string, any>[] { const candidate = Array.isArray(value) ? value : asRecord(value).items ?? asRecord(value).events ?? asRecord(value).data ?? asRecord(value).entries; return Array.isArray(candidate) ? candidate.map(asRecord) : []; }
function text(value: unknown) { return typeof value === "string" ? safeUrl(value) : undefined; }
function number(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function describeJamEvent(row: Record<string, any>): string {
  const skip = new Set(["event_index", "ts", "elapsed_ms", "event_type", "type", "time", "description"]);
  const parts = Object.entries(row).filter(([key, value]) => !skip.has(key) && ["string", "number", "boolean"].includes(typeof value)).map(([key, value]) => `${key}=${value}`);
  return parts.join(" ").slice(0, 500) || (text(row.event_type) ?? "event");
}

export function normalizeJamEvidence(source: JamSource, sections: Record<string, unknown>): JamEvidence {
  const clean = redactJamValue(sections) as Record<string, any>;
  const details = asRecord(clean.details);
  const systemInfo = asRecord(details.systemInfo);
  const screenDimensions = asRecord(systemInfo.screenDimensions);
  const optional = ["console", "network", "events", "metadata", "transcript"];
  const evidence: JamEvidence = {
    sourceUrl: source.url,
    device: {
      browser: text(details.browser) ?? text(asRecord(systemInfo.browser).name),
      os: text(details.os) ?? text(asRecord(systemInfo.os).name),
      viewport: text(details.viewport) ?? (number(screenDimensions.width) !== undefined && number(screenDimensions.height) !== undefined ? `${screenDimensions.width}x${screenDimensions.height}` : undefined),
      pageUrl: text(details.pageUrl ?? details.url),
    },
    console: rows(clean.console).slice(0, 500).map((row) => ({ level: text(row.level ?? row.console_level) ?? "unknown", message: text(row.message ?? row.console_message) ?? "", ...(text(row.time ?? row.ts) ? { time: text(row.time ?? row.ts) } : {}) })),
    network: rows(clean.network).slice(0, 500).flatMap((row) => { const url = text(row.url ?? row.network_url); if (!url) return []; return [{ method: text(row.method ?? row.network_method) ?? "GET", url, ...(number(row.status ?? row.network_status) !== undefined ? { status: number(row.status ?? row.network_status) } : {}), ...(number(row.durationMs ?? row.duration ?? row.network_duration_ms) !== undefined ? { durationMs: number(row.durationMs ?? row.duration ?? row.network_duration_ms) } : {}) }]; }),
    events: rows(clean.events).slice(0, 500).map((row) => ({ type: text(row.type ?? row.event_type) ?? "event", description: text(row.description) ?? describeJamEvent(row), ...(text(row.time ?? row.ts) ? { time: text(row.time ?? row.ts) } : {}) })),
    metadata: Object.fromEntries(Object.entries(asRecord(clean.metadata)).filter(([, value]) => value === null || ["string", "number", "boolean"].includes(typeof value))) as JamEvidence["metadata"],
    ...(typeof clean.transcript === "string" ? { transcript: text(clean.transcript) } : {}),
    unavailableSections: optional.filter((name) => sections[name] === undefined), truncatedSections: [],
  };
  for (const name of ["console", "network", "events"] as const) if (rows(clean[name]).length > 500 || asRecord(sections[name]).truncated === true) evidence.truncatedSections.push(name);
  return capEvidence(evidence);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  return JSON.stringify(value);
}
function capEvidence(evidence: JamEvidence): JamEvidence {
  const result = structuredClone(evidence);
  const size = () => Buffer.byteLength(canonical(result));
  const sections: ("console" | "network" | "events")[] = ["console", "network", "events"];
  while (size() > EVIDENCE_LIMIT && sections.some((name) => result[name].length)) {
    const longest = sections.reduce((a, b) => canonical(result[a]).length >= canonical(result[b]).length ? a : b);
    result[longest].pop(); if (!result.truncatedSections.includes(longest)) result.truncatedSections.push(longest);
  }
  while (size() > EVIDENCE_LIMIT && result.transcript) { result.transcript = result.transcript.slice(0, Math.floor(result.transcript.length * .75)); if (!result.truncatedSections.includes("transcript")) result.truncatedSections.push("transcript"); }
  for (const key of Object.keys(result.metadata).sort().reverse()) { if (size() <= EVIDENCE_LIMIT) break; delete result.metadata[key]; if (!result.truncatedSections.includes("metadata")) result.truncatedSections.push("metadata"); }
  for (const key of ["pageUrl", "viewport", "os", "browser"] as const) while (size() > EVIDENCE_LIMIT && result.device[key]) { result.device[key] = result.device[key]!.slice(0, Math.floor(result.device[key]!.length * .75)); if (!result.truncatedSections.includes("device")) result.truncatedSections.push("device"); }
  return result;
}

export function bindJamToolArguments(schema: unknown, id: string, options: { limit?: number; after?: string | number } = {}): Record<string, unknown> {
  const shape = asRecord(schema), properties = asRecord(shape.properties), required = Array.isArray(shape.required) ? shape.required : [];
  const selectors = ["jamId", "id", "jam_id"].filter((name) => properties[name] !== undefined);
  if (selectors.length !== 1 || asRecord(properties[selectors[0]]).type !== "string" || required.some((name) => name !== selectors[0]) || (properties.limit && !["number", "integer"].includes(asRecord(properties.limit).type)) || (properties.after && !["string", "number", "integer"].includes(asRecord(properties.after).type))) throw new JamImportError("unsupported_schema", false);
  const selector = selectors[0];
  return { [selector]: id, ...(options.limit !== undefined && properties.limit ? { limit: options.limit } : {}), ...(options.after !== undefined && properties.after ? { after: options.after } : {}) };
}

async function limitedResponse(response: Response): Promise<Response> {
  if (response.status >= 300 && response.status < 400) throw new JamImportError("access_denied", false);
  if (response.status === 401 || response.status === 403) throw new JamImportError("access_denied", false);
  if (response.status === 404) throw new JamImportError("not_found", false);
  if (response.status === 429) throw new JamImportError("rate_limited", true, Math.min(300, Math.max(0, Number(response.headers.get("retry-after")) || 0)));
  if (response.status >= 500) throw new JamImportError("unavailable", true);
  const reader = response.body?.getReader(); if (!reader) return response;
  const chunks: Uint8Array[] = []; let total = 0;
  while (true) { const { done, value } = await reader.read(); if (done) break; total += value.byteLength; if (total > RESPONSE_LIMIT) { await reader.cancel(); throw new JamImportError("invalid_response", false); } chunks.push(value); }
  const bytes = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
}

export async function boundedJamFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  if (url.href !== jamEndpoint()) throw new JamImportError("access_denied", false);
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT);
  const abort = () => controller.abort(); init.signal?.addEventListener("abort", abort, { once: true });
  if (init.signal?.aborted) controller.abort();
  try { return await limitedResponse(await jamFetch(url, { ...init, redirect: "error", signal: controller.signal })); }
  catch (error) { if (error instanceof JamImportError) throw error; if (controller.signal.aborted) throw new JamImportError("timeout", true); if (error instanceof TypeError) throw new JamImportError("unavailable", true); throw new JamImportError("invalid_response", false); }
  finally { clearTimeout(timer); init.signal?.removeEventListener("abort", abort); }
}

export function parseJamToolResult(result: any): unknown {
  if (result?.isError) throw new JamImportError("invalid_response", false);
  if (result?.structuredContent !== undefined) return result.structuredContent;
  const values = Array.isArray(result?.content) ? result.content.filter((item: any) => item?.type === "text" && typeof item.text === "string").map((item: any) => item.text) : [];
  if (!values.length) throw new JamImportError("invalid_response", false);
  for (const value of values) { try { return JSON.parse(value); } catch { /* not this block; try the next or fall back to prose */ } }
  return values.join("\n").slice(0, RESPONSE_LIMIT);
}

const toolNames = { details: "getDetails", console: "getConsoleLogs", network: "getNetworkRequests", events: "getUserEvents", metadata: "getMetadata", transcript: "getVideoTranscript" } as const;
function sdkTimeout(error: unknown) {
  return error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout;
}
export async function fetchJamContext(source: JamSource, options: { token: string; signal: AbortSignal }, dependencies: JamDependencies = {}): Promise<JamImportResult> {
  if (!options.token) throw new JamImportError("not_configured", false);
  const deadline = AbortSignal.any([options.signal, (dependencies.timeout ?? AbortSignal.timeout)(30_000)]);
  const authProvider: AuthProvider = { token: async () => options.token };
  const client = dependencies.createClient?.() ?? new Client({ name: "nexus-jam-ingestion", version: "1.0.0" });
  const transport = dependencies.createTransport?.(options.token) ?? new StreamableHTTPClientTransport(new URL(jamEndpoint()), { authProvider, fetch: boundedJamFetch, onInsufficientScope: "throw" });
  try {
    await client.connect(transport, { signal: deadline, timeout: CALL_TIMEOUT, maxTotalTimeout: 30_000 });
    const { tools } = await client.listTools(undefined, { signal: deadline, timeout: CALL_TIMEOUT, maxTotalTimeout: 30_000 });
    const definitions = new Map(tools.map((tool) => [tool.name, tool]));
    if (!definitions.has(toolNames.details)) throw new JamImportError("unsupported_schema", false);
    const sections: Record<string, unknown> = {};
    for (const [section, name] of Object.entries(toolNames)) {
      const tool = definitions.get(name); if (!tool) continue;
      try { sections[section] = await callJamToolPages(client, tool, source.id, deadline); }
      catch (error) { if (section === "details") throw error; }
    }
    const evidence = normalizeJamEvidence(source, sections);
    if (!Object.keys(evidence.device).length && !evidence.console.length && !evidence.network.length && !evidence.events.length && !Object.keys(evidence.metadata).length && !evidence.transcript) throw new JamImportError("invalid_response", false);
    return { state: evidence.unavailableSections.length ? "partial" : "ready", evidence, contentHash: createHash("sha256").update(canonical(evidence)).digest("hex") };
  } catch (error) { if (error instanceof JamImportError) throw error; if (deadline.aborted || sdkTimeout(error)) throw new JamImportError("timeout", true); throw new JamImportError("invalid_response", false); }
  finally { await client.close().catch(() => undefined); }
}

function pageCursor(value: unknown): string | number | undefined {
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}
export async function callJamToolPages(client: Pick<Client, "callTool">, tool: Tool, id: string, signal: AbortSignal): Promise<unknown> {
  const collected: unknown[] = []; let after: string | number | undefined; const seen = new Set<string>(); let truncated = false;
  for (let page = 0; page < 5; page++) {
    const result = parseJamToolResult(await client.callTool({ name: tool.name, arguments: bindJamToolArguments(tool.inputSchema, id, { limit: 100, after }) }, { signal, timeout: CALL_TIMEOUT, maxTotalTimeout: CALL_TIMEOUT, toolDefinition: tool }));
    const record = asRecord(result), items = Array.isArray(record.items) ? record.items : Array.isArray(record.events) ? record.events : Array.isArray(record.data) ? record.data : undefined;
    if (!items) return result; collected.push(...items.slice(0, 500 - collected.length));
    const cursor = pageCursor(record.nextCursor) ?? pageCursor(record.next_cursor);
    if (cursor === undefined) break;
    const cursorKey = String(cursor);
    if (seen.has(cursorKey) || collected.length >= 500 || page === 4) { truncated = true; break; }
    seen.add(cursorKey); after = cursor;
  }
  return { items: collected, truncated };
}
