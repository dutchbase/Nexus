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
      ${path==="/admin/projects"?`
        const csrf=sessionStorage.getItem("dccCsrf")||"",modal=document.querySelector("[data-add-project-modal]"),form=document.querySelector("[data-add-project-form]");
        const nameInput=form?.querySelector('[name="name"]'),slugInput=form?.querySelector('[name="slug"]');
        nameInput?.addEventListener("input",()=>{if(!slugInput?.value)slugInput.value=nameInput.value.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"")});
        document.querySelector("[data-add-project-button]")?.addEventListener("click",()=>modal.showModal());
        modal?.querySelector("[data-close-modal]")?.addEventListener("click",()=>modal.close());
        form?.addEventListener("submit",async(event)=>{
          event.preventDefault();const data=new FormData(form);const payload=Object.fromEntries(data);
          const response=await fetch("/api/admin/projects",{method:"POST",headers:{"content-type":"application/json","x-csrf-token":csrf},body:JSON.stringify(payload)});
          if(response.ok){modal.close();location.reload()}else{const result=await response.json();form.querySelector(".error").textContent=result.error}
        });
      `:""}
      ${/^\/admin\/projects\/[^/]+$/.test(path)?`
        const csrf=sessionStorage.getItem("dccCsrf")||"",form=document.querySelector("[data-project-form]"),projectId=form?.dataset.projectId;
        document.querySelector("[data-save-button]")?.addEventListener("click",async()=>{
          const data=new FormData(form);const payload=Object.fromEntries(data);
          const validation_commands={};
          document.querySelectorAll("[data-cmd]").forEach(input=>{validation_commands[input.dataset.cmd]=input.value});
          payload.config_json={validation_commands,branch_prefix:payload.branch_prefix||""};
          delete payload.branch_prefix;
          const response=await fetch("/api/admin/projects/"+projectId,{method:"PATCH",headers:{"content-type":"application/json","x-csrf-token":csrf},body:JSON.stringify(payload)});
          if(response.ok){alert("Project saved")}else{const result=await response.json();alert(result.error)}
        });
        document.querySelector("[data-validate-button]")?.addEventListener("click",async()=>{
          const response=await fetch("/api/admin/projects/"+projectId+"/validate",{method:"POST",headers:{"x-csrf-token":csrf}});
          if(response.ok){alert("Validation started");setTimeout(()=>location.reload(),2000)}else{const result=await response.json();alert(result.error)}
        });
        document.querySelectorAll("[data-skill-checkbox]").forEach(checkbox=>{
          checkbox.addEventListener("change",async()=>{
            const skill_ids=[...document.querySelectorAll("[data-skill-checkbox]:checked")].map(c=>c.value);
            const response=await fetch("/api/admin/projects/"+projectId+"/skills",{method:"PUT",headers:{"content-type":"application/json","x-csrf-token":csrf},body:JSON.stringify({skills:skill_ids.map(id=>({skill_id:id,attachment_type:"automatic"}))})});
            if(!response.ok){const result=await response.json();alert(result.error);checkbox.checked=!checkbox.checked}
          });
        });
      `:""}
      ${path==="/admin/forms/new"?`
        const csrf=sessionStorage.getItem("dccCsrf")||"",form=document.querySelector("[data-new-form-form]");
        const nameInput=form?.querySelector('[name="name"]'),slugInput=form?.querySelector('[name="slug"]');
        nameInput?.addEventListener("input",()=>{if(!slugInput?.value)slugInput.value=nameInput.value.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"")});
        form?.addEventListener("submit",async(event)=>{
          event.preventDefault();const payload=Object.fromEntries(new FormData(form));
          if(!payload.fixed_project_id)delete payload.fixed_project_id;
          const response=await fetch("/api/admin/forms",{method:"POST",headers:{"content-type":"application/json","x-csrf-token":csrf},body:JSON.stringify(payload)});
          const result=await response.json();
          if(response.ok)location.href="/admin/forms/"+result.form.slug;else form.querySelector(".error").textContent=result.error;
        });
      `:""}
      ${/^\/admin\/forms\/[^/]+$/.test(path)&&path!=="/admin/forms/new"?`
        const csrf=sessionStorage.getItem("dccCsrf")||"";
        const fieldsApp=document.querySelector("[data-fields-app]");
        if(fieldsApp){
          const formId=fieldsApp.dataset.formId;
          const fieldTypes=JSON.parse(document.querySelector("[data-field-types]").textContent);
          let fields=JSON.parse(document.querySelector("[data-fields-json]").textContent);
          let selected=null;
          const list=fieldsApp.querySelector("[data-field-list]"),settingsBox=fieldsApp.querySelector("[data-field-settings]"),errorBox=fieldsApp.querySelector("[data-fields-error]");
          const optionTypes=new Set(["dropdown","radio","multi_select","category_selector","environment_selector"]);
          function typeLabel(value){return (fieldTypes.find(t=>t[0]===value)||[value,value])[1]}
          function renderList(){
            list.replaceChildren();
            fields.forEach((field,index)=>{
              const row=document.createElement("div");
              row.style.cssText="display:flex;align-items:center;gap:10px;padding:10px 4px;border-bottom:1px solid var(--border);cursor:pointer";
              if(index===selected)row.style.cssText+="background:var(--accent-soft);border-left:2px solid var(--accent)";
              row.innerHTML='<span class="mono" style="width:20px;color:var(--text3)">'+(index+1)+'</span>'
                +'<span style="flex:1"><strong>'+field.label.replace(/</g,"&lt;")+'</strong><br><span class="mono" style="font-size:11px;color:var(--text3)">'+field.field_key.replace(/</g,"&lt;")+' · '+typeLabel(field.field_type)+'</span></span>'
                +'<span class="status" style="background:'+(field.required?"var(--accent-soft)":"var(--s-muted)")+'">'+(field.required?"Required":"Optional")+'</span>';
              const up=document.createElement("button");up.type="button";up.className="button";up.textContent="↑";up.disabled=index===0;up.addEventListener("click",e=>{e.stopPropagation();moveField(index,-1)});
              const down=document.createElement("button");down.type="button";down.className="button";down.textContent="↓";down.disabled=index===fields.length-1;down.addEventListener("click",e=>{e.stopPropagation();moveField(index,1)});
              const remove=document.createElement("button");remove.type="button";remove.className="button";remove.textContent="×";remove.addEventListener("click",e=>{e.stopPropagation();removeField(index)});
              row.append(up,down,remove);
              row.addEventListener("click",()=>{selected=index;renderList();renderSettings()});
              list.append(row);
            });
          }
          function renderSettings(){
            if(selected===null||!fields[selected]){settingsBox.innerHTML="<p>Select a field to edit.</p>";return}
            const field=fields[selected];
            settingsBox.innerHTML='<label class="field"><span>Label</span><input data-f-label value="'+field.label.replace(/"/g,"&quot;")+'"></label>'
              +'<label class="field"><span>Field key</span><input data-f-key class="mono" value="'+field.field_key.replace(/"/g,"&quot;")+'"></label>'
              +'<label class="field"><span>Type</span><select data-f-type>'+fieldTypes.map(t=>'<option value="'+t[0]+'"'+(t[0]===field.field_type?" selected":"")+'>'+t[1]+'</option>').join("")+'</select></label>'
              +(optionTypes.has(field.field_type)?'<label class="field"><span>Options (one per line)</span><textarea data-f-options rows="4">'+(field.options_json||[]).join("\\n").replace(/</g,"&lt;")+'</textarea></label>':"")
              +'<label style="display:flex;gap:9px;align-items:center;font-size:13px;margin:10px 0"><input type="checkbox" data-f-required'+(field.required?" checked":"")+'> Required</label>'
              +'<p style="font-size:12px;color:var(--text3)">Every field is validated server-side. Uploads are image-only, renamed randomly and capped at 8 MB; SVG is rejected.</p>';
            settingsBox.querySelector("[data-f-label]").addEventListener("input",e=>{field.label=e.target.value;save();renderList()});
            settingsBox.querySelector("[data-f-key]").addEventListener("change",e=>{field.field_key=e.target.value;save();renderList()});
            settingsBox.querySelector("[data-f-type]").addEventListener("change",e=>{field.field_type=e.target.value;save();renderSettings();renderList()});
            settingsBox.querySelector("[data-f-required]").addEventListener("change",e=>{field.required=e.target.checked;save();renderList()});
            settingsBox.querySelector("[data-f-options]")?.addEventListener("change",e=>{field.options_json=e.target.value.split("\\n").map(v=>v.trim()).filter(Boolean);save()});
          }
          function moveField(index,dir){
            const target=index+dir;if(target<0||target>=fields.length)return;
            [fields[index],fields[target]]=[fields[target],fields[index]];
            if(selected===index)selected=target;else if(selected===target)selected=index;
            save();renderList();renderSettings();
          }
          function removeField(index){
            fields.splice(index,1);
            if(selected===index)selected=null;else if(selected!==null&&selected>index)selected-=1;
            save();renderList();renderSettings();
          }
          fieldsApp.querySelector("[data-add-field]").addEventListener("click",()=>{
            fields.push({field_key:"new_field_"+(fields.length+1),field_type:"short_text",label:"New field",required:false,position:(fields.length+1)*10,options_json:[]});
            selected=fields.length-1;save();renderList();renderSettings();
          });
          async function save(){
            const payload={fields:fields.map((f,i)=>({...f,position:(i+1)*10}))};
            const response=await fetch("/api/admin/forms/"+formId,{method:"PATCH",headers:{"content-type":"application/json","x-csrf-token":csrf},body:JSON.stringify(payload)});
            if(!response.ok){const result=await response.json();errorBox.textContent=result.error}else errorBox.textContent=""
          }
          renderList();
        }
        const settingsForm=document.querySelector("[data-form-settings]");
        settingsForm?.addEventListener("submit",async(event)=>{
          event.preventDefault();const data=new FormData(settingsForm);
          const payload={name:data.get("name"),title:data.get("title"),slug:data.get("slug"),fixed_project_id:data.get("fixed_project_id")||null,
            settings_json:{rate_limit:Number(data.get("rate_limit"))||15,captcha_mode:data.get("captcha_mode"),completion_message:data.get("completion_message"),
              notify_on_submission:settingsForm.elements.notify_on_submission.checked,allow_image_attachments:settingsForm.elements.allow_image_attachments.checked}};
          const response=await fetch("/api/admin/forms/"+fieldsApp?.dataset.formId,{method:"PATCH",headers:{"content-type":"application/json","x-csrf-token":csrf},body:JSON.stringify(payload)});
          const result=await response.json();
          if(response.ok)location.reload();else settingsForm.querySelector(".error").textContent=result.error;
        });
        document.querySelector("[data-publish-toggle]")?.addEventListener("click",async(event)=>{
          const button=event.currentTarget,action=button.dataset.status==="published"?"unpublish":"publish";
          const response=await fetch("/api/admin/forms/"+button.dataset.formId+"/"+action,{method:"POST",headers:{"x-csrf-token":csrf}});
          if(response.ok)location.reload();else alert((await response.json()).error);
        });
      `:""}
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
