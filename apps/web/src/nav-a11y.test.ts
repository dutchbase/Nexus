import { describe, expect, it } from "vitest";
import { adminPage } from "./ui.ts";

describe("nav and tab accessibility", () => {
  const page = adminPage("/admin/tickets", "Tickets", "", {}, "admin");
  it("hamburger exposes expanded state and controls the sidebar", () => {
    expect(page).toContain('aria-expanded="false"');
    expect(page).toContain('aria-controls="sidebar"');
    expect(page).toContain('id="sidebar"');
  });
  it("script wires Escape close, focus restore, and roving tab keys", () => {
    expect(page).toContain('e.key==="Escape"');
    expect(page).toContain("opener?.focus()");
    for (const key of ["ArrowRight", "ArrowLeft", '"Home"', '"End"']) expect(page).toContain(key);
  });
  it("shows AI usage under Operate", () => {
    expect(adminPage("/admin/ai-usage", "AI usage", "", {}, "admin")).toContain('href="/admin/ai-usage"');
  });
});
