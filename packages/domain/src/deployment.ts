type HealthConfig = { host: string; health_path: string; version_path: string; version_field?: string };

function dotPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<any>((acc, key) => (acc && typeof acc === "object" ? acc[key] : undefined), obj);
}

export type ProductionHealthResult = {
  state: "healthy" | "unhealthy" | "unreachable";
  healthy: boolean;
  commit_sha: string | null;
  raw: unknown;
};

export async function checkProductionHealth(health: HealthConfig): Promise<ProductionHealthResult> {
  try {
    const healthResponse = await fetch(`${health.host}${health.health_path}`, { signal: AbortSignal.timeout(8000) });
    if (!healthResponse.ok) return { state: "unhealthy", healthy: false, commit_sha: null, raw: null };
    const versionResponse = await fetch(`${health.host}${health.version_path}`, { signal: AbortSignal.timeout(8000) }).catch(() => null);
    const raw = versionResponse?.ok ? await versionResponse.json().catch(() => null) : null;
    const commit = raw ? dotPath(raw, health.version_field ?? "commit") : null;
    return { state: "healthy", healthy: true, commit_sha: typeof commit === "string" ? commit : null, raw };
  } catch {
    // fetch() throws on network failure, DNS failure, and AbortSignal.timeout firing —
    // all three mean "we could not reach it," distinct from "it responded and said no."
    return { state: "unreachable", healthy: false, commit_sha: null, raw: null };
  }
}

export type PromotionEligibilityInput = {
  ciState: "success" | "failure" | "pending" | "none" | "unknown";
  imageExists: boolean;
  e2eGateRequired: boolean;
  e2eGateSatisfied: boolean;
};
export type PromotionEligibilityResult = { eligible: boolean; reasons: string[] };

export function evaluatePromotionEligibility(input: PromotionEligibilityInput): PromotionEligibilityResult {
  const reasons: string[] = [];
  if (input.ciState !== "success") reasons.push("ci_not_green");
  if (!input.imageExists) reasons.push("image_not_built");
  if (input.e2eGateRequired && !input.e2eGateSatisfied) reasons.push("missing_e2e_label");
  return { eligible: reasons.length === 0, reasons };
}
