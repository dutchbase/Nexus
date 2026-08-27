import { describe, expect, it } from "vitest";
import { styles } from "./ui.ts";

describe("design tokens: elevation, focus, interaction", () => {
  it("defines --shadow, --shadow-sm, and --ring in both themes", () => {
    expect(styles).toContain("--shadow:0 1px 2px rgba(11,35,86,.06)");
    expect(styles).toContain("--shadow-sm:0 1px 2px rgba(11,35,86,.05)");
    expect(styles).toContain("--shadow:0 1px 2px rgba(0,0,0,.45)");
    expect(styles).toContain("--shadow-sm:0 1px 2px rgba(0,0,0,.40)");
    expect((styles.match(/--ring:/g) ?? []).length).toBe(2);
  });
  it("applies interaction transitions to form controls and links only", () => {
    expect(styles).toContain("button,a,input,select,textarea { transition:background-color .15s ease,border-color .15s ease,color .15s ease,box-shadow .15s ease,transform .15s ease }");
  });
  it("scrollbar thumb has a hover state using --text3", () => {
    expect(styles).toContain("::-webkit-scrollbar-thumb:hover { background:var(--text3) }");
  });
  it("reduced-motion query still zeroes transition-duration for all elements", () => {
    expect(styles).toContain("transition-duration:.01ms !important");
  });
  it("adds a focus-visible ring glow to form controls and buttons without removing the outline", () => {
    expect(styles).toContain(":focus-visible { outline:2px solid var(--primary);outline-offset:1px }");
    expect(styles).toContain("input:focus-visible,select:focus-visible,textarea:focus-visible,button:focus-visible { box-shadow:var(--ring) }");
  });
});
