import { describe, expect, it } from "vitest";
import { aiModels, validateAiSelection, AiConfigurationError, isDeepSeekModel } from "./index.ts";

describe("deepseek-v4-flash / deepseek-v4-pro model registration", () => {
  it("are part of the global model list", () => {
    expect(aiModels).toEqual(["fable", "opus", "sonnet", "haiku", "deepseek-v4-flash", "deepseek-v4-pro"]);
  });
  it("accept low/medium/high", () => {
    for (const model of ["deepseek-v4-flash", "deepseek-v4-pro"]) {
      for (const level of ["low", "medium", "high"]) {
        expect(validateAiSelection({ model, reasoning_level: level }))
          .toEqual({ model, reasoning_level: level });
      }
    }
  });
  it("reject xhigh/max/ultracode", () => {
    for (const model of ["deepseek-v4-flash", "deepseek-v4-pro"]) {
      for (const level of ["xhigh", "max", "ultracode"]) {
        expect(() => validateAiSelection({ model, reasoning_level: level }))
          .toThrow(AiConfigurationError);
      }
    }
  });
  it("leaves claude model validation unchanged", () => {
    expect(validateAiSelection({ model: "opus", reasoning_level: "max" }))
      .toEqual({ model: "opus", reasoning_level: "max" });
    expect(() => validateAiSelection({ model: "gpt-4", reasoning_level: "low" }))
      .toThrow(AiConfigurationError);
  });
  it("rejects the old generic 'deepseek' name", () => {
    expect(() => validateAiSelection({ model: "deepseek", reasoning_level: "low" }))
      .toThrow(AiConfigurationError);
  });
});

describe("isDeepSeekModel", () => {
  it("is true for both deepseek models", () => {
    expect(isDeepSeekModel("deepseek-v4-flash")).toBe(true);
    expect(isDeepSeekModel("deepseek-v4-pro")).toBe(true);
  });
  it("is false for every other model, the old generic name, and empty string", () => {
    expect(isDeepSeekModel("sonnet")).toBe(false);
    expect(isDeepSeekModel("deepseek")).toBe(false);
    expect(isDeepSeekModel("")).toBe(false);
  });
});
