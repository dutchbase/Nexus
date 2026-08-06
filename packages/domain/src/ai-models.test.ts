import { describe, expect, it } from "vitest";
import { aiModels, validateAiSelection, AiConfigurationError } from "./index.ts";

describe("deepseek model registration", () => {
  it("is part of the global model list", () => {
    expect(aiModels).toEqual(["fable", "opus", "sonnet", "haiku", "deepseek"]);
  });
  it("accepts low/medium/high", () => {
    for (const level of ["low", "medium", "high"]) {
      expect(validateAiSelection({ model: "deepseek", reasoning_level: level }))
        .toEqual({ model: "deepseek", reasoning_level: level });
    }
  });
  it("rejects xhigh/max/ultracode", () => {
    for (const level of ["xhigh", "max", "ultracode"]) {
      expect(() => validateAiSelection({ model: "deepseek", reasoning_level: level }))
        .toThrow(AiConfigurationError);
    }
  });
  it("leaves claude model validation unchanged", () => {
    expect(validateAiSelection({ model: "opus", reasoning_level: "max" }))
      .toEqual({ model: "opus", reasoning_level: "max" });
    expect(() => validateAiSelection({ model: "gpt-4", reasoning_level: "low" }))
      .toThrow(AiConfigurationError);
  });
});
