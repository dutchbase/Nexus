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
export type NotificationConfigurationPatch = Partial<NotificationConfiguration>;

const configurationKeys = new Set(["base_url", "endpoint", "method", "timeout_seconds", "authentication"]);
const authenticationKeys = new Set(["type", "secret_reference"]);
const secretReferencePattern = /^DCC_NOTIFICATION_SECRET_[A-Za-z_][A-Za-z0-9_]*$/;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validAuthentication(value: unknown): value is NonNullable<NotificationConfiguration["authentication"]> {
  return object(value) && !Object.keys(value).some((key) => !authenticationKeys.has(key)) &&
    (value.type === "bearer" || value.type === "raw") &&
    typeof value.secret_reference === "string" && secretReferencePattern.test(value.secret_reference);
}

function hasUrlUserinfo(value: string) {
  try {
    const url = new URL(value, "https://notification.invalid");
    return Boolean(url.username || url.password);
  } catch {
    return false;
  }
}

export function safeNotificationConfiguration(value: unknown): NotificationConfiguration {
  if (!object(value)) return {};
  const safe: NotificationConfiguration = {};
  if (typeof value.base_url === "string" && value.base_url && !hasUrlUserinfo(value.base_url)) safe.base_url = value.base_url;
  if (typeof value.endpoint === "string" && value.endpoint && !hasUrlUserinfo(value.endpoint)) safe.endpoint = value.endpoint;
  if (value.method === "POST" || value.method === "PUT" || value.method === "PATCH") safe.method = value.method;
  if (typeof value.timeout_seconds === "number" && Number.isFinite(value.timeout_seconds) && value.timeout_seconds >= 1 && value.timeout_seconds <= 60) safe.timeout_seconds = value.timeout_seconds;
  if (validAuthentication(value.authentication)) safe.authentication = value.authentication;
  return safe;
}

export function safeNotificationProvider(value: unknown): any {
  if (!object(value)) return {};
  const provider: Record<string, unknown> = {};
  for (const key of ["id", "name", "type", "enabled", "created_at", "updated_at"]) {
    if (value[key] !== undefined) provider[key] = value[key];
  }
  provider.configuration_encrypted_json = safeNotificationConfiguration(value.configuration_encrypted_json);
  return provider;
}

export function parseNotificationConfigurationPatch(value: unknown): NotificationConfigurationPatch | null {
  if (!object(value) || Object.keys(value).some((key) => !configurationKeys.has(key))) return null;
  const safe = safeNotificationConfiguration(value);
  return Object.keys(value).every((key) => key in safe) ? safe : null;
}

export function parseNotificationConfiguration(value: unknown): NotificationConfiguration | null {
  return parseNotificationConfigurationPatch(value);
}

export function mergeNotificationConfiguration(existing: unknown, patch: NotificationConfigurationPatch): NotificationConfiguration {
  return { ...safeNotificationConfiguration(existing), ...patch };
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
  return reference && secretReferencePattern.test(reference) ? process.env[reference] : undefined;
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
      if (configuration.authentication && !secret) return { ok: false, responseStatus: null, errorMessage: "Notification secret is unavailable" };
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
