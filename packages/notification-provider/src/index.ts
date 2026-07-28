export type NotificationResult = {
  ok: boolean;
  responseStatus: number | null;
  errorMessage: string | null;
};

export interface NotificationProvider {
  validateConfiguration(): Promise<{ valid: boolean; error?: string }>;
  send(message: unknown): Promise<NotificationResult>;
}

type Configuration = {
  base_url?: string | null;
  endpoint?: string | null;
  method?: string;
  headers?: Record<string, string>;
  authorization_header?: string;
  authentication?: { type?: string; secret_reference?: string };
  api_key_reference?: string;
  timeout_seconds?: number;
};

function endpointFor(configuration: Configuration) {
  if (!configuration.endpoint) return null;
  try {
    return new URL(configuration.endpoint, configuration.base_url ?? undefined).toString();
  } catch {
    return null;
  }
}

function secretValue(reference?: string) {
  return reference ? process.env[reference] : undefined;
}

export function createNotificationProvider(type: string, configuration: Configuration): NotificationProvider {
  return {
    async validateConfiguration() {
      if (type === "whatsapp") return { valid: false, error: "WhatsApp API specification is not configured" };
      return endpointFor(configuration)
        ? { valid: true }
        : { valid: false, error: "A valid notification endpoint is required" };
    },
    async send(message) {
      if (type === "whatsapp") {
        return { ok: false, responseStatus: null, errorMessage: "WhatsApp API specification is not configured" };
      }
      const endpoint = endpointFor(configuration);
      if (!endpoint) return { ok: false, responseStatus: null, errorMessage: "A valid notification endpoint is required" };
      const headers: Record<string, string> = { "content-type": "application/json", ...configuration.headers };
      if (configuration.authorization_header) headers.authorization = configuration.authorization_header;
      const secret = secretValue(configuration.authentication?.secret_reference ?? configuration.api_key_reference);
      if (secret) {
        headers.authorization = configuration.authentication?.type === "bearer" ? `Bearer ${secret}` : secret;
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), Math.max(1, configuration.timeout_seconds ?? 10) * 1000);
      try {
        const response = await fetch(endpoint, {
          method: configuration.method ?? "POST", headers, body: JSON.stringify(message), signal: controller.signal,
        });
        return {
          ok: response.ok,
          responseStatus: response.status,
          errorMessage: response.ok ? null : `Notification endpoint returned HTTP ${response.status}`,
        };
      } catch (error) {
        return {
          ok: false, responseStatus: null,
          errorMessage: error instanceof Error ? error.message : "Notification request failed",
        };
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
