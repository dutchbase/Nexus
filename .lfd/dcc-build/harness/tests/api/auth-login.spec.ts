// SEC-10 (partial: argon2id + audit trail), SEC-11 — PRD §27.1 (admin
// authentication) and §29.2.
//
// See ../../HARNESS_CONVENTIONS.md "Admin user / login": run-evals.sh runs
// the real scripts/create-admin.ts BEFORE this file runs, so
// DCC_EVAL_ADMIN_USER / DCC_EVAL_ADMIN_PASSWORD authenticate against a real
// Argon2id hash. login() in ../helpers uses those env vars.
//
// ORDERING NOTE: the lockout sub-case of SEC-10 (repeated wrong-password
// attempts locking out the shared eval-admin account) is deliberately NOT in
// this file — every other spec file across the whole suite calls login()
// with this same account, and score.sh runs spec files in a fixed order
// (all of tests/api/ before tests/probes/). A lockout test living here would
// risk breaking every later file's login for the rest of the run. It lives
// instead in tests/probes/zzz-auth-lockout.spec.ts, named to sort last
// within tests/probes/ (itself the last directory score.sh runs), so it is
// the final thing to execute in any full eval run.
import { describe, it, expect, beforeAll } from "vitest";
import { login, apiJson, queryOne, queryAll, APP_BASE_URL, type Session } from "../helpers";

const ARGON2ID_RE = /^\$argon2id\$v=\d+\$m=\d+,t=\d+,p=\d+\$/;

async function rawLogin(username: string, password: string) {
  const res = await fetch(`${APP_BASE_URL}/api/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const text = await res.text();
  let json: any = undefined;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, json, text, headers: res.headers };
}

function errorShapeOf(body: { json: any; text: string }) {
  const j = body.json ?? {};
  return {
    keys: Object.keys(j).sort(),
    message: j.message ?? j.error ?? j.error_message ?? j.code ?? body.text,
  };
}

// -------------------------------------------------------------- SEC-11 first
// Runs before the lockout test below so it always has a working login.
describe("CSRF token required on mutations", () => {
  let session: Session;
  let ticketId: string;
  let ticketTitle: string;

  beforeAll(async () => {
    session = await login();
    const ticket = await queryOne("select id, title from tickets order by created_at desc limit 1");
    if (!ticket) throw new Error("no ticket fixture available to probe CSRF enforcement with");
    ticketId = ticket.id;
    ticketTitle = ticket.title;
  });

  it("rejects a mutating request with a valid session cookie but no CSRF token", async () => {
    const sessionWithoutCsrf: Session = { cookie: session.cookie, csrfToken: "" };
    const res = await apiJson(sessionWithoutCsrf, "PATCH", `/api/admin/tickets/${ticketId}`, {
      title: ticketTitle, // no-op value: proves the gate, doesn't change data
    });
    expect(res.status).toBe(403);
  });

  it("accepts the same request when a valid CSRF token is included", async () => {
    const res = await apiJson(session, "PATCH", `/api/admin/tickets/${ticketId}`, {
      title: ticketTitle,
    });
    expect(res.ok).toBe(true);
  });
});

// ---------------------------------------------------------- SEC-10 second
describe("argon2id hashing, lockout, and audit trail", () => {
  const username = process.env.DCC_EVAL_ADMIN_USER!;
  const password = process.env.DCC_EVAL_ADMIN_PASSWORD!;

  beforeAll(() => {
    if (!username || !password) {
      throw new Error("DCC_EVAL_ADMIN_USER / DCC_EVAL_ADMIN_PASSWORD not set — run-evals.sh must run scripts/create-admin.ts first");
    }
  });

  it("stores the eval admin's password using a real Argon2id hash", async () => {
    const user = await queryOne("select password_hash from users where username = $1", [username]);
    expect(user).not.toBeNull();
    expect(user.password_hash).toMatch(ARGON2ID_RE);
  });

  it("accepts correct credentials and sets an HttpOnly, SameSite session cookie", async () => {
    const res = await rawLogin(username, password);
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toBeTruthy();
    expect(setCookie!.toLowerCase()).toContain("httponly");
    expect(setCookie!.toLowerCase()).toContain("samesite");
  });

  it("returns a structurally identical error for wrong password vs unknown username", async () => {
    const wrongPassword = await rawLogin(username, `${password}-wrong`);
    const wrongUsername = await rawLogin(`${username}-does-not-exist`, password);

    expect(wrongPassword.status).toBe(wrongUsername.status);
    expect([401, 403]).toContain(wrongPassword.status);

    const shapeA = errorShapeOf(wrongPassword);
    const shapeB = errorShapeOf(wrongUsername);
    expect(shapeA.keys).toEqual(shapeB.keys);
    expect(shapeA.message).toBe(shapeB.message);
  });

  it("records both a successful and a failed login in audit_events", async () => {
    const rows = await queryAll(
      "select action, metadata_json, after_json from audit_events where action ilike '%login%' order by created_at desc limit 100",
    );
    expect(rows.length).toBeGreaterThan(0);

    // action naming and where the outcome lives (a distinct action string
    // like "login.failed" vs a shared "login" action with an outcome flag
    // in after_json/metadata_json) are the implementation's choice — check
    // both shapes.
    const blobOf = (r: any) => `${r.action} ${JSON.stringify(r.after_json ?? {})} ${JSON.stringify(r.metadata_json ?? {})}`.toLowerCase();
    const isFailureRow = (r: any) => {
      const blob = blobOf(r);
      return blob.includes("fail") || blob.includes('"success":false');
    };
    // Every row here already matched action ILIKE '%login%' in the query
    // above, so anything not flagged as a failure counts as the success row.
    const isSuccessRow = (r: any) => !isFailureRow(r);

    expect(rows.some(isSuccessRow)).toBe(true);
    expect(rows.some(isFailureRow)).toBe(true);
  });
});

// The lockout sub-case of SEC-10 lives in
// ../probes/zzz-auth-lockout.spec.ts — see the ORDERING NOTE at the top of
// this file for why.
