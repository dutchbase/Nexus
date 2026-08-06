import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { styles } from "./ui.ts";

const here = dirname(fileURLToPath(import.meta.url));
const ticketsSource = readFileSync(join(here, "pages/tickets.ts"), "utf8");
const prsSource = readFileSync(join(here, "pages/prs.ts"), "utf8");

describe("responsive layout", () => {
  it("stylesheet keeps touch targets two-dimensional and labels compact rows", () => {
    expect(styles).toContain("min-width:44px");
    expect(styles).toContain("content:attr(data-label)");
  });

  it("ticket filter/board grids no longer hard-code a fixed min-width", () => {
    expect(ticketsSource).not.toContain("min-width:600px");
    expect(ticketsSource).toContain("min-width:min(600px,100%)");
  });

  it("PR toolbar grids no longer hard-code a fixed min-width", () => {
    expect(prsSource).not.toContain("min-width:300px");
    expect(prsSource).not.toContain("min-width:280px");
  });

  it("PR rows label each cell for compact/mobile display", () => {
    for (const label of ["PR", "Project", "Merge status", "AI status", "Conflicts", "Created"]) {
      expect(prsSource).toContain(`data-label="${label}"`);
    }
  });
});
