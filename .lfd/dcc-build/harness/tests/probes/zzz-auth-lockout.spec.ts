// The lockout sub-case of SEC-10 (PRD §27.1 "temporary lockout"). Split out
// of ../api/auth-login.spec.ts deliberately: this test drives the shared
// eval-admin account into a login lockout, and every other spec file in the
// suite calls login() with that same account. Named "zzz-" so it sorts last
// within tests/probes/, and tests/probes/ itself runs after all of
// tests/api/ in harness/score.sh's fixed execution order — making this the
// final thing to run in any full eval pass. Do not rename it earlier in
// sort order, and do not add a spec file that needs login() and sorts after
// this one.
import { describe, it, expect } from "vitest";
import { APP_BASE_URL } from "../helpers";

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
  return { status: res.status, json, text };
}

function errorShapeOf(body: { json: any; text: string }) {
  const j = body.json ?? {};
  return {
    keys: Object.keys(j).sort(),
    message: j.message ?? j.error ?? j.error_message ?? j.code ?? body.text,
  };
}

describe("account lockout after repeated wrong-password attempts", () => {
  const username = process.env.DCC_EVAL_ADMIN_USER!;
  const password = process.env.DCC_EVAL_ADMIN_PASSWORD!;

  it("rejects even the correct password once the lockout threshold is crossed", async () => {
    if (!username || !password) {
      throw new Error("DCC_EVAL_ADMIN_USER / DCC_EVAL_ADMIN_PASSWORD not set — run-evals.sh must run scripts/create-admin.ts first");
    }

    const normalWrongPassword = await rawLogin(username, `${password}-wrong-baseline`);
    const normalShape = errorShapeOf(normalWrongPassword);

    const attempts = 8;
    let lastStatus = 0;
    for (let i = 0; i < attempts; i++) {
      const res = await rawLogin(username, `${password}-wrong-${i}`);
      lastStatus = res.status;
    }
    expect([401, 403, 429]).toContain(lastStatus);

    const afterLockout = await rawLogin(username, password);
    // Either a distinct 429, or a 4xx whose body is distinguishable from the
    // plain "wrong password" shape captured above (e.g. mentions lockout).
    if (afterLockout.status === 429) {
      expect(afterLockout.status).toBe(429);
    } else {
      expect(afterLockout.status).toBeGreaterThanOrEqual(400);
      expect(afterLockout.status).toBeLessThan(500);
      const lockedShape = errorShapeOf(afterLockout);
      expect(lockedShape.message).not.toBe(normalShape.message);
    }
  });
});
