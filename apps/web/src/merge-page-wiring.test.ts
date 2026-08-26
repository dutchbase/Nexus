import { describe, expect, test, vi } from "vitest";

// Renders the real admin shell for /admin/merge and executes its inline
// script against a minimal DOM stub — catches broken wiring that static
// reading of the template misses.

process.env.DATABASE_URL ??= "postgresql://test/tee";

vi.mock("@dcc/database", () => ({
  pool: { query: vi.fn(async () => ({ rows: [{ id: "p1", name: "Widgets", default_branch: "master" }] })) },
}));

const { adminPage } = await import("./ui.ts");
const mergePage = await import("./pages/merge.ts");

type Stub = ReturnType<typeof makeElement>;

function makeElement(id: string | null) {
  const listeners: Record<string, Array<() => unknown>> = {};
  return {
    id,
    value: "",
    innerHTML: "",
    textContent: "",
    disabled: false,
    style: {} as Record<string, string>,
    dataset: {} as Record<string, string>,
    selectedOptions: [] as Array<{ dataset: Record<string, string> }>,
    options: [] as unknown[],
    addEventListener(event: string, handler: () => unknown) {
      (listeners[event] ??= []).push(handler);
    },
    dispatch(event: string) {
      return Promise.all((listeners[event] ?? []).map((handler) => handler()));
    },
  };
}

function stubDocument() {
  const projectSelect = makeElement("merge-project");
  const fromSelect = makeElement("merge-from");
  const intoSelect = makeElement("merge-into");
  const statusBox = makeElement(null);
  const button = makeElement(null);
  const reason = makeElement(null);
  const documentStub = {
    cookie: "",
    getElementById: (id: string) =>
      id === "merge-project" ? projectSelect : id === "merge-from" ? fromSelect : id === "merge-into" ? intoSelect : null,
    querySelector: (selector: string) =>
      selector === "[data-merge-status]" ? statusBox
        : selector === "[data-merge-button]" ? button
        : selector === "[data-merge-reason]" ? reason
        : null,
    querySelectorAll: () => [],
    documentElement: { dataset: {} as Record<string, string> },
    addEventListener: () => undefined,
    matchMedia: () => ({ matches: false, addEventListener: () => undefined }),
  };
  return { documentStub, projectSelect, fromSelect, intoSelect, statusBox, button, reason };
}

describe("merge workbench page wiring", () => {
  test("inline script attaches handlers and populates branches on project change", async () => {
    const page = await mergePage.render(new URL("http://x/admin/merge"), { username: "a", user_id: "u" }, {});
    expect(page).toBeTruthy();
    const shell = adminPage("/admin/merge", page!.title, page!.body, {}, "a");

    const scripts = [...shell.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
    expect(scripts.length).toBeGreaterThan(0);
    const wired = scripts.find((source) => source.includes("merge-project"));
    expect(wired).toBeDefined();

    const stubs = stubDocument();
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string): Promise<any> => {
      calls.push(url);
      if (url.includes("/merge-preview")) {
        return { ok: true, status: 202, json: async () => ({ job: { id: "job-1" } }) };
      }
      if (url.includes("/api/admin/jobs/")) {
        return {
          ok: true,
          json: async () => ({
            job: {
              status: "completed",
              result_json: {
                outcome: "branches_only",
                branches: [{ name: "master" }, { name: "staging" }],
                head: null,
                base: null,
                commits_ahead: null,
                conflicted_files: [],
              },
            },
          }),
        };
      }
      throw new Error("unexpected fetch " + url);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    // Execute exactly what the browser would execute.
    new Function("document", "fetch", "sessionStorage", "localStorage", "location", "confirm", "alert", "matchMedia", "window", wired!)(
      stubs.documentStub,
      fetchMock,
      { getItem: () => "csrf" },
      { getItem: () => null, setItem: () => undefined },
      { href: "" },
      () => true,
      () => undefined,
      () => ({ matches: false, addEventListener: () => undefined }),
      { location: { pathname: "/admin/merge" } },
    );

    stubs.projectSelect.value = "p1";
    await stubs.projectSelect.dispatch("change");
    await new Promise((resolve) => setTimeout(resolve, 2500));
    if (stubs.fromSelect.innerHTML.includes("Loading")) console.error("DEBUG status:", stubs.statusBox.textContent, "reason:", stubs.reason.textContent);

    expect(calls.some((url) => url.includes("/merge-preview"))).toBe(true);
    expect(stubs.fromSelect.innerHTML).toContain("staging");
    expect(stubs.intoSelect.innerHTML).toContain("master");
    // Default "from" is the project default branch.
    expect(stubs.fromSelect.value).toBe("master");
    expect(stubs.button.disabled).toBe(true);
    expect(stubs.reason.textContent).toContain("merge into");
  });

  test("a clean verdict enables the button and a conflict keeps it off with reasons", async () => {
    const page = await mergePage.render(new URL("http://x/admin/merge"), { username: "a", user_id: "u" }, {});
    const shell = adminPage("/admin/merge", page!.title, page!.body, {}, "a");
    const wired = [...shell.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).find((s) => s.includes("merge-project"))!;

    for (const verdict of [
      {
        outcome: "clean",
        expectDisabled: false,
        reasonFragment: "Ready",
        result: { outcome: "clean", commits_ahead: 3, head: { name: "staging", sha: "a".repeat(40) }, base: { name: "master", sha: "b".repeat(40) } },
      },
      {
        outcome: "conflict",
        expectDisabled: true,
        reasonFragment: "",
        result: { outcome: "conflict", conflicted_files: ["shared.txt"], head: null, base: null },
      },
    ]) {
      const stubs = stubDocument();
      stubs.projectSelect.value = "p1";
      stubs.fromSelect.value = "staging";
      stubs.intoSelect.value = "master";
      let requested: any = {};
      globalThis.fetch = vi.fn(async (url: string, init?: any): Promise<any> => {
        if (url.includes("/merge-preview")) {
          requested = JSON.parse(init?.body ?? "{}");
          return { ok: true, status: 202, json: async () => ({ job: { id: "j" } }) };
        }
        if (url.includes("/api/admin/jobs/")) {
          const paired = Boolean(requested.head && requested.base);
          return {
            ok: true,
            json: async () => ({
              job: {
                status: "completed",
                result_json: paired
                  ? verdict.result
                  : { outcome: "branches_only", branches: [{ name: "staging" }, { name: "master" }] },
              },
            }),
          };
        }
        throw new Error("unexpected");
      }) as unknown as typeof fetch;

      new Function("document", "fetch", "sessionStorage", "localStorage", "location", "confirm", "alert", "matchMedia", "window", wired)(
        stubs.documentStub,
        globalThis.fetch,
        { getItem: () => "csrf" },
        { getItem: () => null, setItem: () => undefined },
        { href: "" },
        () => true,
        () => undefined,
        () => ({ matches: false, addEventListener: () => undefined }),
        { location: { pathname: "/admin/merge" } },
      );
      stubs.intoSelect.dispatch("change");
      await new Promise((resolve) => setTimeout(resolve, 1200));

      expect(stubs.button.disabled).toBe(verdict.expectDisabled);
      if (verdict.expectDisabled) expect(stubs.statusBox.textContent.toLowerCase()).toContain("conflict");
      else expect(stubs.reason.textContent).toContain("3 commit");
    }
  });
});
