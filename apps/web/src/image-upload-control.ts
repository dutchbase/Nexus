import type { TicketAttachment } from "@dcc/domain";

export type ImageControlOptions = {
  fieldKey: string;
  label: string;
  required: boolean;
  uploadUrl: string;
  existing: TicketAttachment[];
  disabled?: boolean;
};

const escape = (value: unknown) => String(value ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&apos;");

export function clipboardImageType(types: readonly string[]): "image/png" | "image/jpeg" | null {
  return types.includes("image/png") ? "image/png" : types.includes("image/jpeg") ? "image/jpeg" : null;
}

export function imageUploadControl(options: ImageControlOptions): string {
  const key = escape(options.fieldKey);
  const disabled = options.disabled ? " disabled" : "";
  const existing = options.existing.map((item) => `<li data-image-entry="${escape(item.upload_id)}" data-upload-id="${escape(item.upload_id)}" data-existing>
    <a href="${escape(item.url)}" target="_blank" rel="noopener">${escape(item.original_name ?? "image")}</a>
    <button class="button" type="button" data-image-remove>Remove</button></li>`).join("");
  return `<fieldset class="field" data-image-control="${key}" data-upload-url="${escape(options.uploadUrl)}"${options.required ? " data-required" : ""}>
    <legend>${escape(options.label)}</legend><div><button class="button" type="button" data-image-paste${disabled}>Paste</button>
    <label class="button">Choose files<input type="file" accept="image/png,image/jpeg" multiple data-image-picker${disabled} hidden></label></div>
    <small>PNG or JPG · max 5 images · max 5 MB each · no SVG</small>
    <ul data-image-list>${existing}</ul><p class="error" data-image-error="${key}" aria-live="polite"></p>
  </fieldset>`;
}

export function imageUploadScript(): string {
  return `
  (()=>{
    const controls=new Map(),maxCount=5,maxBytes=5*1024*1024,supported=["image/png","image/jpeg"];
    const csrf=()=>sessionStorage.getItem("dccCsrf")||decodeURIComponent((document.cookie.match(/(?:^|;\\s*)dcc_csrf=([^;]*)/)||[])[1]||"");
    const projectId=form=>form.elements.project_id?.value||form.dataset.projectId||"";
    const uploadUrl=(control,form)=>control.dataset.uploadUrl.replace("{project_id}",encodeURIComponent(projectId(form)));
    function setup(control){
      const form=control.closest("form"),list=control.querySelector("[data-image-list]"),error=control.querySelector("[data-image-error]"),picker=control.querySelector("[data-image-picker]"),paste=control.querySelector("[data-image-paste]"),entries=[];
      list.querySelectorAll("[data-image-entry]").forEach(row=>entries.push({entryId:row.dataset.imageEntry,uploadId:row.dataset.uploadId,status:"ready",existing:true,row}));
      const message=text=>{error.textContent=text};
      const button=(label,action)=>{const value=document.createElement("button");value.type="button";value.className="button";value.textContent=label;value.dataset[action]="";return value};
      function removeImage(entryId){const entry=entries.find(item=>item.entryId===entryId);if(!entry)return;entry.removed=true;entry.abort?.abort();entry.row.remove();message("")}
      async function upload(entry){
        entry.status="uploading";entry.row.dataset.status="uploading";entry.row.querySelector("small").textContent="Uploading…";entry.abort=new AbortController();
        try{const body=new FormData();body.append("file",entry.file);const url=uploadUrl(control,form),headers=url.startsWith("/api/public/")?{}:{"x-csrf-token":csrf()};const response=await fetch(url,{method:"POST",body,headers,signal:entry.abort.signal});const result=await response.json().catch(()=>({}));if(!response.ok)throw new Error(result.error||"Upload failed");if(entry.removed)return;entry.uploadId=result.upload_id;entry.status="ready";entry.row.dataset.status="ready";entry.row.querySelector("small").textContent="Ready";entry.row.querySelector("[data-image-retry]")?.remove();message("")}
        catch(failure){if(entry.removed||failure?.name==="AbortError")return;entry.status="failed";entry.row.dataset.status="failed";entry.row.querySelector("small").textContent="Upload failed";if(!entry.row.querySelector("[data-image-retry]"))entry.row.append(button("Retry","imageRetry"));message("One or more images could not be uploaded.")}
      }
      async function retryImage(entryId){const entry=entries.find(item=>item.entryId===entryId&&!item.removed&&item.status==="failed");if(entry)await upload(entry)}
      async function addImage(file){
        message("");if(!supported.includes(file.type)){message("Choose a PNG or JPEG image.");return}if(file.size>maxBytes){message("Each image must be 5 MB or smaller.");return}if(entries.filter(item=>!item.removed).length>=maxCount){message("You can add at most 5 images.");return}
        const entry={entryId:crypto.randomUUID(),file,status:"uploading",removed:false};entries.push(entry);const row=document.createElement("li");entry.row=row;row.dataset.imageEntry=entry.entryId;const image=document.createElement("img");image.alt=file.name;image.style.maxWidth="160px";const reader=new FileReader();reader.addEventListener("load",()=>image.src=String(reader.result));reader.readAsDataURL(file);const name=document.createElement("span");name.textContent=file.name;const status=document.createElement("small");row.append(image,name,status,button("Remove","imageRemove"));list.append(row);await upload(entry)
      }
      paste.addEventListener("click",async()=>{if(!window.isSecureContext||!navigator.clipboard?.read){message("Clipboard access is unavailable. Choose an image file instead.");return}try{const items=await navigator.clipboard.read();let found=false;for(const item of items){const type=supported.find(type=>item.types.includes(type));if(!type)continue;found=true;const blob=await item.getType(type);await addImage(new File([blob],"screenshot."+(type==="image/png"?"png":"jpg"),{type}))}if(!found)message("No image found on your clipboard.")}catch{message("Could not read your clipboard. Allow access or choose an image file.")}});
      picker.addEventListener("change",async()=>{for(const file of picker.files||[])await addImage(file);picker.value=""});
      list.addEventListener("click",event=>{const row=event.target.closest("[data-image-entry]");if(!row)return;if(event.target.closest("[data-image-remove]"))removeImage(row.dataset.imageEntry);if(event.target.closest("[data-image-retry]"))retryImage(row.dataset.imageEntry)});
      controls.set(control,{form,entries,error,addImage,retryImage,removeImage});
    }
    document.querySelectorAll("[data-image-control]").forEach(setup);
    const states=form=>[...controls.values()].filter(state=>state.form===form);
    function pending(form){return states(form).some(state=>state.entries.some(item=>!item.removed&&item.status==="uploading"))}
    function invalid(form){let bad=false;for(const state of states(form)){const active=state.entries.filter(item=>!item.removed);const failed=active.some(item=>item.status==="failed");const missing=state.error.closest("[data-required]")&&active.every(item=>item.status!=="ready");if(failed||missing){state.error.textContent=failed?"Retry or remove failed images.":"Add at least one image.";bad=true}}return bad}
    function selections(form){return Object.fromEntries(states(form).map(state=>[state.error.dataset.imageError,state.entries.filter(item=>!item.removed&&item.status==="ready").map(item=>item.uploadId)]))}
    document.querySelectorAll('select[name="project_id"]').forEach(select=>{const form=select.form;if(!form)return;let previous=select.value;const update=()=>{const disabled=!select.value;states(form).forEach(state=>{state.error.closest("[data-image-control]").querySelectorAll("button,input").forEach(item=>item.disabled=disabled)})};update();select.addEventListener("change",()=>{if(previous&&previous!==select.value)states(form).forEach(state=>{state.entries.filter(item=>!item.existing&&!item.removed).forEach(item=>state.removeImage(item.entryId));state.error.textContent="Images were cleared because the project changed."});previous=select.value;update()})});
    window.nexusImages={pending,invalid,selections};
  })();`;
}
