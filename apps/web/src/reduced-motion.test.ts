import { describe, expect, it } from "vitest";
import { styles } from "./ui.ts";

describe("reduced motion", () => {
  it("suppresses animation and smooth scrolling when prefers-reduced-motion is set", () => {
    expect(styles).toContain("prefers-reduced-motion");
    expect(styles).toContain("animation-duration:.01ms");
    expect(styles).toContain("scroll-behavior:auto");
  });
});
