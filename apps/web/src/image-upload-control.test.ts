import { describe, expect, it } from "vitest";
import { clipboardImageType, imageUploadControl, imageUploadScript } from "./image-upload-control.ts";

class Element {
  dataset: Record<string, string> = {};
  children: Element[] = [];
  listeners: Record<string, Array<(event: any) => any>> = {};
  parent: Element | null = null;
  textContent = ""; value = ""; disabled = false; files: any[] = []; type = ""; className = ""; style: any = {};
  constructor(public tagName = "div") {}
  append(...items: Element[]) { for (const item of items) { item.parent = this; this.children.push(item); } }
  remove() { this.parent!.children = this.parent!.children.filter((item) => item !== this); }
  addEventListener(type: string, listener: (event: any) => any) { (this.listeners[type] ??= []).push(listener); }
  async fire(type: string, target: Element = this) { await Promise.all((this.listeners[type] ?? []).map((listener) => listener({ target }))); }
  closest(selector: string): Element | null {
    if (selector === this.tagName) return this;
    const key = selector.match(/^\[data-([\w-]+)\]$/)?.[1]?.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    return key && key in this.dataset ? this : this.parent?.closest(selector) ?? null;
  }
  querySelector(selector: string): Element | null { return this.querySelectorAll(selector)[0] ?? null; }
  querySelectorAll(selector: string): Element[] {
    const matches = (item: Element) => selector === "small" ? item.tagName === "small"
      : selector === "button,input" ? ["button", "input"].includes(item.tagName)
      : selector === "[data-image-entry]" ? "imageEntry" in item.dataset
      : selector === "[data-image-list]" ? "imageList" in item.dataset
      : selector === "[data-image-error]" ? "imageError" in item.dataset
      : selector === "[data-image-picker]" ? "imagePicker" in item.dataset
      : selector === "[data-image-paste]" ? "imagePaste" in item.dataset
      : selector === "[data-image-remove]" ? "imageRemove" in item.dataset
      : selector === "[data-image-retry]" ? "imageRetry" in item.dataset : false;
    return this.children.flatMap((item) => [matches(item) ? item : null, ...item.querySelectorAll(selector)]).filter(Boolean) as Element[];
  }
}

function fixture(options: { public?: boolean; required?: boolean; project?: string } = {}) {
  const form = new Element("form") as any;
  form.dataset.projectId = options.project ?? "project-1";
  form.elements = {};
  const control = new Element("fieldset"); control.dataset.imageControl = "screenshots";
  control.dataset.uploadUrl = options.public ? "/api/public/forms/report/uploads" : "/api/projects/{project_id}/uploads";
  if (options.required) control.dataset.required = "";
  const list = new Element("ul"); list.dataset.imageList = "";
  const error = new Element("p"); error.dataset.imageError = "screenshots";
  const picker = new Element("input"); picker.dataset.imagePicker = "";
  const paste = new Element("button"); paste.dataset.imagePaste = "";
  control.append(paste, picker, list, error); form.append(control);
  const select = new Element("select") as any; select.value = options.project ?? ""; select.form = form; form.elements.project_id = select;
  const document = {
    cookie: "dcc_csrf=cookie-token",
    createElement: (tag: string) => new Element(tag),
    querySelectorAll: (selector: string) => selector === "[data-image-control]" ? [control] : selector === 'select[name="project_id"]' ? [select] : [],
  };
  const requests: any[] = [], aborts: any[] = [];
  class FormData { append(..._args: any[]) {} }
  class File { size: number; constructor(_parts: any[], public name: string, public options: any) { this.size = 8; } get type() { return this.options.type; } }
  class FileReader { result = "data:image/png"; listener?: () => void; addEventListener(_type: string, fn: () => void) { this.listener = fn; } readAsDataURL() { this.listener?.(); } }
  class AbortController { signal = {}; abort() { aborts.push(true); } }
  const root: any = {
    document, isSecureContext: true, navigator: { clipboard: { read: async () => [] } },
    sessionStorage: { getItem: () => "session-token" }, crypto: { randomUUID: (() => { let id = 0; return () => `entry-${++id}`; })() },
    FormData, File, FileReader, AbortController,
    fetch: async (url: string, init: any) => { requests.push({ url, init }); return { ok: true, json: async () => ({ upload_id: `upload-${requests.length}` }) }; },
  };
  new Function("window", "document", "navigator", "sessionStorage", "crypto", "fetch", "FormData", "File", "FileReader", "AbortController",
    imageUploadScript())(root, document, root.navigator, root.sessionStorage, root.crypto, root.fetch, FormData, File, FileReader, AbortController);
  return { root, form, control, list, error, picker, paste, select, requests, aborts };
}

const png = { type: "image/png", size: 8, name: "shot.png" };

