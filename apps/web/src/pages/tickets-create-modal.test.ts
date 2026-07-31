import { describe, expect, it } from "vitest";
import { ticketCreateModal } from "./tickets.ts";

describe("ticketCreateModal", () => {
  it("provides the complete admin ticket intake for the available projects", () => {
    const html = ticketCreateModal([{ id: "project-1", name: "Website <admin>" }]);

    expect(html).toContain('data-add-ticket-button');
    expect(html).toContain('data-add-ticket-modal');
    expect(html).toContain('<option value="project-1">Website &lt;admin&gt;</option>');
    for (const name of ["project_id", "title", "description", "category", "priority", "environment", "expected_behavior", "actual_behavior", "reproduction_steps"]) {
      expect(html).toContain(`name="${name}"`);
    }
  });
});
