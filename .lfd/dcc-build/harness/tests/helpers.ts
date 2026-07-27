// Shared helpers for harness/tests/**/*.spec.ts (Vitest, API-level tests).
// See ../HARNESS_CONVENTIONS.md for the full contract this assumes.
//
// Design note: every helper here is deliberately dependency-light (built-in
// fetch + the `pg` package only) so these tests exercise the real HTTP/DB
// surface rather than an app-internal test harness the execution agent could
// special-case. If the app's actual auth/session shape diverges from what's
// assumed below, that is a reportable mismatch (fix the app or flag it in
// LOG.md) — do not adapt this file to make a shortcut pass.

import { Client } from "pg";

export const APP_BASE_URL = process.env.APP_BASE_URL ?? "http://127.0.0.1:3000";
export const MOCK_GITHUB_BASE_URL = process.env.MOCK_GITHUB_BASE_URL ?? "http://127.0.0.1:8991";
export const MOCK_CLAUDE_LOG = process.env.MOCK_CLAUDE_LOG ?? "";
export const MOCK_GITHUB_LOG = process.env.MOCK_GITHUB_LOG ?? "";

// ---------------------------------------------------------------- database

export async function withDb<T>(fn: (db: Client) => Promise<T>): Promise<T> {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    return await fn(db);
  } finally {
    await db.end();
  }
}

export async function queryOne(sql: string, params: any[] = []): Promise<any | null> {
  return withDb(async (db) => {
    const res = await db.query(sql, params);
    return res.rows[0] ?? null;
  });
}

export async function queryAll(sql: string, params: any[] = []): Promise<any[]> {
  return withDb(async (db) => {
    const res = await db.query(sql, params);
    return res.rows;
  });
}

export async function ticketByNumber(ticketNumber: string) {
  return queryOne("select * from tickets where ticket_number = $1", [ticketNumber]);
}

// ---------------------------------------------------------------- HTTP / session

export type Session = { cookie: string; csrfToken: string };

// Logs in with DCC_EVAL_ADMIN_USER / DCC_EVAL_ADMIN_PASSWORD (set by
// run-evals.sh after it runs scripts/create-admin.ts — see
// HARNESS_CONVENTIONS.md). If the app exposes CSRF token differently than
// assumed here (e.g. via GET /api/admin/session instead of the login
// response body), update ONLY this function — every other test file goes
// through it.
export async function login(): Promise<Session> {
  const username = process.env.DCC_EVAL_ADMIN_USER;
  const password = process.env.DCC_EVAL_ADMIN_PASSWORD;
  if (!username || !password) {
    throw new Error("DCC_EVAL_ADMIN_USER / DCC_EVAL_ADMIN_PASSWORD not set — run-evals.sh must run scripts/create-admin.ts first");
  }
  const res = await fetch(`${APP_BASE_URL}/api/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    throw new Error(`login failed: ${res.status} ${await res.text()}`);
  }
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("login response set no session cookie");
  const cookie = setCookie.split(";")[0];
  const body = await res.json().catch(() => ({}));
  const csrfToken = body.csrfToken ?? body.csrf_token ?? "";
  return { cookie, csrfToken };
}

export async function api(
  session: Session | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (session) {
    headers["cookie"] = session.cookie;
    if (session.csrfToken) headers["x-csrf-token"] = session.csrfToken;
  }
  return fetch(`${APP_BASE_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

export async function apiJson(session: Session | null, method: string, path: string, body?: unknown) {
  const res = await api(session, method, path, body);
  const text = await res.text();
  let json: any = undefined;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    /* non-JSON response, leave json undefined */
  }
  return { status: res.status, ok: res.ok, json, text, headers: res.headers };
}

// ---------------------------------------------------------------- mock-claude

import { writeFileSync, appendFileSync, readFileSync, existsSync } from "fs";
import { randomUUID } from "crypto";

export type MockClaudeScenario = {
  mode: "plan_valid" | "plan_invalid" | "timeout" | "exec_stream" | "invalid_model_combo";
  plan_markdown?: string;
  invalid_plan_text?: string;
  session_id_expected?: string;
  events?: any[];
  timeout_after_events?: number;
  exit_code?: number;
};

const SCENARIO_DIR = process.env.MOCK_CLAUDE_SCENARIO_DIR ?? "/tmp/dcc-mock-claude-scenarios";

// Writes a scenario file and returns its path. Per HARNESS_CONVENTIONS.md,
// how the worker picks up a per-job scenario path is an app-level choice
// (env var vs job payload field) — tests pass the returned path via
// whichever mechanism apps/worker documents.
export function writeMockClaudeScenario(scenario: MockClaudeScenario): string {
  if (!existsSync(SCENARIO_DIR)) {
    require("fs").mkdirSync(SCENARIO_DIR, { recursive: true });
  }
  const path = `${SCENARIO_DIR}/${randomUUID()}.json`;
  writeFileSync(path, JSON.stringify(scenario, null, 2));
  return path;
}

export const DEFAULT_PLAN_MARKDOWN = [
  "# Implementation Plan",
  "",
  "## 1. Summary",
  "Mock plan for eval purposes.",
  "## 2. Problem Definition",
  "## 3. Current Behaviour",
  "## 4. Expected Behaviour",
  "## 5. Relevant Architecture",
  "## 6. Relevant Files",
  "## 7. Proposed Changes",
  "## 8. Implementation Steps",
  "## 9. Database or Migration Changes",
  "## 10. Testing Strategy",
  "## 11. Security Considerations",
  "## 12. Performance Considerations",
  "## 13. Risks and Edge Cases",
  "## 14. Rollback Strategy",
  "## 15. Acceptance Criteria Mapping",
  "## 16. Out of Scope",
  "## 17. Open Questions",
  "",
].join("\n");

export function readMockClaudeLog(): any[] {
  if (!MOCK_CLAUDE_LOG || !existsSync(MOCK_CLAUDE_LOG)) return [];
  return readFileSync(MOCK_CLAUDE_LOG, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function clearMockClaudeLog() {
  if (MOCK_CLAUDE_LOG) writeFileSync(MOCK_CLAUDE_LOG, "");
}

// ---------------------------------------------------------------- mock-github

export async function githubControl(method: string, path: string, body?: unknown) {
  const res = await fetch(`${MOCK_GITHUB_BASE_URL}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => undefined) };
}

export async function resetMockGithub() {
  await githubControl("POST", "/_control/reset");
}

export async function dumpMockGithub() {
  return (await githubControl("GET", "/_control/dump")).json;
}

export function readMockGithubLog(): any[] {
  if (!MOCK_GITHUB_LOG || !existsSync(MOCK_GITHUB_LOG)) return [];
  return readFileSync(MOCK_GITHUB_LOG, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

// ---------------------------------------------------------------- misc

export function sha256(content: string): string {
  return require("crypto").createHash("sha256").update(content, "utf8").digest("hex");
}

export async function waitFor(
  predicate: () => Promise<boolean>,
  { timeoutMs = 15000, intervalMs = 200 } = {},
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor: timed out after ${timeoutMs}ms`);
}
