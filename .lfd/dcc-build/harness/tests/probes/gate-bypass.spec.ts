// SEC-03 — proves the execution gate (PRD §20.1, §19.4) is enforced
// server-side, not just hidden by the admin UI. Only raw fetch through
// ../helpers' api()/apiJson() is used here — no browser/UI automation.
//
// Each case needs a ticket in a specific plan-approval state. Driving that
// state through the real planning pipeline (mock-claude scenario + worker
// job + admin review) is what the *workflow*-category tests cover elsewhere;
// this probe only cares whether POST .../execute enforces the gate, so
// cases 2 and 3 fabricate the plan_version / approval state directly via SQL
// (per §26's table/column names) and only route the specific action under
// test (approve, then a real PATCH mutation) through the real API. This is
// the harness-brief-endorsed fallback for case 3 ("directly corrupted via a
// raw SQL UPDATE") applied consistently to case 2 as well.
import { describe, it, expect, beforeAll } from "vitest";
import { login, apiJson, queryOne, sha256, type Session } from "../helpers";
import { randomUUID } from "crypto";

const FORM_SLUG = "website-feedback";

// ------------------------------------------------------- minimal ticket creation
// Trimmed copy of the dynamic form-field logic in
// ../api/public-form-security.spec.ts — this probe only needs *a* ticket to
// exist, not full field-type coverage, so it keeps its own small copy rather
// than pulling in the other spec file.
type FormField = { field_key?: string; key?: string; field_type?: string; type?: string; required?: boolean };

async function fetchFormFields(): Promise<FormField[]> {
  const res = await apiJson(null, "GET", `/api/public/forms/${FORM_SLUG}`);
  if (!res.ok) throw new Error(`GET /api/public/forms/${FORM_SLUG} failed: ${res.status} ${res.text}`);
  const body = res.json ?? {};
  const fields = body.fields ?? body.form?.fields ?? body.form_fields ?? [];
  return Array.isArray(fields) ? fields : [];
}

async function realProjectId(): Promise<string> {
  const row = await queryOne("select id from projects where enabled = true order by created_at limit 1");
  if (!row) throw new Error("no enabled project fixture available");
  return row.id;
}

async function submitTicket(marker: string): Promise<string> {
  const fields = await fetchFormFields();
  const payload: Record<string, any> = {
    submitter_name: `Eval Probe ${marker}`,
    submitter_email: "eval-probe@example.com",
  };
  let projectId: string | undefined;
  for (const f of fields) {
    const key = f.field_key ?? f.key;
    if (!key) continue;
    const t = String(f.field_type ?? f.type ?? "").toLowerCase();
    if (t.includes("hidden") || t.includes("static") || t.includes("image")) continue;
    if (t.includes("project")) {
      projectId = projectId ?? (await realProjectId());
      payload[key] = projectId;
      continue;
    }
    if (t.includes("categor")) {
      payload[key] = "Bug";
      continue;
    }
    if (t.includes("environ")) {
      payload[key] = "Production";
      continue;
    }
    payload[key] = `Eval probe ${marker} for ${key}`;
  }

  const res = await apiJson(null, "POST", `/api/public/forms/${FORM_SLUG}/submissions`, payload);
  if (!res.ok) throw new Error(`ticket submission failed: ${res.status} ${res.text}`);

  const row = await queryOne("select id from tickets where title ilike $1 or description ilike $1 limit 1", [`%${marker}%`]);
  if (!row) throw new Error(`could not find ticket created for marker ${marker} after submission`);
  return row.id;
}

// --------------------------------------------------------------- plan fabrication
async function fabricateApprovedPlan(ticketId: string, session: Session): Promise<string> {
  const contentMarkdown = "# Implementation Plan\n\nFabricated for SEC-03 gate probe.\n";
  const contentHash = sha256(contentMarkdown);
  const planId = randomUUID();
  const planVersionId = randomUUID();

  await queryOne(
    "insert into plans (id, ticket_id, planning_session_id, current_version_id, created_at, updated_at) values ($1, $2, null, null, now(), now()) returning id",
    [planId, ticketId],
  );
  await queryOne(
    "insert into plan_versions (id, plan_id, version, content_markdown, content_hash, prompt_snapshot_id, agent_run_id, created_at) values ($1, $2, 1, $3, $4, null, null, now()) returning id",
    [planVersionId, planId, contentMarkdown, contentHash],
  );
  await queryOne("update plans set current_version_id = $1 where id = $2 returning id", [planVersionId, planId]);
  await queryOne("update tickets set status = 'Plan Ready for Review' where id = $1 returning id", [ticketId]);

  const approveRes = await apiJson(session, "POST", `/api/admin/plan-versions/${planVersionId}/approve`);
  if (!approveRes.ok) {
    throw new Error(`fabricated plan-version approval failed: ${approveRes.status} ${approveRes.text}`);
  }
  return planVersionId;
}

describe("execution API rejects missing, stale, and unknown plan approvals", () => {
  let session: Session;

  beforeAll(async () => {
    session = await login();
  });

  it("rejects execute on a ticket with no plan at all", async () => {
    const marker = `gatebypass-noplan-${randomUUID()}`;
    const ticketId = await submitTicket(marker);

    const res = await apiJson(session, "POST", `/api/admin/tickets/${ticketId}/execute`);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("rejects execute referencing a plan that went stale after the ticket was mutated post-approval", async () => {
    const marker = `gatebypass-stale-${randomUUID()}`;
    const ticketId = await submitTicket(marker);
    await fabricateApprovedPlan(ticketId, session);

    // Real mutation through the real admin API — this is what must make the
    // previously-approved plan stale (§20.1 "ticket configuration is
    // unchanged or explicitly reconfirmed").
    const patchRes = await apiJson(session, "PATCH", `/api/admin/tickets/${ticketId}`, {
      title: `${marker}-mutated-after-approval`,
    });
    expect(patchRes.ok).toBe(true);

    const execRes = await apiJson(session, "POST", `/api/admin/tickets/${ticketId}/execute`);
    expect(execRes.status).toBeGreaterThanOrEqual(400);
    expect(execRes.status).toBeLessThan(500);
  });

  it("rejects execute gracefully (4xx, not 500) when approved_plan_version_id points at nothing", async () => {
    const marker = `gatebypass-dangling-${randomUUID()}`;
    const ticketId = await submitTicket(marker);
    const bogusPlanVersionId = randomUUID();

    await queryOne(
      "update tickets set approved_plan_version_id = $1, status = 'Plan Approved' where id = $2 returning id",
      [bogusPlanVersionId, ticketId],
    );

    const execRes = await apiJson(session, "POST", `/api/admin/tickets/${ticketId}/execute`);
    expect(execRes.status).toBeGreaterThanOrEqual(400);
    expect(execRes.status).toBeLessThan(500);
  });
});
