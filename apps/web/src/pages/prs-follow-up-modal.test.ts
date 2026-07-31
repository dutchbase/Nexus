import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("pull request follow-up modal", () => {
  it("allows immediate manual ticket creation and offers background AI drafting", async () => {
    const html = await readFile(new URL("./prs.ts", import.meta.url), "utf8");

    expect(html).toContain('name="feedback" rows="4"');
    expect(html).toContain('name="description" rows="4"');
    expect(html).toContain('name="generate_description" type="checkbox" checked');
    expect(html).not.toContain('data-generate-follow-up-description');
    expect(html).toContain('type="submit">Create</button>');
  });

  it("queues AI drafting after ticket creation without blocking navigation", async () => {
    const script = await readFile(new URL("../ui.ts", import.meta.url), "utf8");

    expect(script).toContain('ticket_id:result.ticket.id,initial_description:description.value');
    expect(script).toContain('keepalive:true');
    expect(script).not.toContain('pollFollowUpDescription');
  });
});
