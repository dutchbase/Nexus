import { expect, test } from "vitest";
import { validateDeploymentConfig } from "./index.ts";

test("accepts undefined (deployment is optional)", () => {
  expect(validateDeploymentConfig(undefined)).toEqual([]);
});

test("accepts enabled:false with nothing else present", () => {
  expect(validateDeploymentConfig({ enabled: false })).toEqual([]);
});

test("accepts a fully valid config", () => {
  expect(validateDeploymentConfig({
    enabled: true,
    production_branch: "production",
    image: { registry: "ghcr.io", repository: "acme/jobs-platform", tag_template: "sha-{{commit}}" },
    health: { host: "https://jobs.acme.com", health_path: "/api/health", version_path: "/api/version" },
    promotion: { require_e2e_gate_label: true, e2e_gate_label: "e2e-verified" },
  })).toEqual([]);
});

test("rejects enabled:true missing production_branch and image", () => {
  const errors = validateDeploymentConfig({ enabled: true, health: { host: "https://x.com", health_path: "/h", version_path: "/v" }, promotion: { require_e2e_gate_label: false } });
  expect(errors).toContain("deployment.production_branch is required");
  expect(errors).toContain("deployment.image is required");
});

test("rejects a tag_template without {{commit}}", () => {
  const errors = validateDeploymentConfig({
    enabled: true, production_branch: "production",
    image: { registry: "ghcr.io", repository: "acme/x", tag_template: "latest" },
    health: { host: "https://x.com", health_path: "/h", version_path: "/v" },
    promotion: { require_e2e_gate_label: false },
  });
  expect(errors).toContain("deployment.image.tag_template must contain {{commit}}");
});

test("rejects a malformed cron_jobs entry", () => {
  const errors = validateDeploymentConfig({
    enabled: true, production_branch: "production",
    image: { registry: "ghcr.io", repository: "acme/x", tag_template: "sha-{{commit}}" },
    health: { host: "https://x.com", health_path: "/h", version_path: "/v" },
    promotion: { require_e2e_gate_label: false },
    cron_jobs: [{ key: "digest" }],
  });
  expect(errors).toContain("deployment.cron_jobs[0].expected_interval_minutes must be a positive number");
});