describe("image upload control", () => {
  it("prefers PNG and accepts only supported clipboard image types", () => {
    expect(clipboardImageType(["text/html", "image/png", "image/jpeg"])).toBe("image/png");
    expect(clipboardImageType(["text/plain"])).toBeNull();
    expect(clipboardImageType(["image/svg+xml"])).toBeNull();
  });

  it("renders accessible non-submitting controls and existing images", () => {
    const html = imageUploadControl({
      fieldKey: "screenshots", label: "Screenshots", required: true,
      uploadUrl: "/api/projects/project-1/uploads",
      existing: [{ id: "attachment-1", upload_id: "upload-1", field_key: "screenshots", original_name: "saved.png", media_type: "image/png", size_bytes: 8, url: "/attachments/attachment-1" }],
    });
    expect(html).toContain(">Paste<");
    expect(html).toContain("Choose files");
    expect(html).toContain('type="button"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('data-image-error="screenshots"');
    expect(html).toContain("Remove");
    expect(html).not.toContain(" required");
  });

  it("pastes through the public endpoint without CSRF and picker uploads include CSRF", async () => {
    const publicControl = fixture({ public: true });
    publicControl.root.navigator.clipboard.read = async () => [{ types: ["image/png"], getType: async () => png }];
    await publicControl.paste.fire("click");
    expect(publicControl.requests[0]).toMatchObject({ url: "/api/public/forms/report/uploads", init: { headers: {} } });

    const authenticated = fixture({ project: "project-1" });
    authenticated.picker.files = [png];
    await authenticated.picker.fire("change");
    expect(authenticated.requests[0]).toMatchObject({ url: "/api/projects/project-1/uploads", init: { headers: { "x-csrf-token": "session-token" } } });
    expect(authenticated.root.nexusImages.selections(authenticated.form)).toEqual({ screenshots: ["upload-1"] });
  });

  it("aborts removed uploads and retries a failed upload only once per click", async () => {
    const page = fixture({ project: "project-1" });
    let resolveUpload!: (value: any) => void;
    page.root.fetch = (_url: string, init: any) => { page.requests.push({ init }); return new Promise((resolve) => { resolveUpload = resolve; }); };
    // Reinstall so the controller captures the replacement fetch.
    page.control.listeners = {}; page.picker.listeners = {}; page.paste.listeners = {}; page.list.listeners = {};
    new Function("window", "document", "navigator", "sessionStorage", "crypto", "fetch", "FormData", "File", "FileReader", "AbortController", imageUploadScript())
      (page.root, page.root.document, page.root.navigator, page.root.sessionStorage, page.root.crypto, page.root.fetch, page.root.FormData, page.root.File, page.root.FileReader, page.root.AbortController);
    page.picker.files = [png]; const adding = page.picker.fire("change");
    expect(page.root.nexusImages.pending(page.form)).toBe(true);
    await page.list.fire("click", page.list.children[0].querySelector("[data-image-remove]")!);
    expect(page.aborts).toHaveLength(1); resolveUpload({ ok: true, json: async () => ({ upload_id: "late" }) }); await adding;
    expect(page.root.nexusImages.selections(page.form)).toEqual({ screenshots: [] });

    const retry = fixture(); let calls = 0;
    retry.root.fetch = async () => ({ ok: ++calls > 1, json: async () => calls > 1 ? ({ upload_id: "recovered" }) : ({ error: "no" }) });
    retry.control.listeners = {}; retry.picker.listeners = {}; retry.paste.listeners = {}; retry.list.listeners = {};
    new Function("window", "document", "navigator", "sessionStorage", "crypto", "fetch", "FormData", "File", "FileReader", "AbortController", imageUploadScript())
      (retry.root, retry.root.document, retry.root.navigator, retry.root.sessionStorage, retry.root.crypto, retry.root.fetch, retry.root.FormData, retry.root.File, retry.root.FileReader, retry.root.AbortController);
    retry.picker.files = [png]; await retry.picker.fire("change");
    const row = retry.list.children[0]; expect(row.querySelectorAll("[data-image-retry]")).toHaveLength(1);
    await retry.list.fire("click", row.querySelector("[data-image-retry]")!);
    expect(calls).toBe(2); expect(row.querySelectorAll("[data-image-retry]")).toHaveLength(0);
  });

  it("enforces required and pending state and clears new images when the project changes", async () => {
    const page = fixture({ required: true, project: "project-1" });
    expect(page.root.nexusImages.invalid(page.form)).toBe(true);
    page.picker.files = [png]; await page.picker.fire("change");
    expect(page.root.nexusImages.invalid(page.form)).toBe(false);
    page.select.value = "project-2"; await page.select.fire("change");
    expect(page.root.nexusImages.selections(page.form)).toEqual({ screenshots: [] });
    expect(page.error.textContent).toContain("project changed");
    page.picker.files = [png]; await page.picker.fire("change");
    expect(page.requests.at(-1).url).toBe("/api/projects/project-2/uploads");
  });
});
