import { describe, expect, test, vi } from "vitest";

process.env.DCC_PROCESS_ROLE = "web";

vi.mock("@dcc/database", () => ({
  artifactDataRoot: () => "/primary",
  legacyArtifactDataRoot: () => "/legacy",
  finalizeArtifact: vi.fn(),
  inTransaction: vi.fn(),
  pool: { query: vi.fn() },
  readArtifact: vi.fn(),
  readStagedArtifact: vi.fn(),
  stageArtifact: vi.fn(),
}));

const { validateFields, normalizeFields } = await import("./server.ts");

const field = (overrides: any) => ({ field_key: "f", required: false, validation_json: {}, options_json: [], ...overrides });

describe("validateFields", () => {
  test("validates optional email and url values when present", () => {
    expect(validateFields([field({ field_type: "email" })], { f: "not-an-email" })).toEqual({ f: "invalid email" });
    expect(validateFields([field({ field_type: "url" })], { f: "not a url" })).toEqual({ f: "invalid URL" });
    expect(validateFields([field({ field_type: "email" })], {})).toEqual({});
  });
  test("rejects non-http(s) URL schemes", () => {
    expect(validateFields([field({ field_type: "url" })], { f: "javascript:alert(1)" })).toEqual({ f: "invalid URL" });
    expect(validateFields([field({ field_type: "url" })], { f: "https://example.com" })).toEqual({});
  });
  test("select/radio/multiselect values must belong to configured options", () => {
    const options = ["alpha", "beta"];
    for (const field_type of ["dropdown", "radio", "category_selector", "environment_selector"]) {
      expect(validateFields([field({ field_type, options_json: options })], { f: "gamma" })).toEqual({ f: "invalid option" });
      expect(validateFields([field({ field_type, options_json: options })], { f: "alpha" })).toEqual({});
    }
    expect(validateFields([field({ field_type: "multi_select", options_json: options })], { f: ["alpha", "gamma"] })).toEqual({ f: "invalid option" });
    expect(validateFields([field({ field_type: "multi_select", options_json: options })], { f: ["alpha", "beta"] })).toEqual({});
  });
  test("option fields reject values of the wrong JS shape instead of coercing them", () => {
    const options = ["alpha", "beta"];
    expect(validateFields([field({ field_type: "dropdown", options_json: options })], { f: ["alpha"] })).toEqual({ f: "invalid option" });
    expect(validateFields([field({ field_type: "multi_select", options_json: options })], { f: "alpha" })).toEqual({ f: "invalid option" });
  });
  test("optional empty values for option fields pass, required empty fail", () => {
    expect(validateFields([field({ field_type: "dropdown", options_json: ["a"] })], {})).toEqual({});
    expect(validateFields([field({ field_type: "dropdown", options_json: ["a"], required: true })], {})).toEqual({ f: "required" });
  });
});

describe("normalizeFields", () => {
  test("rejects option-bearing fields without a non-empty string option list", () => {
    expect(() => normalizeFields([{ field_key: "f", field_type: "dropdown", options_json: [] }])).toThrow();
    expect(() => normalizeFields([{ field_key: "f", field_type: "radio", options_json: [1, 2] }])).toThrow();
    expect(normalizeFields([{ field_key: "f", field_type: "dropdown", options_json: ["a"] }])).toHaveLength(1);
  });
});
