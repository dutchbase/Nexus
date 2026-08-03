export type NotificationResult = {
  ok: boolean;
  responseStatus: number | null;
  errorMessage: string | null;
};

export interface NotificationProvider {
  validateConfiguration(): Promise<{ valid: boolean; error?: string }>;
  send(message: unknown): Promise<NotificationResult>;
}

export type NotificationConfiguration = {
  base_url?: string;
  endpoint?: string;
  method?: "POST" | "PUT" | "PATCH";
  timeout_seconds?: number;
  authentication?: { type: "bearer" | "raw"; secret_reference: string };
};

const configurationKeys = new Set(["base_url", "endpoint", "method", "timeout_seconds", "authentication"]);
const authenticationKeys = new Set(["type", "secret_reference"]);

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseNotificationConfiguration(value: unknown): NotificationConfiguration | null {
  if (!object(value) || Object.keys(value).some((key) => !configurationKeys.has(key))) return null;
  const { base_url, endpoint, method, timeout_seconds, authentication } = value;
  if (base_url !== undefined && (typeof base_url !== "string" || !base_url)) return null;
  if (endpoint !== undefined && (typeof endpoint !== "string" || !endpoint)) return null;
  if (method !== undefined && method !== "POST" && method !== "PUT" && method !== "PATCH") return null;
  if (timeout_seconds !== undefined && (typeof timeout_seconds !== "number" || !Number.isFinite(timeout_seconds) || timeout_seconds < 1 || timeout_seconds > 60)) return null;
  if (authentication !== undefined) {
    if (!object(authentication) || Object.keys(authentication).some((key) => !authenticationKeys.has(key)) ||
      (authentication.type !== "bearer" && authentication.type !== "raw") ||
      typeof authentication.secret_reference !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(authentication.secret_reference)) return null;
  }
  return value as NotificationConfiguration;
}

function endpointFor(configuration: NotificationConfiguration) {
  if (!configuration.endpoint) return null;
  try {
    return new URL(configuration.endpoint, configuration.base_url).toString();
  } catch {
    return null;
  }
}

function secretValue(reference?: string) {
  return reference ? process.env[reference] : undefined;
}

export function createNotificationProvider(type: string, input: unknown): NotificationProvider {
  const configuration = parseNotificationConfiguration(input);
  return {
    async validateConfiguration() {
      if (type === "whatsapp") return { valid: false, error: "WhatsApp API specification is not configured" };
      return configuration && endpointFor(configuration)
        ? { valid: true }
        : { valid: false, error: "A valid notification configuration is required" };
    },
    async send(message) {
      if (type === "whatsapp") return { ok: false, responseStatus: null, errorMessage: "WhatsApp API specification is not configured" };
      const endpoint = configuration && endpointFor(configuration);
      if (!endpoint || !configuration) return { ok: false, responseStatus: null, errorMessage: "A valid notification configuration is required" };
      const secret = secretValue(configuration.authentication?.secret_reference);
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (secret) headers.authorization = configuration.authentication?.type === "bearer" ? `Bearer ${secret}` : secret;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), (configuration.timeout_seconds ?? 10) * 1000);
      try {
        const response = await fetch(endpoint, {
          method: configuration.method ?? "POST", headers, body: JSON.stringify(message), signal: controller.signal,
        });
        return {
          ok: response.ok,
          responseStatus: response.status,
          errorMessage: response.ok ? null : `Notification endpoint returned HTTP ${response.status}`,
        };
      } catch {
        return { ok: false, responseStatus: null, errorMessage: "Notification request failed" };
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

export function redactNotificationError(value: string | null) {
  if (!value) return value;
  return value
    .replace(/(authorization|api[-_ ]?key|token|secret)(\s*[:=]\s*)([^\s,;]+)/gi, "$1$2[REDACTED]")
    .slice(0, 2000);
}
