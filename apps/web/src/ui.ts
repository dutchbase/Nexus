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
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><link rel="stylesheet" href="/assets/design-tokens.css"></head><body>${content}${script ? `<script>${script}</script>` : ""}</body></html>`;
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
  ["Operate", [["Notifications", "/admin/notifications", "notifications"], ["AI usage", "/admin/ai-usage", ""], ["Audit log", "/admin/audit", ""], ["Settings", "/admin/settings", ""], ["System", "/admin/system", ""]]],
] as const;

export function adminPage(path: string, title: string, body: string, counts: Record<string, number>, username: string) {
  const nav = groups.map(([label, items]) => `<div class="nav-group"><div class="nav-label">${label}</div>${items.map(([name, href, count]) => {
    const active = href === "/admin" ? path === href : path === href || path.startsWith(`${href}/`);
    return `<a class="nav-item${active ? " active" : ""}" href="${href}"${active ? ' aria-current="page"' : ""}><span>${name}</span>${count ? `<span class="badge">${counts[count] ?? 0}</span>` : ""}</a>`;
  }).join("")}</div>`).join("");

  // Derive breadcrumb section: group label for list pages, item label for detail pages
  let section = "";
  let bestMatch = "";
  for (const [groupLabel, items] of groups) {
    for (const [itemLabel, href] of items) {
      if ((path === href || path.startsWith(`${href}/`)) && href.length > bestMatch.length) {
        // For detail pages (deeper), use item label; for list pages (equal), use group label
        section = path === href ? groupLabel : itemLabel;
        bestMatch = href;
      }
    }
  }

  const breadcrumb = section ? `<span class="eyebrow">${section}</span><span>/</span><span>${escapeHtml(title)}</span>` : `<span class="eyebrow">Development Control Center</span><span>/</span><span>${escapeHtml(title)}</span>`;

  return document(title, `<div class="shell"><aside class="sidebar" id="sidebar"><div class="brand"><span class="brand-mark">D</span><div><div class="brand-title">Development hub</div><div class="brand-sub">Internet Nederland</div></div></div>
    <nav class="nav" aria-label="Primary">${nav}</nav><footer class="sidebar-footer"><div class="theme"><button data-theme-choice="light">Light</button><button data-theme-choice="auto">Auto</button><button data-theme-choice="dark">Dark</button></div><p>${escapeHtml(username)} · administrator</p></footer></aside>
    <button class="scrim" type="button" data-scrim hidden aria-label="Close navigation menu"></button>
    <div class="content"><header class="header"><button class="hamburger" type="button" data-nav-open aria-expanded="false" aria-controls="sidebar" aria-label="Open navigation menu"><span></span><span></span><span></span></button>${breadcrumb}<span class="worker">● worker-01 healthy</span><a class="button" href="/f/website-feedback">Public form</a></header><main class="main">${body}</main></div></div>`, `
      const cc=document.cookie.match(/(?:^|;\\s*)dcc_csrf=([^;]*)/);if(cc)sessionStorage.setItem("dccCsrf",cc[1]);
      const choice=localStorage.getItem("dccTheme")||"auto";
      const apply=(value)=>{const dark=value==="dark"||(value==="auto"&&matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.dataset.theme=dark?"dark":"light";document.querySelectorAll("[data-theme-choice]").forEach(b=>b.classList.toggle("selected",b.dataset.themeChoice===value))};
      apply(choice);matchMedia("(prefers-color-scheme: dark)").addEventListener("change",()=>{if((localStorage.getItem("dccTheme")||"auto")==="auto")apply("auto")});
      document.querySelectorAll("[data-theme-choice]").forEach(b=>b.addEventListener("click",()=>{localStorage.setItem("dccTheme",b.dataset.themeChoice);apply(b.dataset.themeChoice)}));
      const sidebar=document.querySelector(".sidebar"),scrim=document.querySelector("[data-scrim]"),opener=document.querySelector("[data-nav-open]");
      const closeNav=()=>{sidebar.classList.remove("open");scrim.hidden=true;opener?.setAttribute("aria-expanded","false");opener?.focus()};
      opener?.addEventListener("click",()=>{sidebar.classList.add("open");scrim.hidden=false;opener.setAttribute("aria-expanded","true");sidebar.querySelector("a.nav-item")?.focus()});
      scrim?.addEventListener("click",closeNav);
      document.addEventListener("keydown",e=>{if(e.key==="Escape"&&sidebar.classList.contains("open"))closeNav()});
      document.querySelectorAll("[role=tablist]").forEach(list=>{
        const tabs=[...list.querySelectorAll("[role=tab]")];
        const activate=tab=>tabs.forEach(item=>{item.setAttribute("aria-selected",String(item===tab));item.tabIndex=item===tab?0:-1;const panel=document.getElementById(item.getAttribute("aria-controls")||"");if(panel)panel.hidden=item!==tab});
        tabs.forEach(tab=>tab.tabIndex=tab.getAttribute("aria-selected")==="true"?0:-1);
        list.addEventListener("click",event=>{const tab=event.target.closest("[role=tab]");if(tab)activate(tab)});
        list.addEventListener("keydown",event=>{
          const index=tabs.indexOf(document.activeElement);if(index<0)return;
          let next=null;
          if(event.key==="ArrowRight")next=(index+1)%tabs.length;
          else if(event.key==="ArrowLeft")next=(index-1+tabs.length)%tabs.length;
          else if(event.key==="Home")next=0;
          else if(event.key==="End")next=tabs.length-1;
          if(next===null)return;event.preventDefault();tabs[next].focus();activate(tabs[next]);
        });
      });
      ${path === "/admin/tickets" ? `
        (function(){
          const params=new URLSearchParams(location.search);
          if(!params.has("status")){
            const saved=JSON.parse(localStorage.getItem("dccTicketStatus")||"[]");
            if(saved.length){saved.forEach(s=>params.append("status",s));location.replace("/admin/tickets?"+params)}
          }
        })();
        document.querySelectorAll("[data-ticket-filter]:not([type=checkbox])").forEach(el=>el.addEventListener("change",()=>{
          const q=new URLSearchParams(new FormData(document.querySelector("#filters")));
          localStorage.setItem("dccTicketStatus",JSON.stringify(q.getAll("status")));
          location.href="/admin/tickets?"+q;
        }));
        document.querySelector("[data-status-filter]")?.addEventListener("toggle",function(){
          if(this.open)return;
          const q=new URLSearchParams(new FormData(document.querySelector("#filters")));
          localStorage.setItem("dccTicketStatus",JSON.stringify(q.getAll("status")));
          location.href="/admin/tickets?"+q;
        });
        document.querySelector("[data-tickets-reset]")?.addEventListener("click",()=>localStorage.removeItem("dccTicketStatus"));
        ${path === "/admin/tickets" ? `
          const csrf=sessionStorage.getItem("dccCsrf")||"",modal=document.querySelector("[data-add-ticket-modal]"),form=document.querySelector("[data-add-ticket-form]");
          document.querySelector("[data-add-ticket-button]")?.addEventListener("click",()=>modal.showModal());
          modal?.querySelector("[data-close-modal]")?.addEventListener("click",()=>modal.close());
          modal?.addEventListener("keydown",event=>{
            if(event.key!=="Tab")return;const focusables=[...modal.querySelectorAll("button,a[href],input,select,textarea,[tabindex]")].filter(el=>!el.disabled);if(!focusables.length)return;
            const first=focusables[0],last=focusables[focusables.length-1];if(event.shiftKey&&(document.activeElement===first||!modal.contains(document.activeElement))){event.preventDefault();last.focus()}else if(!event.shiftKey&&(document.activeElement===last||!modal.contains(document.activeElement))){event.preventDefault();first.focus()}
          });
          form?.addEventListener("submit",async(event)=>{
            event.preventDefault();const response=await fetch("/api/admin/tickets",{method:"POST",headers:{"content-type":"application/json","x-csrf-token":csrf},body:JSON.stringify(Object.fromEntries(new FormData(form)))});const result=await response.json();
            if(response.ok)location.href="/admin/tickets/"+result.ticket.ticket_number;else form.querySelector(".error").textContent=result.error;
          });
        ` : ""}
      ` : ""}
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
            const project=input.dataset.project!==undefined,auto=input.dataset.auto!==undefined,required=input.dataset.required!==undefined;
            const chip=document.createElement("span");chip.className="skill-chip";chip.dataset.skillChip=input.value;chip.dataset.slug=input.dataset.slug;
            chip.title=(required?"Required by project":auto?"Automatically added by project":"Selected on this ticket")+" · "+input.dataset.path;
            chip.append(document.createTextNode(input.dataset.name+" "));
            if(project&&input.dataset.overridable===undefined){const tag=document.createElement("small");tag.textContent=input.dataset.badge;chip.append(tag)}
            else{const remove=document.createElement("button");remove.type="button";remove.dataset.removeSkill=input.value;remove.setAttribute("aria-label","Remove "+input.dataset.name);remove.textContent="×";chip.append(remove)}
            return chip;
          }));
          const lines=selected.map(input=>"- "+input.dataset.slug+": "+input.dataset.path).join("\\n")||"No skills resolved for this ticket.";
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
          const skill_ids=toggles.filter(input=>input.checked&&input.dataset.project===undefined).map(input=>input.value);
          const excluded_skill_ids=toggles.filter(input=>!input.checked&&input.dataset.overridable!==undefined).map(input=>input.value);
          const response=await fetch("/api/admin/tickets/"+ticketId+"/skills",{method:"PUT",headers:{"content-type":"application/json","x-csrf-token":csrf},body:JSON.stringify({skill_ids,excluded_skill_ids})});
          if(!response.ok){const result=await response.json();alert(result.error)}
        }
        toggles.forEach(input=>input.addEventListener("change",()=>{renderSkills();persistSkills()}));
        chips?.addEventListener("click",event=>{const button=event.target.closest("[data-remove-skill]");if(!button)return;const input=toggles.find(item=>item.value===button.dataset.removeSkill);if(input){input.checked=false;renderSkills();persistSkills()}});
        document.querySelector("[data-skill-search]")?.addEventListener("input",event=>document.querySelectorAll("[data-skill-option]").forEach(option=>option.hidden=!option.dataset.search.includes(event.target.value.toLowerCase())));
        const ticketNumber=window.location.pathname.match(/\\/tickets\\/([^\\/]+)/)?.[1]||"";
        async function ticketAction(endpoint){const response=await fetch("/api/admin/tickets/"+ticketNumber+"/"+endpoint,{method:"POST",headers:{"x-csrf-token":csrf}});if(response.ok)location.reload();else{const result=await response.json();alert(result.error)}}
        const commitDialog=document.querySelector("[data-commit-dialog]"),commitFiles=commitDialog?.querySelector("[data-commit-files]");
        async function approvePlanning(commitMessage){
          const response=await fetch("/api/admin/tickets/"+ticketNumber+"/approve-planning",{method:"POST",headers:{"content-type":"application/json","x-csrf-token":csrf},body:JSON.stringify(commitMessage?{commit_message:commitMessage}:{})});
          const result=await response.json();
          if(response.ok)return location.reload();
          if(response.status===409&&result.changed_files?.length&&commitDialog){
            commitFiles.replaceChildren(...result.changed_files.map(file=>{const li=document.createElement("li");li.textContent=file;return li}));
            commitDialog.querySelector(".error").textContent=result.error||"";
            commitDialog.showModal();
            return;
          }
          alert(result.error||"request failed");
        }
        document.querySelector("[data-approve-planning]")?.addEventListener("click",()=>approvePlanning());
        commitDialog?.querySelector("[data-close-commit-dialog]")?.addEventListener("click",()=>commitDialog.close());
        commitDialog?.querySelector("[data-submit-commit]")?.addEventListener("click",async()=>{
          const message=(commitDialog.querySelector("[name=commit_message]").value||"").trim();
          if(!message){commitDialog.querySelector(".error").textContent="Commit message is required";return}
          await approvePlanning(message);
        });
        document.querySelector("[data-acknowledge-ticket]")?.addEventListener("click",()=>ticketAction("acknowledge"));
        document.querySelector("[data-reject-ticket]")?.addEventListener("click",()=>{if(confirm("Reject this ticket?"))ticketAction("reject")});
        document.querySelector("[data-cancel-ticket]")?.addEventListener("click",()=>{if(confirm("Cancel this ticket? In-flight work stops."))ticketAction("cancel")});
        document.querySelector("[data-archive-ticket]")?.addEventListener("click",()=>{if(confirm("Archive this ticket?"))ticketAction("archive")});
        document.querySelector("[data-reopen-ticket]")?.addEventListener("click",()=>{if(confirm("Reopen this ticket? It will move to \\"Needs Information\\" so you can update the details before a new plan is generated."))ticketAction("reopen")});
        const notesForm=document.querySelector("[data-notes-form]");
        if(notesForm){notesForm.addEventListener("submit",async(event)=>{
          event.preventDefault();const body=(notesForm.querySelector('[name="body"]')||{}).value?.trim();
          if(!body)return;
          const response=await fetch("/api/admin/tickets/"+ticketNumber+"/notes",{method:"POST",headers:{"content-type":"application/json","x-csrf-token":csrf},body:JSON.stringify({body})});
          const result=await response.json();
          if(response.ok){notesForm.reset();location.reload()}else{notesForm.querySelector(".error").textContent=result.error}
        })}
        const ticketEditForm=document.querySelector("[data-ticket-edit-form]");
        const ticketView=document.querySelector("[data-ticket-view]");
        document.querySelector("[data-edit-ticket]")?.addEventListener("click",()=>{ticketView.hidden=true;ticketEditForm.hidden=false});
        document.querySelector("[data-cancel-edit-ticket]")?.addEventListener("click",()=>{ticketEditForm.hidden=true;ticketView.hidden=false});
        if(ticketEditForm){ticketEditForm.addEventListener("submit",async(event)=>{
          event.preventDefault();
          const body={
            title:ticketEditForm.querySelector('[name="title"]').value,
            description:ticketEditForm.querySelector('[name="description"]').value,
            category:ticketEditForm.querySelector('[name="category"]').value,
            environment:ticketEditForm.querySelector('[name="environment"]').value,
            priority:ticketEditForm.querySelector('[name="priority"]').value,
            expected_behavior:ticketEditForm.querySelector('[name="expected_behavior"]').value,
            actual_behavior:ticketEditForm.querySelector('[name="actual_behavior"]').value,
            reproduction_steps:ticketEditForm.querySelector('[name="reproduction_steps"]').value,
          };
          const response=await fetch("/api/admin/tickets/"+ticketEditForm.dataset.ticketId,{method:"PATCH",headers:{"content-type":"application/json","x-csrf-token":csrf},body:JSON.stringify(body)});
          const result=await response.json();
          if(response.ok){location.reload()}else{ticketEditForm.querySelector(".error").textContent=result.error}
        })}
      ` : ""}
      ${/^\/admin\/tickets\/[^/]+\/plans\/\d+$/.test(path) ? `
        const csrf=sessionStorage.getItem("dccCsrf")||"";
        const diffPanel=document.querySelector("[data-diff-panel]");
        document.querySelector("#tab-2")?.addEventListener("click",async()=>{
          if(!diffPanel||diffPanel.dataset.loaded||!diffPanel.dataset.diffFrom)return;
          diffPanel.dataset.loaded="1";
          const response=await fetch("/api/admin/plans/"+diffPanel.dataset.planId+"/diff?from="+diffPanel.dataset.diffFrom+"&to="+diffPanel.dataset.diffTo);
          const result=await response.json();
          diffPanel.querySelector("[data-diff-content]").textContent=response.ok?result.diff:result.error;
        });
        const approveDialog=document.querySelector("[data-approve-dialog]");
        document.querySelector("[data-open-approve-dialog]")?.addEventListener("click",()=>approveDialog.showModal());
        approveDialog?.querySelector("[data-close-dialog]")?.addEventListener("click",()=>approveDialog.close());
        approveDialog?.addEventListener("keydown",event=>{
          if(event.key!=="Tab")return;
          const focusables=[...approveDialog.querySelectorAll("button,a[href],input,select,textarea,[tabindex]")].filter(el=>!el.disabled);
          if(!focusables.length)return;
          const first=focusables[0],last=focusables[focusables.length-1];
          if(event.shiftKey&&(document.activeElement===first||!approveDialog.contains(document.activeElement))){event.preventDefault();last.focus()}
          else if(!event.shiftKey&&(document.activeElement===last||!approveDialog.contains(document.activeElement))){event.preventDefault();first.focus()}
        });
        approveDialog?.querySelector("[data-confirm-approve]")?.addEventListener("click",async()=>{
          const note=approveDialog.querySelector("[data-approve-note]").value.trim();
          const response=await fetch("/api/admin/plan-versions/"+approveDialog.dataset.planVersionId+"/approve",{method:"POST",headers:{"content-type":"application/json","x-csrf-token":csrf},body:JSON.stringify({plan_version_id:approveDialog.dataset.planVersionId,content_hash:approveDialog.dataset.contentHash,note})});
          if(response.ok)location.href="/admin/tickets/"+(window.location.pathname.match(/\\/tickets\\/([^\\/]+)/)||[])[1];
          else approveDialog.querySelector(".error").textContent=(await response.json()).error;
        });
        document.querySelector("[data-reject-plan-version]")?.addEventListener("click",async(event)=>{
          if(!confirm("Reject this plan version?"))return;
          const button=event.currentTarget;
          const response=await fetch("/api/admin/plan-versions/"+button.dataset.rejectPlanVersion+"/reject",{method:"POST",headers:{"content-type":"application/json","x-csrf-token":csrf},body:JSON.stringify({plan_version_id:button.dataset.rejectPlanVersion})});
          if(response.ok)location.href="/admin/tickets/"+(window.location.pathname.match(/\\/tickets\\/([^\\/]+)/)||[])[1];else alert((await response.json()).error);
        });
        const revisionDialog=document.querySelector("[data-revision-dialog]");
        document.querySelector("[data-open-revision-dialog]")?.addEventListener("click",()=>revisionDialog.showModal());
        revisionDialog?.querySelector("[data-close-dialog]")?.addEventListener("click",()=>revisionDialog.close());
        revisionDialog?.addEventListener("keydown",event=>{
          if(event.key!=="Tab")return;
          const focusables=[...revisionDialog.querySelectorAll("button,a[href],input,select,textarea,[tabindex]")].filter(el=>!el.disabled);
          if(!focusables.length)return;
          const first=focusables[0],last=focusables[focusables.length-1];
          if(event.shiftKey&&(document.activeElement===first||!revisionDialog.contains(document.activeElement))){event.preventDefault();last.focus()}
          else if(!event.shiftKey&&(document.activeElement===last||!revisionDialog.contains(document.activeElement))){event.preventDefault();first.focus()}
        });
        revisionDialog?.querySelector("[data-submit-revision]")?.addEventListener("click",async()=>{
          const feedback=revisionDialog.querySelector("[data-revision-feedback]").value.trim();
          if(!feedback){revisionDialog.querySelector(".error").textContent="Feedback is required";return}
          const response=await fetch("/api/admin/plans/"+revisionDialog.dataset.planId+"/request-revision",{method:"POST",headers:{"content-type":"application/json","x-csrf-token":csrf},body:JSON.stringify({feedback})});
          const result=await response.json();
          if(response.ok)location.href="/admin/tickets/"+(window.location.pathname.match(/\\/tickets\\/([^\\/]+)/)||[])[1];
          else revisionDialog.querySelector(".error").textContent=result.error;
        });
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
        modal?.addEventListener("keydown",event=>{
          if(event.key!=="Tab")return;
          const focusables=[...modal.querySelectorAll("button,a[href],input,select,textarea,[tabindex]")].filter(el=>!el.disabled);
          if(!focusables.length)return;
          const first=focusables[0],last=focusables[focusables.length-1];
          if(event.shiftKey&&(document.activeElement===first||!modal.contains(document.activeElement))){event.preventDefault();last.focus()}
          else if(!event.shiftKey&&(document.activeElement===last||!modal.contains(document.activeElement))){event.preventDefault();first.focus()}
        });
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
          const commands={};
          document.querySelectorAll("[data-cmd]").forEach(input=>{commands[input.dataset.cmd]=input.value});
          payload.config_json={commands,branch_prefix:payload.branch_prefix||""};
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
        document.querySelector("[data-merge-branches-form]")?.addEventListener("submit",async(event)=>{
          event.preventDefault();
          const payload=Object.fromEntries(new FormData(event.currentTarget));
          const response=await fetch("/api/admin/projects/"+projectId+"/merge-branches",{method:"POST",headers:{"content-type":"application/json","x-csrf-token":csrf},body:JSON.stringify(payload)});
          const result=await response.json();
          if(response.ok)alert(result.outcome==="already_up_to_date"?"Already up to date — nothing to merge.":"Merged "+payload.head+" into "+payload.base+".");
          else alert(result.error);
        });
        document.querySelector("[data-add-override-form]")?.addEventListener("submit",async(event)=>{
          event.preventDefault();
          const form=event.currentTarget,button=form.querySelector("button[type=submit]");button.disabled=true;
          const type=form.querySelector("[data-add-override-select]").value;
          const response=await fetch("/api/admin/prompts",{method:"POST",headers:{"content-type":"application/json","x-csrf-token":csrf},body:JSON.stringify({scope:"project",project_id:projectId,prompt_type:type,content:"",active:false})});
          const result=await response.json();
          if(response.ok)location.reload();else{button.disabled=false;alert(result.error)}
        });
        const promptChecks=[...document.querySelectorAll("[data-prompt-check]")],selectedCount=document.querySelector("[data-prompt-selected-count]");
        const updateCount=()=>{if(selectedCount)selectedCount.textContent=String(promptChecks.filter(c=>c.checked).length)};
        promptChecks.forEach(checkbox=>checkbox.addEventListener("change",updateCount));
        document.querySelector("[data-prompt-check-all]")?.addEventListener("change",event=>{
          promptChecks.forEach(checkbox=>{checkbox.checked=event.target.checked});
          updateCount();
        });
        document.querySelectorAll("[data-prompt-bulk]").forEach(button=>button.addEventListener("click",async()=>{
          const ids=promptChecks.filter(c=>c.checked).map(c=>c.value);
          if(!ids.length){alert("Select one or more prompts");return}
          const action=button.dataset.promptBulk;
          if(action==="delete"&&!confirm("Delete the selected prompt overrides?"))return;
          button.disabled=true;
          const response=await fetch("/api/admin/projects/"+projectId+"/prompts/bulk",{method:"POST",headers:{"content-type":"application/json","x-csrf-token":csrf},body:JSON.stringify({action,ids})});
          const result=await response.json();
          if(response.ok)location.reload();else{button.disabled=false;alert(result.error)}
        }));
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
      ${path==="/admin/notifications"?`
        const csrf=sessionStorage.getItem("dccCsrf")||"";
        const providerForm=document.querySelector("[data-webhook-provider-form]");
        providerForm?.addEventListener("submit",async(event)=>{
          event.preventDefault();
          const data=new FormData(providerForm);const providerId=providerForm.dataset.providerId;
          const authType=data.get("auth_type");
          const enabledEvents=[...providerForm.querySelectorAll('input[type=checkbox][name^="event:"]')].filter(box=>box.checked).map(box=>box.name.slice(6));
          const payload={name:data.get("name"),type:"webhook",enabled:providerForm.elements.enabled.checked,
            enabled_events:enabledEvents,max_attempts:Number(data.get("max_attempts")),
            configuration:{base_url:data.get("base_url"),endpoint:data.get("endpoint"),timeout_seconds:Number(data.get("timeout_seconds")),
              authentication:authType==="none"?(providerId?null:undefined):{type:authType==="header"?"raw":authType,secret_reference:data.get("secret_reference")}}};
          const response=await fetch(providerId?"/api/admin/notifications/providers/"+providerId:"/api/admin/notifications/providers",
            {method:providerId?"PATCH":"POST",headers:{"content-type":"application/json","x-csrf-token":csrf},body:JSON.stringify(payload)});
          const result=await response.json();
          if(response.ok)location.reload();else providerForm.querySelector(".error").textContent=result.error;
        });
        providerForm?.querySelector("[data-test-provider]")?.addEventListener("click",async()=>{
          const providerId=providerForm.dataset.providerId;if(!providerId)return;
          const response=await fetch("/api/admin/notifications/providers/"+providerId+"/test",{method:"POST",headers:{"x-csrf-token":csrf}});
          if(response.ok)alert("Test notification queued");else alert((await response.json()).error);
        });
        document.querySelectorAll("[data-retry-delivery]").forEach(button=>button.addEventListener("click",async()=>{
          const response=await fetch("/api/admin/notifications/deliveries/"+button.dataset.retryDelivery+"/retry",{method:"POST",headers:{"x-csrf-token":csrf}});
          if(response.ok)location.reload();else alert((await response.json()).error);
        }));
      `:""}
      ${path==="/admin/settings"?`
        const csrf=sessionStorage.getItem("dccCsrf")||"";
        const form=document.querySelector("[data-ai-review-settings-form]");
        if(form){
          form.addEventListener("submit",async(event)=>{
            event.preventDefault();
            const data=new FormData(form);
            const response=await fetch("/api/admin/settings/ai-review",{method:"POST",headers:{"content-type":"application/json","x-csrf-token":csrf},body:JSON.stringify({default_model:data.get("default_model"),default_reasoning_level:data.get("default_reasoning_level")})});
            if(response.ok)location.reload();else{const result=await response.json();form.querySelector(".error").textContent=result.error}
          });
        }
        const systemForm=document.querySelector("[data-system-ai-settings-form]");
        if(systemForm){
          systemForm.addEventListener("submit",async(event)=>{
            event.preventDefault();
            const response=await fetch("/api/admin/settings/system-ai",{method:"POST",headers:{"content-type":"application/json","x-csrf-token":csrf},body:JSON.stringify(Object.fromEntries(new FormData(systemForm)))});
            if(response.ok)location.reload();else{const result=await response.json();systemForm.querySelector(".error").textContent=result.error}
          });
        }
        const priceForm=document.querySelector("[data-ai-model-price-form]");
        if(priceForm){
          priceForm.addEventListener("submit",async(event)=>{
            event.preventDefault();
            const data=new FormData(priceForm),rate=(name)=>Number(data.get(name));
            const response=await fetch("/api/admin/ai-model-prices",{method:"POST",headers:{"content-type":"application/json","x-csrf-token":csrf},body:JSON.stringify({model:data.get("model"),effective_from:data.get("effective_from"),input_usd_per_million:rate("input_usd_per_million"),output_usd_per_million:rate("output_usd_per_million"),cache_write_usd_per_million:rate("cache_write_usd_per_million"),cache_read_usd_per_million:rate("cache_read_usd_per_million"),source_url:data.get("source_url")})});
            if(response.ok)location.reload();else{const result=await response.json();priceForm.querySelector(".error").textContent=result.error}
          });
        }
      `:""}
      ${path==="/admin/pull-requests"?`
        const csrf=sessionStorage.getItem("dccCsrf")||"";
        document.querySelector("[data-sync-prs]")?.addEventListener("click",async(event)=>{
          const button=event.currentTarget;button.disabled=true;
          try{
            const response=await fetch("/api/admin/projects/import-github-prs",{method:"POST",headers:{"x-csrf-token":csrf}});
            const result=await response.json();
            if(response.ok)location.reload();else alert(result.error);
          }finally{button.disabled=false}
        });
        document.querySelector("select[name=repository]")?.addEventListener("change",function(){this.form.submit()});
      `:""}
      ${/^\/admin\/pull-requests\/[^/]+(\/\d+)?$/.test(path)?`
        const csrf=sessionStorage.getItem("dccCsrf")||"";
        const prId=document.querySelector("[data-pr-id]")?.dataset.prId;
        async function prAction(action,payload){
          const response=await fetch("/api/admin/pull-requests/"+prId+"/"+action,{method:"POST",headers:{"content-type":"application/json","x-csrf-token":csrf},body:JSON.stringify(payload||{})});
          if(response.ok)location.reload();else{const result=await response.json();alert(result.error)}
        }
        document.querySelector("[data-pr-refresh]")?.addEventListener("click",()=>prAction("refresh"));
        document.querySelector("[data-pr-mark-reviewed]")?.addEventListener("click",()=>prAction("mark-reviewed"));
        document.querySelector("[data-pr-approve]")?.addEventListener("click",event=>{
          const button=event.currentTarget;
          if(confirm("Approve and merge this pull request on GitHub? This cannot be undone from here."))prAction("approve",{expected_head_sha:button.dataset.prHeadSha,policy_snapshot_id:button.dataset.prPolicySnapshotId});
        });
        document.querySelector("[data-pr-request-changes]")?.addEventListener("click",()=>prAction("request-changes"));
        document.querySelector("[data-pr-resolve-conflicts]")?.addEventListener("click",(event)=>{
          if(!confirm("Resolve merge conflicts with AI and push the result to this PR's branch? This cannot be undone from here."))return;
          event.currentTarget.disabled=true;event.currentTarget.textContent="Resolving…";
          prAction("resolve-conflicts",{});
        });
        document.querySelector("[data-pr-close-ticket]")?.addEventListener("click",()=>{if(confirm("Close the linked ticket? This cannot be undone from here."))prAction("close-ticket")});
        document.querySelector("[data-pr-save-instructions]")?.addEventListener("click",()=>{
          const instructions=document.querySelector("[data-pr-repair-text]").value.trim();
          if(!instructions){alert("Instructions are required");return}
          prAction("repair-instructions",{instructions});
        });
        document.querySelector("[data-pr-start-repair]")?.addEventListener("click",()=>{
          const feedback=document.querySelector("[data-pr-repair-text]").value.trim();
          prAction("start-repair",feedback?{feedback}:{});
        });
        function runAiReview(){
          const model=document.querySelector("[data-ai-review-model]").value||undefined;
          const reasoning_level=document.querySelector("[data-ai-review-reasoning]").value||undefined;
          prAction("ai-review",{mode:"review_only",model,reasoning_level});
        }
        document.querySelector("[data-pr-ai-review]")?.addEventListener("click",(event)=>{
          event.currentTarget.disabled=true;event.currentTarget.textContent="Starting…";
          runAiReview();
        });
        const aiStatusBadge=document.querySelector("[data-ai-review-status]");
        if(aiStatusBadge&&aiStatusBadge.dataset.aiReviewStatus==="running"){
          const poll=setInterval(async()=>{
            try{
              const response=await fetch("/api/admin/pull-requests/"+prId);
              if(!response.ok)return;
              const result=await response.json();
              if(result.ai_reviews?.[0]?.status!=="running"){clearInterval(poll);location.reload()}
            }catch{}
          },4000);
        }
        const conflictResolutionBadge=document.querySelector("[data-conflict-resolution-status]");
        if(conflictResolutionBadge&&conflictResolutionBadge.dataset.conflictResolutionStatus==="running"){
          const poll=setInterval(async()=>{
            try{
              const response=await fetch("/api/admin/pull-requests/"+prId);
              if(!response.ok)return;
              const result=await response.json();
              if(result.conflict_resolutions?.[0]?.status!=="running"){clearInterval(poll);location.reload()}
            }catch{}
          },4000);
        }
        const createTicketBtn=document.querySelector("[data-open-create-ticket]"),createTicketDialog=document.querySelector("[data-create-ticket-dialog]"),createTicketForm=createTicketDialog?.querySelector("[data-create-ticket-form]");
        createTicketBtn?.addEventListener("click",()=>{
          createTicketForm.querySelector("[name=title]").value=createTicketBtn.dataset.title;
          createTicketForm.querySelector("[name=feedback]").value="";
          createTicketForm.querySelector("[name=description]").value="";createTicketForm.querySelector("[name=generate_description]").checked=true;createTicketForm.querySelector(".error").textContent="";
          createTicketDialog.showModal();
        });
        createTicketDialog?.querySelector("[data-close-dialog]")?.addEventListener("click",()=>createTicketDialog.close());
        createTicketDialog?.addEventListener("keydown",event=>{
          if(event.key!=="Tab")return;
          const focusables=[...createTicketDialog.querySelectorAll("button,a[href],input,select,textarea,[tabindex]")].filter(el=>!el.disabled);
          if(!focusables.length)return;
          const first=focusables[0],last=focusables[focusables.length-1];
          if(event.shiftKey&&(document.activeElement===first||!createTicketDialog.contains(document.activeElement))){event.preventDefault();last.focus()}
          else if(!event.shiftKey&&(document.activeElement===last||!createTicketDialog.contains(document.activeElement))){event.preventDefault();first.focus()}
        });
        createTicketForm?.addEventListener("submit",async(event)=>{
          event.preventDefault();
          const description=createTicketForm.querySelector("[name=description]"),feedback=createTicketForm.querySelector("[name=feedback]").value.trim(),generate=createTicketForm.querySelector("[name=generate_description]").checked;
          if(!description.value.trim()&&generate&&feedback)description.value=feedback;
          if(!description.value.trim()){createTicketForm.querySelector(".error").textContent="Description is required";return}
          const data=new FormData(createTicketForm);
          const response=await fetch("/api/admin/tickets",{method:"POST",headers:{"content-type":"application/json","x-csrf-token":csrf},body:JSON.stringify({project_id:createTicketBtn.dataset.projectId,title:data.get("title"),description:data.get("description")})});
          const result=await response.json();
          if(!response.ok){createTicketForm.querySelector(".error").textContent=result.error;return}
          if(generate&&feedback)fetch("/api/admin/pull-requests/"+prId+"/follow-up-description",{method:"POST",headers:{"content-type":"application/json","x-csrf-token":csrf},body:JSON.stringify({feedback,ticket_id:result.ticket.id,initial_description:description.value}),keepalive:true});
          createTicketDialog.close();location.reload();
        });
      `:""}
      ${path==="/admin/skills"?`
        const csrf=sessionStorage.getItem("dccCsrf")||"",modal=document.querySelector("[data-register-skill-modal]"),form=document.querySelector("[data-register-skill-form]");
        const searchInput=document.querySelector("[data-skill-search-list]"),categoryChips=document.querySelectorAll("[data-category]");
        let activeCategory="all";
        document.querySelector("[data-register-skill]")?.addEventListener("click",()=>modal.showModal());
        modal?.querySelector("[data-close-modal]")?.addEventListener("click",()=>modal.close());
        modal?.addEventListener("keydown",event=>{
          if(event.key!=="Tab")return;
          const focusables=[...modal.querySelectorAll("button,a[href],input,select,textarea,[tabindex]")].filter(el=>!el.disabled);
          if(!focusables.length)return;
          const first=focusables[0],last=focusables[focusables.length-1];
          if(event.shiftKey&&(document.activeElement===first||!modal.contains(document.activeElement))){event.preventDefault();last.focus()}
          else if(!event.shiftKey&&(document.activeElement===last||!modal.contains(document.activeElement))){event.preventDefault();first.focus()}
        });
        form?.addEventListener("submit",async(event)=>{
          event.preventDefault();const data=new FormData(form);const payload=Object.fromEntries(data);payload.enabled=form.elements.enabled.checked;
          const response=await fetch("/api/admin/skills",{method:"POST",headers:{"content-type":"application/json","x-csrf-token":csrf},body:JSON.stringify(payload)});
          if(response.ok){modal.close();location.reload()}else{const result=await response.json();form.querySelector(".error").textContent=result.error}
        });
        categoryChips.forEach(chip=>chip.addEventListener("click",()=>{
          activeCategory=chip.dataset.category;
          categoryChips.forEach(c=>c.style.background=c===chip?"var(--accent-soft)":"transparent");
          categoryChips.forEach(c=>c.style.color=c===chip?"var(--accent)":"inherit");
          filterRows();
        }));
        searchInput?.addEventListener("input",filterRows);
        function filterRows(){
          const search=(searchInput?.value||"").toLowerCase();
          document.querySelectorAll("[data-skill-row]").forEach(row=>{
            const matchesSearch=row.textContent.toLowerCase().includes(search);
            const matchesCategory=activeCategory==="all"||row.dataset.skillRow===activeCategory;
            row.style.display=matchesSearch&&matchesCategory?"":"none";
          });
        }
        document.querySelector("[data-validate-all]")?.addEventListener("click",async(event)=>{
          const button=event.currentTarget;button.disabled=true;
          try{
            const ids=[...document.querySelectorAll("[data-skill-id]")].map(el=>el.dataset.skillId);
            for(const id of ids){await fetch("/api/admin/skills/"+id+"/validate",{method:"POST",headers:{"x-csrf-token":csrf}})}
            location.reload();
          }finally{button.disabled=false}
        });
      `:""}
      ${/^\/admin\/skills\/[^/]+$/.test(path)?`
        const csrf=sessionStorage.getItem("dccCsrf")||"";
        document.querySelector("[data-validate-skill]")?.addEventListener("click",async()=>{
          const skillId=window.location.pathname.split("/").pop();
          const response=await fetch("/api/admin/skills/"+skillId+"/validate",{method:"POST",headers:{"x-csrf-token":csrf}});
          if(response.ok){alert("Validation completed")}else{const result=await response.json();alert(result.error)}
        });
        document.querySelector("[data-save-skill]")?.addEventListener("click",async()=>{
          const skillId=window.location.pathname.split("/").pop();
          const description=document.querySelector("[data-skill-description]")?.value||"";
          const filesystem_path=document.querySelector("[data-skill-path]")?.value.trim()||"";
          const payload={description,filesystem_path};
          const response=await fetch("/api/admin/skills/"+skillId,{method:"PATCH",headers:{"content-type":"application/json","x-csrf-token":csrf},body:JSON.stringify(payload)});
          if(response.ok){alert("Skill saved")}else{const result=await response.json();alert(result.error)}
        });
        document.querySelector("[data-disable-skill]")?.addEventListener("click",async()=>{
          if(!confirm("Disable this skill? It stops being offered on tickets."))return;
          const skillId=window.location.pathname.split("/").pop();
          const response=await fetch("/api/admin/skills/"+skillId,{method:"DELETE",headers:{"x-csrf-token":csrf}});
          if(response.ok){location.href="/admin/skills"}else{const result=await response.json();alert(result.error)}
        });
        document.querySelector("[data-enable-skill]")?.addEventListener("click",async()=>{
          if(!confirm("Enable this skill? It will start being offered on tickets again."))return;
          const skillId=window.location.pathname.split("/").pop();
          const response=await fetch("/api/admin/skills/"+skillId,{method:"PATCH",headers:{"content-type":"application/json","x-csrf-token":csrf},body:JSON.stringify({enabled:true})});
          if(response.ok){location.reload()}else{const result=await response.json();alert(result.error)}
        });
      `:""}
      ${/^\/admin\/runs\/[^/]+$/.test(path)?`
        const csrf=sessionStorage.getItem("dccCsrf")||"";
        const runId=window.location.pathname.split("/").pop();
        const stream=document.querySelector("[data-run-stream]");
        let lastSeq=0;
        const repairDialog=document.querySelector("[data-repair-dialog]");
        document.querySelector("[data-run-cancel]")?.addEventListener("click",async(event)=>{
          if(!confirm("Cancel this run?"))return;
          const response=await fetch("/api/admin/runs/"+runId+"/cancel",{method:"POST",headers:{"x-csrf-token":csrf}});
          if(response.ok)location.reload();else{const result=await response.json();alert(result.error)}
        });
        document.querySelector("[data-run-repair]")?.addEventListener("click",()=>repairDialog?.showModal());
        repairDialog?.querySelector("[data-close-dialog]")?.addEventListener("click",()=>repairDialog.close());
        repairDialog?.addEventListener("keydown",event=>{
          if(event.key!=="Tab")return;
          const focusables=[...repairDialog.querySelectorAll("button,a[href],input,select,textarea,[tabindex]")].filter(el=>!el.disabled);
          if(!focusables.length)return;
          const first=focusables[0],last=focusables[focusables.length-1];
          if(event.shiftKey&&(document.activeElement===first||!repairDialog.contains(document.activeElement))){event.preventDefault();last.focus()}
          else if(!event.shiftKey&&(document.activeElement===last||!repairDialog.contains(document.activeElement))){event.preventDefault();first.focus()}
        });
        repairDialog?.querySelector("[data-submit-repair]")?.addEventListener("click",async()=>{
          const feedback=repairDialog.querySelector("[data-repair-feedback]").value.trim();
          if(!feedback){alert("Instructions are required");return}
          const response=await fetch("/api/admin/runs/"+runId+"/repair",{method:"POST",headers:{"content-type":"application/json","x-csrf-token":csrf},body:JSON.stringify({feedback})});
          if(response.ok){repairDialog.close();location.reload()}else{const result=await response.json();alert(result.error)}
        });
        document.querySelector("[data-run-retry]")?.addEventListener("click",async()=>{
          const response=await fetch("/api/admin/runs/"+runId+"/retry",{method:"POST",headers:{"x-csrf-token":csrf}});
          if(response.ok)location.reload();else{const result=await response.json();alert(result.error)}
        });
        if(stream){
          const poll=async()=>{
            try{
              const response=await fetch("/api/admin/runs/"+runId+"/events?after="+lastSeq);
              if(!response.ok)return clearInterval(pollId);
              const{run,events}=await response.json();
              if(!events||!events.length)return;
              for(const event of events){stream.textContent+=event.sequence+" "+event.event_type+" "+JSON.stringify(event.event_json)+"\\n";lastSeq=Math.max(lastSeq,event.sequence)}
              stream.scrollTop=stream.scrollHeight;
              if(!["running","queued"].includes(run.status))clearInterval(pollId);
            }catch(e){clearInterval(pollId)}
          };
          const pollId=setInterval(poll,5000);
          poll();
        }
      `:""}
    `);
}

export function formControls(fields: any[], projects: any[], values: Record<string, any> = {}, mode: "public" | "admin" = "public") {
  return fields.filter((field) => field.field_type !== "static" && (mode === "public" || !["hidden", "image_upload"].includes(field.field_type))).map((field) => {
    const name = escapeHtml(field.field_key);
    const required = field.required ? " required" : "";
    const type = field.field_type;
    const value = mode === "admin" ? escapeHtml(values[field.field_key]) : "";
    const options = (Array.isArray(field.options_json) ? field.options_json : []).map((option: any) => {
      const optionValue = option.value ?? option;
      return `<option value="${escapeHtml(optionValue)}"${mode === "admin" && String(optionValue) === String(values[field.field_key]) ? " selected" : ""}>${escapeHtml(option.label ?? option)}</option>`;
    }).join("");
    let control = `<input name="${name}" placeholder="${escapeHtml(field.placeholder)}"${mode === "admin" ? ` value="${value}"` : ""}${required}>`;
    if (type === "long_text") control = `<textarea name="${name}" rows="5"${required}>${value}</textarea>`;
    if (type === "email" || type === "url" || type === "number") control = `<input name="${name}" type="${type}"${mode === "admin" ? ` value="${value}"` : ""}${required}>`;
    if (type.includes("selector") || ["dropdown", "radio", "multi_select"].includes(type)) {
      const choices = type === "project_selector" ? projects.map((project) => `<option value="${project.id}"${mode === "admin" && String(project.id) === String(values[field.field_key]) ? " selected" : ""}>${escapeHtml(project.name)}</option>`).join("") : options;
      control = `<select name="${name}"${required}>${choices}</select>`;
    }
    if (type === "checkbox") control = `<input name="${name}" type="checkbox" value="true"${mode === "admin" && values[field.field_key] ? " checked" : ""}>`;
    if (type === "hidden") return `<label class="honeypot" aria-hidden="true">${escapeHtml(field.label)}<input name="${name}" tabindex="-1" autocomplete="off"></label>`;
    if (type === "image_upload") control = `<input name="${name}" type="file" accept="image/png,image/jpeg" multiple><small>PNG of JPG · max 5 bestanden · max 5 MB per bestand · geen SVG</small>`;
    return `<label class="field"><span>${escapeHtml(field.label)}</span>${control}</label>`;
  }).join("");
}

export function publicFormPage(form: any, fields: any[], projects: any[]) {
  const controls = formControls(fields, projects, {}, "public");
  return document(form.title, `<main class="public"><div class="url-strip">/f/${escapeHtml(form.slug)}</div><form class="card" id="public-form"><div class="card-body"><div class="eyebrow">Feedback</div><h1>${escapeHtml(form.title)}</h1><p>${escapeHtml(form.description)}</p><div class="grid one">${controls}</div><br><button class="button primary" type="submit">Melding versturen</button><p class="error" role="alert"></p></div></form></main>`, `
    document.querySelector("#public-form").addEventListener("submit",async(event)=>{
      event.preventDefault();const data=new FormData(event.currentTarget);const payload={};const files={};
      for(const [key,value] of data){if(value instanceof File&&value.size){(files[key]=files[key]||[]).push(value)}else if(!(value instanceof File))payload[key]=value}
      for(const [key,list] of Object.entries(files)){
        if(list.length>5){document.querySelector(".error").textContent="Max 5 bestanden per veld";return}
        const ids=[];
        for(const file of list){
          const upload=new FormData();upload.append("file",file);
          const result=await fetch("/api/public/forms/${escapeHtml(form.slug)}/uploads",{method:"POST",body:upload});
          if(!result.ok){document.querySelector(".error").textContent="Upload geweigerd";return}
          ids.push((await result.json()).upload_id);
        }
        payload[key]=ids;
      }
      const response=await fetch("/api/public/forms/${escapeHtml(form.slug)}/submissions",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)});
      const result=await response.json();if(!response.ok){document.querySelector(".error").textContent=result.error;return}
      sessionStorage.setItem("submittedTicket",result.ticket_number);location.href="/f/${escapeHtml(form.slug)}/submitted";
    });`);
}

export function submittedPage(form: any) {
  return document("Melding ontvangen", `<main class="public"><section class="card"><div class="card-body"><div class="eyebrow">Ontvangen</div><h1>Bedankt — je melding staat genoteerd.</h1><p>${escapeHtml(form.settings_json?.completion_message ?? "Bewaar je referentie als je er later naar wilt verwijzen.")}</p><div class="reference"><span class="eyebrow">Referentie</span><strong class="mono" id="reference"></strong></div></div></section></main>`, `document.querySelector("#reference").textContent=sessionStorage.getItem("submittedTicket")||"Referentie niet beschikbaar";`);
}
