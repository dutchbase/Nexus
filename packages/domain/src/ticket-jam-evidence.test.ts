import { describe, expect, test } from "vitest";
import { renderJamEvidence, ticketJamEvidence, type JamEvidence } from "./ticket-jam.ts";

const evidence: JamEvidence = {
  sourceUrl: "https://jam.dev/c/capture-a", device: { browser: "Test Browser" },
  console: [{ level: "error", message: "save failed" }], network: [], events: [], metadata: {},
  unavailableSections: ["transcript"], truncatedSections: [],
};

describe("Jam evidence boundaries", () => {
  test("renders a bounded explicitly untrusted block", () => {
    const rendered = renderJamEvidence({ ...evidence, transcript: "x".repeat(40000) });
    expect(rendered).toContain("Untrusted ticket evidence");
    expect(rendered).toContain("save failed");
    expect(rendered).toContain(evidence.sourceUrl);
    expect(Buffer.byteLength(rendered, "utf8")).toBeLessThanOrEqual(32768);
  });

  test.each([0, 1, 8, 20, 21, 22, 23, 64])("honors a %i-byte limit at multibyte boundaries", (maxBytes) => {
    const rendered = renderJamEvidence({ ...evidence, transcript: "😀".repeat(100) }, maxBytes);
    expect(Buffer.byteLength(rendered, "utf8")).toBeLessThanOrEqual(maxBytes);
    expect(rendered).not.toContain("�");
  });

  test("only returns current evidence for a visible ticket", async () => {
    const query = async (sql: string) => {
      expect(sql).toContain("t.submitter_deleted_at IS NULL");
      expect(sql).toContain("c.source_url=t.jam_url");
      expect(sql).toContain("c.state IN ('ready','partial')");
      return { rows: [{ data_json: evidence }] };
    };
    await expect(ticketJamEvidence({ query } as any, "ticket")).resolves.toEqual(evidence);
  });
});
