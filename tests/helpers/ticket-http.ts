import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import type { QueryClient } from "../../packages/domain/src/planning-inputs.ts";

export async function createTestSession(db: QueryClient, userId: string) {
  const token = randomBytes(32).toString("hex");
  const csrf = randomBytes(32).toString("hex");
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  await db.query(
    "INSERT INTO admin_sessions(user_id,token_hash,csrf_token_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",
    [userId, hash(token), hash(csrf)],
  );
  return { cookie: `dcc_session=${token}`, csrf };
}

export async function callRoute(path: string, input: {
  method?: string; body?: unknown; cookie?: string; csrf?: string;
} = {}) {
  const { route } = await import("../../apps/web/src/server.ts");
  const request = Object.assign(Readable.from(input.body === undefined ? [] : [Buffer.from(JSON.stringify(input.body))]), {
    url: path, method: input.method ?? "GET",
    headers: { host: "test", "content-type": "application/json", ...(input.cookie ? { cookie: input.cookie } : {}), ...(input.csrf ? { "x-csrf-token": input.csrf } : {}) },
    socket: { remoteAddress: "192.0.2.12" },
  });
  let status = 0, headers: Record<string, any> = {}, text = "";
  const response = {
    writeHead(code: number, values: Record<string, any>) { status = code; headers = values; },
    end(value?: unknown) { text += value == null ? "" : String(value); },
  };
  await route(request as any, response as any);
  return { status, headers, text, body: String(headers["content-type"] ?? "").includes("application/json") ? JSON.parse(text) : null };
}
