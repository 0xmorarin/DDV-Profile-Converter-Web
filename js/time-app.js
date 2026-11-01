import {loadProfile, createEncryptedProfile, buildBackupFileName} from './profile.js';
import {inspectTimingFields, patchTimingFields} from './time-tools.js';

const $ = id => document.getElementById(id);
let state = null;
let prepared = null;
const edits = new Map();
const labels = {
  FishSpawningInVillage:'Fishing ripples', WildCropsSpawningInVillage:'Wild crops / herbs',
  FlowerSpawningInVillage:'Flowers', ItemSpawning:'Item spawn',
  MiningRockTurningSpecial:'Special mining rocks'
};

function setStatus(message, error=false){ $('timingStatus').textContent=message; $('timingStatus').classList.toggle('error',error); }
function download(name,bytes,mime='application/octet-stream'){
  const url=URL.createObjectURL(new Blob([bytes],{type:mime}));
  const a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),15000);
}
function toLocalInput(utc){
  const date=new Date(utc);
  if(!Number.isFinite(date.getTime()))return '';
  const local=new Date(date.getTime()-date.getTimezoneOffset()*60000);
  return local.toISOString().slice(0,16);
}
function fromLocalInput(value){
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value))throw new Error('Enter a valid local date and time.');
  const date=new Date(value);
  if(!Number.isFinite(date.getTime()))throw new Error('The selected date is invalid.');
  // Reject date normalization of nonexistent dates and DST gaps.
  if(toLocalInput(date.toISOString())!==value)throw new Error('The selected local date/time does not exist in your time zone.');
  return date.toISOString();
}
function element(tag,text,className){
  const node=document.createElement(tag);if(text!==undefined)node.textContent=String(text);
  if(className)node.className=className;return node;
}
function updateActions(){
  $('timingChanges').textContent=`${edits.size} pending event change${edits.size===1?'':'s'}. Nothing is written to the original save.`;
  $('timingGenerate').disabled=!state||!state.report.canWriteSchema||!edits.size||!$('timingAcknowledged').checked;
  $('timingDownloads').hidden=true;prepared=null;
}
function renderEvents(){
  if(!state)return;
  const tbody=$('timingEvents');tbody.replaceChildren();
  const type=$('timingType').value;
  const query=$('timingSearch').value.trim().toLowerCase();
  const showLocked=$('timingShowLocked').checked;
  for(const event of state.report.events){
    if(type&&event.type!==type)continue;
    if(!showLocked&&!event.editable)continue;
    if(query&&!`${event.eventKey} ${event.itemId} ${event.type}`.toLowerCase().includes(query))continue;
    const row=element('tr');
    if(edits.has(event.pointer))row.classList.add('modified');
    const name=element('td');name.append(element('strong',`#${event.eventKey} — ${labels[event.type]??event.type}`),element('small',`Event definition ID: ${event.itemId||'unknown'}`));
    const current=element('td');current.append(element('span',event.time??'—'),element('small',event.classification));
    const editor=element('td');
    if(event.editable){
      const field=document.createElement('input');field.type='datetime-local';field.step='60';
      field.value=edits.get(event.pointer)?.local ?? toLocalInput(event.time);
      field.setAttribute('aria-label',`New local time for event ${event.eventKey}`);
      field.addEventListener('change',()=>{
        if(!field.value||field.value===toLocalInput(event.time))edits.delete(event.pointer);
        else edits.set(event.pointer,{local:field.value,original:event});
        row.classList.toggle('modified',edits.has(event.pointer));updateActions();
      });
      editor.append(field);
    }else editor.append(element('span',event.reason||'Read-only','locked'));
    row.append(name,current,editor);tbody.append(row);
  }
}
function renderReport(){
  const report=state.report;edits.clear();prepared=null;
  const editable=report.events.filter(x=>x.editable).length;
  const longRange=report.events.filter(x=>x.classification==='long-range').length;
  $('timingSummary').textContent=`Schema ${report.schema} · ${report.events.length} recurring events · ${editable} manually editable · ${longRange} long-range schedules locked. ${report.canWriteSchema?'Manual edits are experimental; no automatic repair is performed.':'Unknown schema: diagnostic only.'}`;
  const diagnostics=$('timingDiagnostic');diagnostics.replaceChildren();
  for(const entry of report.diagnostic){
    const row=element('div',undefined,'diagnostic-row');row.append(element('span',entry.pointer),element('span',`${entry.time} (${entry.classification})`));diagnostics.append(row);
  }
  const selector=$('timingType');selector.replaceChildren(new Option('All event types',''));
  for(const type of [...new Set(report.events.map(x=>x.type))].sort())selector.add(new Option(labels[type]??type,type));
  $('timingAcknowledged').checked=false;
  $('timingReport').hidden=false;updateActions();renderEvents();
}
$('timingFile').addEventListener('change',async event=>{
  const file=event.target.files?.[0];if(!file)return;
  state=null;prepared=null;edits.clear();$('timingReport').hidden=true;
  setStatus('Reading and validating the profile locally…');
  try{
    if(file.size>100*1024*1024)throw new Error('Profile exceeds the 100 MiB size limit.');
    const raw=new Uint8Array(await file.arrayBuffer());
    const loaded=await loadProfile(raw);
    const report=inspectTimingFields(loaded.jsonText);
    state={raw,loaded,report,originalName:file.name};
    renderReport();setStatus(`Loaded ${file.name}. Original bytes are preserved in memory.`);
  }catch(error){setStatus(error instanceof Error?error.message:String(error),true);}
  event.target.value='';
});
$('timingType').addEventListener('change',renderEvents);
$('timingSearch').addEventListener('input',renderEvents);
$('timingShowLocked').addEventListener('change',renderEvents);
$('timingAcknowledged').addEventListener('change',updateActions);
$('timingReset').addEventListener('click',()=>{edits.clear();updateActions();renderEvents();});
$('downloadOriginal').addEventListener('click',()=>{
  if(!state)return;download(buildBackupFileName(state.loaded.metadata),state.raw);
});
$('timingGenerate').addEventListener('click',async()=>{
  if(!state||!$('timingAcknowledged').checked||!edits.size)return;
  $('timingGenerate').disabled=true;setStatus('Creating and verifying the modified copy…');
  try{
    const proposed=[...edits].map(([pointer,{local,original}])=>({pointer,expected:original.time,value:fromLocalInput(local)}));
    const patched=patchTimingFields(state.loaded.jsonText,proposed);
    const encoded=await createEncryptedProfile(patched.jsonText,state.loaded.metadata);
    const reloaded=await loadProfile(encoded);
    const verified=inspectTimingFields(reloaded.jsonText);
    for(const change of patched.changes){
      if(verified.events.find(x=>x.pointer===change.pointer)?.time!==change.after)throw new Error(`Re-open verification failed at ${change.pointer}.`);
    }
    prepared=encoded;$('timingDownloads').hidden=false;
    $('timingVerified').textContent=`Encrypted copy round-trip verified. ${patched.changes.length} event timestamps changed; all unrelated JSON tokens were preserved by the patcher before re-encoding. Gameplay behavior is NOT verified.`;
    setStatus('Edited profile prepared. Download the original backup separately before using it.');
  }catch(error){prepared=null;$('timingDownloads').hidden=true;setStatus(error instanceof Error?error.message:String(error),true);}
  finally{$('timingGenerate').disabled=!edits.size||!$('timingAcknowledged').checked;}
});
$('timingDownloadEdited').addEventListener('click',()=>{if(prepared)download('profile.json',prepared);});
