import { describe, expect, it, vi } from "vitest";

process.env.DCC_PROCESS_ROLE = "web";

vi.mock("@dcc/database", () => ({
  artifactDataRoot: () => "/primary", legacyArtifactDataRoot: () => "/legacy",
  finalizeArtifact: vi.fn(), inTransaction: vi.fn(), pool: { query: vi.fn() }, readArtifact: vi.fn(), readStagedArtifact: vi.fn(), stageArtifact: vi.fn(),
}));

const { errorEnvelope, operationalError } = await import("./server.ts");

describe("errorEnvelope", () => {
  it("adds a stable error_code and recovery_action to a 409", () => {
    const e = errorEnvelope(Object.assign(new Error("conflict"), { status: 409 }));
    expect(e).toMatchObject({ error: "conflict", error_code: "http_409" });
    expect(e.recovery_action).toContain("Reload");
  });
  it("masks 5xx messages but still returns error_code and recovery_action", () => {
    const e = errorEnvelope(new Error("secret internals"));
    expect(e.error).toBe("internal error");
    expect(e.error_code).toBe("http_500");
    expect(e.recovery_action).toBeTruthy();
  });
  it("uses explicit code and recovery from operationalError", () => {
    const e = errorEnvelope(operationalError("nope", { status: 409, code: "ticket_not_submitted", recovery: "Refresh the ticket." }));
    expect(e.error_code).toBe("ticket_not_submitted");
    expect(e.recovery_action).toBe("Refresh the ticket.");
  });
});
