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
    expect(validateFields([field({ field_type: "dropdown", options_json: options })], { f: ["alpha"] })).toEqual({ f: "invalid value" });
    expect(validateFields([field({ field_type: "multi_select", options_json: options })], { f: "alpha" })).toEqual({ f: "invalid value" });
  });
  test("optional empty values for option fields pass, required empty fail", () => {
    expect(validateFields([field({ field_type: "dropdown", options_json: ["a"] })], {})).toEqual({});
    expect(validateFields([field({ field_type: "dropdown", options_json: ["a"], required: true })], {})).toEqual({ f: "required" });
  });
  test("rejects wrong scalar types and an empty required multi-select", () => {
    expect(validateFields([field({ field_type: "url" })], { f: true })).toEqual({ f: "invalid value" });
    expect(validateFields([field({ field_type: "multi_select", options_json: ["a"], required: true })], { f: [] })).toEqual({ f: "required" });
  });
  test("requires consent checkboxes to be checked", () => {
    expect(validateFields([field({ field_type: "checkbox", required: true })], { f: false })).toEqual({ f: "required" });
    expect(validateFields([field({ field_type: "checkbox", required: true })], { f: true })).toEqual({});
  });
  test("requires finite numbers inside configured bounds", () => {
    const number = field({ field_type: "number", validation_json: { min: 1, max: 10 } });
    expect(validateFields([number], { f: "not-a-number" })).toEqual({ f: "invalid number" });
    expect(validateFields([number], { f: "Infinity" })).toEqual({ f: "invalid number" });
    expect(validateFields([number], { f: "0" })).toEqual({ f: "must be at least 1" });
    expect(validateFields([number], { f: "11" })).toEqual({ f: "must be at most 10" });
    expect(validateFields([number], { f: "4.5" })).toEqual({});
    expect(validateFields([number], { f: "" })).toEqual({});
  });
});

describe("normalizeFields", () => {
  test("reserves one jam_url field for Jam links", () => {
    expect(normalizeFields([{ field_key: "jam_url", field_type: "jam_link" }])).toHaveLength(1);
    expect(() => normalizeFields([{ field_key: "other", field_type: "jam_link" }])).toThrow(/unique jam_url/);
    expect(() => normalizeFields([{ field_key: "jam_url", field_type: "url" }])).toThrow(/unique jam_url/);
    expect(() => normalizeFields([{ field_key: "jam_url", field_type: "jam_link" }, { field_key: "jam_url", field_type: "jam_link" }])).toThrow(/unique jam_url/);
  });
  test("rejects option-bearing fields without a non-empty string option list", () => {
    expect(() => normalizeFields([{ field_key: "f", field_type: "dropdown", options_json: [] }])).toThrow();
    expect(() => normalizeFields([{ field_key: "f", field_type: "radio", options_json: [1, 2] }])).toThrow();
    expect(normalizeFields([{ field_key: "f", field_type: "dropdown", options_json: ["a"] }])).toHaveLength(1);
  });
  test("rejects unusable field validation rules", () => {
    expect(() => normalizeFields([{ field_key: "f", field_type: "number", validation_json: { min: 5, max: 1 } }])).toThrow(/validation/);
    expect(() => normalizeFields([{ field_key: "f", field_type: "short_text", validation_json: { max_length: -1 } }])).toThrow(/validation/);
  });
});
