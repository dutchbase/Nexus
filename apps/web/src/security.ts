import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { forbiddenClaudeAuthVariables } from "../../../packages/claude-runner/src/auth-guard.ts";

type Environment = Record<string, string | undefined>;
type RequestIdentity = { socket: { remoteAddress?: string | undefined }; headers: { [name: string]: string | string[] | undefined } };

const workerOnlyCredentials = ["GITHUB_TOKEN", "GH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", ...forbiddenClaudeAuthVariables];

export function validateWebRuntime(env: Environment = process.env) {
  const trustedProxyHops = Number(env.DCC_TRUST_PROXY_HOPS ?? "0");
  if (!Number.isInteger(trustedProxyHops) || trustedProxyHops < 0 || trustedProxyHops > 10) {
    throw new Error("DCC_TRUST_PROXY_HOPS must be an integer from 0 to 10");
  }
  const production = env.NODE_ENV === "production";
  if (env.DCC_PROCESS_ROLE !== "web") throw new Error("web requires DCC_PROCESS_ROLE=web");
  if (!production) return { production, trustedProxyHops };
  try {
    if (new URL(env.APP_BASE_URL ?? "").protocol !== "https:") throw new Error();
  } catch {
    throw new Error("production web requires a HTTPS APP_BASE_URL");
  }
  const credential = workerOnlyCredentials.find((key) => env[key]) ?? Object.keys(env).find((key) => key.startsWith("DCC_NOTIFICATION_SECRET_") && env[key]);
  if (credential) throw new Error(`production web must not receive ${credential}`);
  return { production, trustedProxyHops };
}

export function securityHeaders() {
  return {
    // ponytail: per-page inline scripts still need unsafe-inline; externalize scripts to drop it
    "content-security-policy": "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self'; img-src 'self' data:; connect-src 'self'",
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "permissions-policy": "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
  };
}

export function secureCookieAttributes(production: boolean) {
  return ["Path=/", "SameSite=Lax", ...(production ? ["Secure"] : [])];
}

export function csrfMatches(token: string, storedHash: string) {
  if (!/^[a-f0-9]{64}$/i.test(storedHash)) return false;
  const received = createHash("sha256").update(token).digest();
  const expected = Buffer.from(storedHash, "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export function clientIpOf(request: RequestIdentity, trustedProxyHops: number) {
  const socketIp = request.socket.remoteAddress ?? "unknown";
  if (!trustedProxyHops) return socketIp;
  const forwarded = request.headers["x-forwarded-for"];
  const addresses = (Array.isArray(forwarded) ? forwarded.join(",") : forwarded ?? "")
    .split(",").map((value) => value.trim());
  const selected = addresses[addresses.length - trustedProxyHops];
  return selected && isIP(selected) !== 0 ? selected : socketIp;
}
