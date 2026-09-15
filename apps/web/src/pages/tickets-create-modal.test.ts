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

  it("includes maxlength constraints on input and textarea fields", () => {
    const html = ticketCreateModal([{ id: "project-1", name: "Test Project" }]);

    // Title input has maxlength="200"
    expect(html).toContain('name="title" required maxlength="200"');

    // Description textarea has maxlength="10000"
    expect(html).toContain('name="description" rows="4" required maxlength="10000"');

    // Expected behavior textarea has maxlength="10000"
    expect(html).toContain('name="expected_behavior" rows="3" maxlength="10000"');

    // Actual behavior textarea has maxlength="10000"
    expect(html).toContain('name="actual_behavior" rows="3" maxlength="10000"');

    // Reproduction steps textarea has maxlength="10000"
    expect(html).toContain('name="reproduction_steps" rows="3" maxlength="10000"');
  });
});
