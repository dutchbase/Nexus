import { describe, expect, it } from "vitest";
import { capabilityFromRepo } from "./index.ts";

describe("capabilityFromRepo", () => {
  it("derives read-only capability from repo permissions", () => {
    expect(capabilityFromRepo({ permissions: { pull: true, push: false } }, null)).toMatchObject({ status: "ok", canRead: true, canWrite: false });
  });
  it("derives write capability from push permission", () => {
    expect(capabilityFromRepo({ permissions: { pull: true, push: true } }, null)).toMatchObject({ canWrite: true });
  });
  it("reports unauthorized when the repo is unreadable", () => {
    expect(capabilityFromRepo(null, null)).toMatchObject({ status: "unauthorized", canRead: false, canWrite: false });
  });
});
