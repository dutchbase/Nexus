import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const stylesPath = join(dirname(fileURLToPath(import.meta.url)), "design-tokens.css");
export const styles = await readFile(stylesPath, "utf8");

export function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function document(title: string, content: string, script = "") {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${styles}</style></head><body>${content}${script ? `<script>${script}</script>` : ""}</body></html>`;
}

export function loginPage() {
  return document("Sign in", `<main class="login"><section class="login-card">
    <div class="login-intro"><div class="eyebrow">Development Control Center</div><h1>Feedback in.<br><em>Reviewed code out.</em></h1><p>One controlled workflow from public feedback to reviewed delivery.</p></div>
    <form class="login-form" id="login"><div class="eyebrow">Sign in</div><h2>Administrator</h2>
      <label class="field"><span>Username</span><input name="username" autocomplete="username" required></label><br>
      <label class="field"><span>Password</span><input name="password" type="password" autocomplete="current-password" required></label><br>
      <button class="button primary" type="submit">Sign in</button><p class="error" role="alert"></p>
    </form></section></main>`, `
      document.querySelector("#login").addEventListener("submit",async(event)=>{
        event.preventDefault();const form=new FormData(event.currentTarget);
        const response=await fetch("/api/admin/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(Object.fromEntries(form))});
        const body=await response.json();if(!response.ok){document.querySelector(".error").textContent=body.error;return}
        sessionStorage.setItem("dccCsrf",body.csrfToken);location.href="/admin";
      });`);
}

const groups = [
  ["Overview", [["Dashboard", "/admin", ""]]],
  ["Work", [["Tickets", "/admin/tickets", "tickets"], ["Runs", "/admin/runs", "runs"], ["Queue", "/admin/queue", "jobs"], ["Pull requests", "/admin/pull-requests", "prs"]]],
  ["Configure", [["Projects", "/admin/projects", "projects"], ["Forms", "/admin/forms", "forms"], ["Prompts", "/admin/prompts", ""], ["Skills", "/admin/skills", "skills"]]],
  ["Operate", [["Notifications", "/admin/notifications", "notifications"], ["Audit log", "/admin/audit", ""], ["Settings", "/admin/settings", ""], ["System", "/admin/system", ""]]],
] as const;

export function adminPage(path: string, title: string, body: string, counts: Record<string, number>, username: string) {
  const nav = groups.map(([label, items]) => `<div class="nav-group"><div class="nav-label">${label}</div>${items.map(([name, href, count]) => {
    const active = href === "/admin" ? path === href : path === href || path.startsWith(`${href}/`);
    return `<a class="nav-item${active ? " active" : ""}" href="${href}"${active ? ' aria-current="page"' : ""}><span>${name}</span>${count ? `<span class="badge">${counts[count] ?? 0}</span>` : ""}</a>`;
  }).join("")}</div>`).join("");
  return document(title, `<div class="shell"><aside class="sidebar"><div class="brand"><span class="brand-mark">D</span><div><div class="brand-title">Development hub</div><div class="brand-sub">Internet Nederland</div></div></div>
    <nav class="nav" aria-label="Primary">${nav}</nav><footer class="sidebar-footer"><div class="theme"><button data-theme-choice="light">Light</button><button data-theme-choice="auto">Auto</button><button data-theme-choice="dark">Dark</button></div><p>${escapeHtml(username)} · administrator</p></footer></aside>
    <button class="scrim" type="button" data-scrim hidden aria-label="Close navigation menu"></button>
    <div class="content"><header class="header"><button class="hamburger" type="button" data-nav-open aria-label="Open navigation menu"><span></span><span></span><span></span></button><span class="eyebrow">Development Control Center</span><span>/</span><span>${escapeHtml(title)}</span><span class="worker">● worker-01 healthy</span><a class="button" href="/f/website-feedback">Public form</a></header><main class="main">${body}</main></div></div>`, `
      const choice=localStorage.getItem("dccTheme")||"auto";
      const apply=(value)=>{const dark=value==="dark"||(value==="auto"&&matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.dataset.theme=dark?"dark":"light";document.querySelectorAll("[data-theme-choice]").forEach(b=>b.classList.toggle("selected",b.dataset.themeChoice===value))};
      apply(choice);matchMedia("(prefers-color-scheme: dark)").addEventListener("change",()=>{if((localStorage.getItem("dccTheme")||"auto")==="auto")apply("auto")});
      document.querySelectorAll("[data-theme-choice]").forEach(b=>b.addEventListener("click",()=>{localStorage.setItem("dccTheme",b.dataset.themeChoice);apply(b.dataset.themeChoice)}));
      const sidebar=document.querySelector(".sidebar"),scrim=document.querySelector("[data-scrim]");
      document.querySelector("[data-nav-open]")?.addEventListener("click",()=>{sidebar.classList.add("open");scrim.hidden=false});
      scrim?.addEventListener("click",()=>{sidebar.classList.remove("open");scrim.hidden=true});
      document.querySelectorAll("[role=tablist]").forEach(list=>{
        const tabs=[...list.querySelectorAll("[role=tab]")];
        list.addEventListener("click",event=>{
          const tab=event.target.closest("[role=tab]");if(!tab)return;
          tabs.forEach(item=>item.setAttribute("aria-selected",String(item===tab)));
          tabs.forEach(item=>{const panel=document.getElementById(item.getAttribute("aria-controls")||"");if(panel)panel.hidden=item!==tab});
        });
      });
      ${path.startsWith("/admin/tickets") ? `document.querySelectorAll("[data-ticket-filter]").forEach(el=>el.addEventListener("change",()=>{const q=new URLSearchParams(new FormData(document.querySelector("#filters")));location.href="/admin/tickets?"+q}))` : ""}
      ${/^\/admin\/tickets\/[^/]+$/.test(path) ? `
        const csrf=sessionStorage.getItem("dccCsrf")||"";
        const aiForm=document.querySelector("#ai-config");
        if(aiForm){
          const mode=aiForm.elements.ai_configuration_mode,advanced=document.querySelector("[data-advanced-ai]");
          mode.addEventListener("change",()=>advanced.hidden=mode.value!=="advanced");
          aiForm.addEventListener("submit",async(event)=>{
            event.preventDefault();const payload=Object.fromEntries(new FormData(aiForm));
            if(payload.ai_configuration_mode!=="advanced"){for(const phase of ["planning","execution","repair"]){delete payload[phase+"_model"];delete payload[phase+"_reasoning_level"]}}
            const response=await fetch("/api/admin/tickets/"+aiForm.dataset.ticketId,{method:"PATCH",headers:{"content-type":"application/json","x-csrf-token":csrf},body:JSON.stringify(payload)});
            const result=await response.json();aiForm.querySelector(".error").textContent=response.ok?"Saved":result.error;
          });
        }
        const toggles=[...document.querySelectorAll("[data-skill-toggle]")],chips=document.querySelector("[data-skill-chips]"),references=document.querySelector("[data-skill-references]"),refCount=document.querySelector("[data-ref-count]"),promptSkills=document.querySelector("[data-prompt-skills]");
        const ticketId=aiForm?.dataset.ticketId;
        document.querySelector("[data-add-skill]")?.addEventListener("click",()=>{const picker=document.querySelector("[data-skill-picker]");picker.hidden=!picker.hidden});
        function renderSkills(){
          const selected=toggles.filter(input=>input.checked);
          chips.replaceChildren(...selected.map(input=>{
            const auto=input.dataset.auto!==undefined;
            const chip=document.createElement("span");chip.className="skill-chip";chip.dataset.skillChip=input.value;chip.dataset.slug=input.dataset.slug;
            chip.title=(auto?"Automatically added by project":"Selected on this ticket")+" · "+input.dataset.path;
            chip.append(document.createTextNode(input.dataset.name+" "));
            if(auto){const tag=document.createElement("small");tag.textContent="auto";chip.append(tag)}
            else{const remove=document.createElement("button");remove.type="button";remove.dataset.removeSkill=input.value;remove.setAttribute("aria-label","Remove "+input.dataset.name);remove.textContent="×";chip.append(remove)}
            return chip;
          }));
          const lines=selected.map(input=>"- "+input.dataset.slug+": "+input.dataset.path).join("\\n");
          references.textContent="Use the following skills:\\n"+lines;
          if(refCount)refCount.textContent=String(selected.length);
          if(promptSkills)promptSkills.textContent=lines;
        }
        const previewDialog=document.querySelector("[data-preview-dialog]");
        document.querySelector("[data-open-preview]")?.addEventListener("click",async()=>{
          previewDialog.showModal();
          try{const response=await fetch("/api/admin/tickets/"+ticketId+"/prompt-preview");const result=await response.json();previewDialog.querySelector("pre").textContent=result.content??result.error??""}catch{}
        });
        previewDialog?.querySelector("[data-close-dialog]")?.addEventListener("click",()=>previewDialog.close());
        previewDialog?.addEventListener("keydown",event=>{
          if(event.key!=="Tab")return;
          const focusables=[...previewDialog.querySelectorAll("button,a[href],input,select,textarea,[tabindex]")].filter(el=>!el.disabled);
          if(!focusables.length)return;
          const first=focusables[0],last=focusables[focusables.length-1];
          if(event.shiftKey&&(document.activeElement===first||!previewDialog.contains(document.activeElement))){event.preventDefault();last.focus()}
          else if(!event.shiftKey&&(document.activeElement===last||!previewDialog.contains(document.activeElement))){event.preventDefault();first.focus()}
        });
        document.querySelector("[data-start-execution]")?.addEventListener("click",async()=>{
          const response=await fetch("/api/admin/tickets/"+ticketId+"/execute",{method:"POST",headers:{"x-csrf-token":csrf}});
          if(response.ok)location.reload();else alert((await response.json()).error);
        });
        async function persistSkills(){
          const skill_ids=toggles.filter(input=>input.checked&&!input.disabled).map(input=>input.value);
          const response=await fetch("/api/admin/tickets/"+ticketId+"/skills",{method:"PUT",headers:{"content-type":"application/json","x-csrf-token":csrf},body:JSON.stringify({skill_ids})});
          if(!response.ok){const result=await response.json();alert(result.error)}
        }
        toggles.forEach(input=>input.addEventListener("change",()=>{renderSkills();persistSkills()}));
        chips?.addEventListener("click",event=>{const button=event.target.closest("[data-remove-skill]");if(!button)return;const input=toggles.find(item=>item.value===button.dataset.removeSkill);if(input){input.checked=false;renderSkills();persistSkills()}});
        document.querySelector("[data-skill-search]")?.addEventListener("input",event=>document.querySelectorAll("[data-skill-option]").forEach(option=>option.hidden=!option.dataset.search.includes(event.target.value.toLowerCase())));
      ` : ""}
      ${/^\/admin\/prompts\/[^/]+$/.test(path) ? `
        const csrf=sessionStorage.getItem("dccCsrf")||"",editor=document.querySelector("[data-prompt-editor]");
        const save=async(payload,path="versions")=>{
          const response=await fetch("/api/admin/prompts/"+editor.dataset.promptId+"/"+path,{method:"POST",headers:{"content-type":"application/json","x-csrf-token":csrf},body:JSON.stringify(payload)});
          const result=await response.json();if(!response.ok){editor.querySelector(".error").textContent=result.error;return}location.reload();
        };
        editor?.addEventListener("submit",event=>{event.preventDefault();save({content:new FormData(editor).get("content"),activate:true})});
        editor?.querySelector("[data-deactivate]")?.addEventListener("click",()=>save({version_id:null},"activate"));
        document.querySelectorAll("[data-restore-version]").forEach(button=>button.addEventListener("click",()=>save({version_id:button.dataset.restoreVersion},"restore")));
        editor?.elements.content.addEventListener("input",event=>{document.querySelector("[data-markdown-preview]").textContent=event.target.value});
      ` : ""}
    `);
}

export function publicFormPage(form: any, fields: any[], projects: any[]) {
  const controls = fields.filter((field) => field.field_type !== "static").map((field) => {
    const name = escapeHtml(field.field_key);
    const required = field.required ? " required" : "";
    const type = field.field_type;
    const options = (Array.isArray(field.options_json) ? field.options_json : []).map((option: any) => `<option value="${escapeHtml(option.value ?? option)}">${escapeHtml(option.label ?? option)}</option>`).join("");
    let control = `<input name="${name}" placeholder="${escapeHtml(field.placeholder)}"${required}>`;
    if (type === "long_text") control = `<textarea name="${name}" rows="5"${required}></textarea>`;
    if (type === "email" || type === "url" || type === "number") control = `<input name="${name}" type="${type}"${required}>`;
    if (type.includes("selector") || ["dropdown", "radio", "multi_select"].includes(type)) {
      const choices = type === "project_selector" ? projects.map((project) => `<option value="${project.id}">${escapeHtml(project.name)}</option>`).join("") : options;
      control = `<select name="${name}"${required}>${choices}</select>`;
    }
    if (type === "checkbox") control = `<input name="${name}" type="checkbox" value="true">`;
    if (type === "hidden") return `<label class="honeypot" aria-hidden="true">${escapeHtml(field.label)}<input name="${name}" tabindex="-1" autocomplete="off"></label>`;
    if (type === "image_upload") control = `<input name="${name}" type="file" accept="image/png,image/jpeg"><small>PNG of JPG · max 8 MB · geen SVG</small>`;
    return `<label class="field"><span>${escapeHtml(field.label)}</span>${control}</label>`;
  }).join("");
  return document(form.title, `<main class="public"><div class="url-strip">/f/${escapeHtml(form.slug)}</div><form class="card" id="public-form"><div class="card-body"><div class="eyebrow">Feedback</div><h1>${escapeHtml(form.title)}</h1><p>${escapeHtml(form.description)}</p><div class="grid two">${controls}</div><br><button class="button primary" type="submit">Melding versturen</button><p class="error" role="alert"></p></div></form></main>`, `
    document.querySelector("#public-form").addEventListener("submit",async(event)=>{
      event.preventDefault();const data=new FormData(event.currentTarget);const payload={};
      for(const [key,value] of data){if(value instanceof File&&value.size){const upload=new FormData();upload.append("file",value);const result=await fetch("/api/public/uploads",{method:"POST",body:upload});if(!result.ok){document.querySelector(".error").textContent="Upload geweigerd";return}payload[key]=(await result.json()).upload_id}else if(!(value instanceof File))payload[key]=value}
      const response=await fetch("/api/public/forms/${escapeHtml(form.slug)}/submissions",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)});
      const result=await response.json();if(!response.ok){document.querySelector(".error").textContent=result.error;return}
      sessionStorage.setItem("submittedTicket",result.ticket_number);location.href="/f/${escapeHtml(form.slug)}/submitted";
    });`);
}

export function submittedPage(form: any) {
  return document("Melding ontvangen", `<main class="public"><section class="card"><div class="card-body"><div class="eyebrow">Ontvangen</div><h1>Bedankt — je melding staat genoteerd.</h1><p>${escapeHtml(form.settings_json?.completion_message ?? "Bewaar je referentie als je er later naar wilt verwijzen.")}</p><div class="reference"><span class="eyebrow">Referentie</span><strong class="mono" id="reference"></strong></div></div></section></main>`, `document.querySelector("#reference").textContent=sessionStorage.getItem("submittedTicket")||"Referentie niet beschikbaar";`);
}
