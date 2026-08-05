// SEC-04, SEC-05, SEC-06, SEC-07, SEC-18 — PRD §27.2 (public form security),
// §29.1 (public routes), §15.3 (field types).
//
// Field names inside request/response bodies are not fixed by PRD §26
// (see ../../HARNESS_CONVENTIONS.md "HTTP client conventions"), so submission
// payloads here are built dynamically from GET /api/public/forms/{slug}'s own
// field list (field_key / field_type / required / options_json — the §26
// form_fields column names) rather than hardcoded. See buildSubmissionPayload
// below and the final report for the exact assumptions this makes.
//
// ORDERING NOTE: the rate-limit test (SEC-05) deliberately exhausts the
// per-IP/per-form submission rate limit, so it is the LAST describe block in
// this file — everything that needs a normal (non-429) submission response
// runs first.
import { describe, it, expect, beforeAll } from "vitest";
import { apiJson, queryOne, APP_BASE_URL } from "../helpers";
import { randomUUID } from "crypto";

const FORM_SLUG = "website-feedback";

// 1x1 transparent PNG, a well-known minimal-valid-PNG literal.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const PNG_BUFFER = Buffer.from(PNG_BASE64, "base64");

// Not a real image at all — a minimal SVG. Server-side content sniffing
// (§27.2 "no SVG in MVP") must reject this by content, not just extension.
const SVG_BUFFER = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>', "utf8");

// Plain text pretending to be a PNG (wrong content, correct-looking name).
const FAKE_TEXT_BUFFER = Buffer.from("this is not an image, just text pretending to be one", "utf8");

// ------------------------------------------------------------- form schema
type FormField = {
  field_key?: string;
  key?: string;
  field_type?: string;
  type?: string;
  required?: boolean;
  options_json?: any;
  options?: any;
};

async function fetchFormFields(slug: string): Promise<FormField[]> {
  const res = await apiJson(null, "GET", `/api/public/forms/${slug}`);
  if (!res.ok) {
    throw new Error(`GET /api/public/forms/${slug} failed: ${res.status} ${res.text}`);
  }
  const body = res.json ?? {};
  const fields = body.fields ?? body.form?.fields ?? body.form_fields ?? [];
  return Array.isArray(fields) ? fields : [];
}

function firstOption(f: FormField): any {
  const opts = f.options_json ?? f.options;
  if (Array.isArray(opts) && opts.length > 0) {
    const first = opts[0];
    return typeof first === "object" && first !== null ? (first.value ?? first.label ?? first) : first;
  }
  if (opts && typeof opts === "object") {
    const values = Object.values(opts);
    if (values.length > 0) return values[0];
  }
  return undefined;
}

function valueForField(f: FormField, marker: string): any {
  const t = String(f.field_type ?? f.type ?? "").toLowerCase();
  if (t.includes("hidden") || t.includes("static") || t.includes("image")) return undefined;
  if (t.includes("email")) return "eval-probe@example.com";
  if (t.includes("url")) return "https://example.com/eval-probe";
  if (t.includes("number")) return 1;
  if (t.includes("checkbox")) return true;
  if (t.includes("multi")) {
    const opt = firstOption(f);
    return opt !== undefined ? [opt] : ["eval-probe"];
  }
  if (t.includes("dropdown") || t.includes("radio") || t.includes("select")) {
    if (t.includes("project")) return undefined; // resolved by caller with a real project id
    if (t.includes("categor")) return firstOption(f) ?? "Bug";
    if (t.includes("environ")) return firstOption(f) ?? "Production";
    return firstOption(f) ?? "eval-probe";
  }
  if (t.includes("long")) return `Eval probe long text ${marker}`;
  return `Eval probe ${marker}`; // short text and anything unrecognized
}

async function realProjectId(): Promise<string> {
  const row = await queryOne("select id from projects where enabled = true order by created_at limit 1");
  if (!row) throw new Error("no enabled project fixture to satisfy a project-selector field");
  return row.id;
}

async function buildSubmissionPayload(fields: FormField[], marker: string): Promise<Record<string, any>> {
  const payload: Record<string, any> = {
    // "contact fields" (§15.2) are form-level settings distinct from the
    // §15.3 field-type list and map onto tickets.submitter_name/_email
    // (§26) directly — sent as top-level keys rather than a form_fields
    // entry. If the app instead exposes them as ordinary form_fields, these
    // extra keys should be harmlessly ignored.
    submitter_name: `Eval Probe ${marker}`,
    submitter_email: "eval-probe@example.com",
  };
  let projectId: string | undefined;
  for (const f of fields) {
    const key = f.field_key ?? f.key;
    if (!key) continue;
    const t = String(f.field_type ?? f.type ?? "").toLowerCase();
    if (t.includes("hidden") || t.includes("static") || t.includes("image")) continue;
    let value = valueForField(f, marker);
    if (value === undefined && t.includes("project")) {
      projectId = projectId ?? (await realProjectId());
      value = projectId;
    }
    if (value === undefined && f.required) value = `Eval probe ${marker}`;
    if (value !== undefined) payload[key] = value;
  }
  return payload;
}

function findHoneypotField(fields: FormField[]): string {
  const hidden = fields.find((f) => String(f.field_type ?? f.type ?? "").toLowerCase().includes("hidden"));
  const key = hidden ? hidden.field_key ?? hidden.key : undefined;
  // Fallback per HARNESS task brief: no PRD-fixed honeypot field name exists,
  // so if the form schema exposes no "hidden field" type field, guess a
  // common honeypot convention. Documented as an assumption in the report.
  return key ?? "website";
}

async function submitForm(payload: Record<string, any>) {
  return apiJson(null, "POST", `/api/public/forms/${FORM_SLUG}/submissions`, payload);
}

async function ticketExistsForMarker(marker: string): Promise<boolean> {
  const row = await queryOne(
    "select id from tickets where title ilike $1 or description ilike $1 limit 1",
    [`%${marker}%`],
  );
  return row !== null;
}

// --------------------------------------------------------------- uploads
async function upload(buffer: Buffer, filename: string, contentType: string) {
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: contentType }), filename);
  const res = await fetch(`${APP_BASE_URL}/api/public/forms/${FORM_SLUG}/uploads`, { method: "POST", body: form });
  const text = await res.text();
  let json: any = undefined;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, ok: res.ok, json, text };
}

let formFields: FormField[];

beforeAll(async () => {
  formFields = await fetchFormFields(FORM_SLUG);
});

describe("honeypot submissions create no ticket", () => {
  it("silently rejects a submission with the honeypot field filled", async () => {
    const marker = `honeypot-${randomUUID()}`;
    const honeypotKey = findHoneypotField(formFields);
    const payload = await buildSubmissionPayload(formFields, marker);
    payload[honeypotKey] = "http://spam.example/bot-filled-this";

    await submitForm(payload);

    expect(await ticketExistsForMarker(marker)).toBe(false);
  });
});

describe("SVG rejected, PNG stored safely outside the database", () => {
  it("rejects an SVG upload even when the content-type header claims image/png", async () => {
    const res = await upload(SVG_BUFFER, "evil.svg", "image/png");
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("accepts a genuine PNG and stores it under a random reference, not inline bytes", async () => {
    const res = await upload(PNG_BUFFER, "my-original-name.png", "image/png");
    expect(res.ok).toBe(true);

    const body = res.json ?? {};
    const stringValues = Object.values(body).filter((v): v is string => typeof v === "string");
    expect(stringValues.length).toBeGreaterThan(0);

    // The stored reference must not be the original filename...
    expect(stringValues.some((v) => v.includes("my-original-name"))).toBe(false);
    // ...and must not be the raw image data (base64/data-uri) inlined into
    // the JSON response — it should be a path/URL/key reference instead.
    expect(stringValues.some((v) => v.includes(PNG_BASE64))).toBe(false);
    expect(stringValues.some((v) => /^(https?:\/\/|\/|[a-z0-9-]+\/)/i.test(v) || /[a-f0-9-]{8,}/i.test(v))).toBe(true);
  });
});

describe("content sniffing rejects disguised non-image uploads", () => {
  it("rejects a plain-text file renamed to .png with no content-type override", async () => {
    const res = await upload(FAKE_TEXT_BUFFER, "evil.png", "text/plain");
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("rejects a plain-text file renamed to .png with a spoofed image/png content-type", async () => {
    const res = await upload(FAKE_TEXT_BUFFER, "evil.png", "image/png");
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});

describe("oversized submissions are rejected", () => {
  it("rejects a submission body far exceeding the configured max size, not truncate-and-accept", async () => {
    const marker = `oversized-${randomUUID()}`;
    const payload = await buildSubmissionPayload(formFields, marker);

    // Prefer a "long text" field for the oversized value (closest match to
    // tickets.description); fall back to the first text-ish key already in
    // the payload if the form has none.
    const longField = formFields.find((f) => String(f.field_type ?? f.type ?? "").toLowerCase().includes("long"));
    const targetKey = (longField && (longField.field_key ?? longField.key)) ?? Object.keys(payload)[0];
    payload[targetKey] = "A".repeat(10 * 1024 * 1024 + 1); // 10MB+1

    const res = await submitForm(payload);
    expect([400, 413]).toContain(res.status);
    expect(await ticketExistsForMarker(marker)).toBe(false);
  });
});

describe("rate limit returns 429", () => {
  it("returns 429 once a burst of submissions from the same IP exceeds the per-IP/per-form limit", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 25; i++) {
      const marker = `ratelimit-${randomUUID()}`;
      const payload = await buildSubmissionPayload(formFields, marker);
      const res = await submitForm(payload);
      statuses.push(res.status);
    }
    expect(statuses).toContain(429);
  });
});
