'use strict';
(()=>{
const $=id=>document.getElementById(id),q=new URLSearchParams(location.search);
let started=false,running=false,exitCode=null,blocked=null,urls=[],romBytes=null;
// The bundle never contains a ROM or BIOS (LEGAL.md). manifest.json "assets" lists
// the SHA-1s this build needs; the visitor's own files are checked here and handed
// to the runtime in memory, and the runtime checks them again.
let expected=null,sha='';
const picked={rom:null,bios:null};
const LOOPBACK=new Set(['localhost','127.0.0.1','[::1]']);
function line(text,error=false){text=String(text).slice(0,2000);(error?console.error:console.log)(text);const el=document.createElement('div');el.textContent=text;if(error)el.className='err';$('log').appendChild(el);while($('log').children.length>4000)$('log').firstChild.remove();}
const host=globalThis.GbrHost=new GbrWebHost($('canvas'),t=>line(t));
// Battery saves and save states stay in this browser (IndexedDB), keyed by the
// verified ROM SHA-1. See packaging/web/save_store.js.
const saves=globalThis.GbrSaves=new GbrSaveStore((t,error)=>line(t,error),()=>renderSaves());
// Files in MEMFS are complete (.tmp + rename), so syncing after exit/abort is safe.
// Never rely on the runtime's last async notice having arrived first.
async function settleSaves(){saves.persist();try{await saves.flush();}catch(e){line('Save was not stored in this browser: '+e.message,true);}}
function stopped(){running=false;saves.running=false;renderSaves();}
function fail(e){host.fail(e);$('status').textContent='failed: '+e;line(e,true);stopped();void settleSaves().finally(()=>{$('reload').disabled=false;renderSaves();});void host.shutdown();}
function offer(name,data,type='application/octet-stream'){const url=URL.createObjectURL(new Blob([data],{type}));urls.push(url);const a=document.createElement('a');a.href=url;a.download=name;a.textContent=name;a.style.marginRight='12px';$('downloads').appendChild(a);}
addEventListener('error',e=>line(e.message,true));addEventListener('unhandledrejection',e=>line(e.reason,true));
addEventListener('securitypolicyviolation',e=>line(`Content-Security-Policy blocked ${e.violatedDirective}: ${e.blockedURI||'inline'}`,true));
$('canvas').addEventListener('contextmenu',e=>e.preventDefault());

// ---- ROM / BIOS supplied by the visitor --------------------------------------
let assetStore;
function rememberedStore(){
 if(assetStore===undefined){try{assetStore=new GbrAssets.AssetStore(GbrAssets.indexedDBBackend());}catch(e){assetStore=null;line('Remembering files is unavailable: '+e.message,true);}}
 return assetStore;
}
function readPreference(){try{return localStorage.getItem('gbarecomp:remember-assets')==='1';}catch(e){return false;}}
function writePreference(on){try{localStorage.setItem('gbarecomp:remember-assets',on?'1':'0');}catch(e){}}
function renderAssets(){
 for(const kind of ['rom','bios']){
  const p=picked[kind],el=$(kind+'status'),label=kind==='rom'?'ROM':'BIOS';
  if(p)el.textContent=`${label}: verified${p.info?.title?` "${p.info.title}" (${p.info.code})`:''} · SHA-1 ${p.sha1} · ${p.source}`;
  else if(expected)el.textContent=`${label}: needed · SHA-1 ${expected[kind+'_sha1']} · ${kind==='rom'?expected.game_name:'retail Game Boy Advance BIOS, 16 KB'}`;
  else el.textContent=`${label}: waiting for manifest.json`;
  el.className=p?'':'err';
 }
 if(!started)$('start').disabled=!(expected&&picked.rom&&picked.bios);
}
async function accept(bytes,source,remember=$('remember').checked){
 const r=await GbrAssets.inspect(bytes,expected);
 if(!r.ok){line(`${source}: ${r.reason}`,true);return r;}
 picked[r.kind]={bytes,sha1:r.sha1,info:r.info,source};
 line(`${source}: ${r.kind==='rom'?'ROM':'BIOS'} verified (SHA-1 ${r.sha1})`);
 renderAssets();
 if(remember){const store=rememberedStore();if(store)await store.remember(r.kind,r.sha1,bytes).catch(e=>line(`Could not remember the ${r.kind} in this browser: ${e.message}`,true));}
 return r;
}
async function acceptFiles(files){
 if(!expected){line('Wait for manifest.json before loading files',true);return;}
 if(started){line('Reload the page to change the ROM or BIOS',true);return;}
 for(const file of files){
  if(file.size>64*1024*1024){line(`${file.name}: ${file.size} bytes is larger than any GBA ROM`,true);continue;}
  try{await accept(new Uint8Array(await file.arrayBuffer()),file.name);}catch(e){line(`${file.name}: ${e.message}`,true);}
 }
}
async function recallRemembered(){
 const store=rememberedStore();if(!store)return;
 for(const kind of ['rom','bios']){
  if(picked[kind])continue;
  try{const bytes=await store.recall(kind,expected[kind+'_sha1']);if(bytes)await accept(bytes,'remembered in this browser',false);}
  catch(e){line(`Could not read the remembered ${kind}: ${e.message}`,true);}
 }
}
// Automated tests only: same-origin files served by serve.py --dev-assets, on loopback.
async function loadDevAssets(){
 const names=[q.get('rom'),q.get('bios')].filter(Boolean);if(!names.length)return;
 if(!LOOPBACK.has(location.hostname)){line('?rom= and ?bios= are ignored outside localhost: load your own files instead',true);return;}
 for(const name of names){
  const url=new URL(name,location.href);
  if(url.origin!==location.origin){line(`${name}: only same-origin dev assets are allowed`,true);continue;}
  const r=await fetch(url,{cache:'no-store'});
  if(!r.ok){line(`${name}: HTTP ${r.status}`,true);continue;}
  await accept(new Uint8Array(await r.arrayBuffer()),name,false);
 }
}
const ready=(async()=>{
 const r=await fetch('manifest.json',{cache:'no-store'});
 if(!r.ok)throw Error(`manifest.json: HTTP ${r.status}`);
 const m=await r.json(),hash=/^[0-9a-f]{40}$/;
 if(!hash.test(m.assets?.rom_sha1||'')||!hash.test(m.assets?.bios_sha1||''))throw Error('manifest.json lists no ROM/BIOS SHA-1: rebuild the bundle with packaging/web/build_web.sh');
 expected=m.assets;sha=expected.rom_sha1;
 $('buildinfo').textContent=`${expected.game_name} · ${m.distribution||'unlabelled'} · ${String(m.revision||'').slice(0,12)}`;
 renderAssets();renderSaves();
 await recallRemembered();
 await loadDevAssets();
})().catch(e=>{line(e.message||String(e),true);$('status').textContent='failed: '+(e.message||e);});
$('assetfiles').onchange=async()=>{const files=[...$('assetfiles').files];$('assetfiles').value='';await acceptFiles(files);};
for(const type of ['dragenter','dragover'])$('surface').addEventListener(type,e=>{e.preventDefault();e.dataTransfer.dropEffect='copy';});
$('surface').addEventListener('drop',e=>{e.preventDefault();void acceptFiles([...e.dataTransfer.files]);});
$('remember').checked=readPreference();
$('remember').onchange=async()=>{
 writePreference($('remember').checked);if(!$('remember').checked)return;
 const store=rememberedStore();if(!store)return;
 for(const kind of ['rom','bios'])if(picked[kind])await store.remember(kind,picked[kind].sha1,picked[kind].bytes).catch(e=>line(`Could not remember the ${kind}: ${e.message}`,true));
};
$('forgetassets').onclick=async()=>{
 try{await rememberedStore()?.forgetAll();$('remember').checked=false;writePreference(false);line('Removed the ROM and BIOS copies stored in this browser (files already loaded stay in memory until reload)');}
 catch(e){line('Forget failed: '+e.message,true);}
};

$('start').onclick=async()=>{
 if(started||!expected||!picked.rom||!picked.bios)return;
 started=true;$('start').disabled=true;$('assetfiles').disabled=true;$('status').textContent='loading';host.stats.state='loading';
 try{
  host.preflight();
  const audioReady=host.startAudio(); // create/resume in this gesture
  if(!(await saves.acquireLock(sha))){
   blocked='game already open in another tab';host.stats.state='blocked';$('status').textContent='blocked: '+blocked;
   line('This game is already open in another tab. Close it there first, so one tab cannot overwrite the other\'s saves.',true);
   void audioReady.then(()=>host.audio?.close()).catch(()=>{});renderSaves();return;
  }
  $('reload').disabled=true;
  await audioReady;romBytes=picked.rom.bytes;
  const env={};for(const item of (q.get('env')||'').split(',')){const i=item.indexOf('=');if(i>0)env[item.slice(0,i)]=item.slice(i+1);}
  const extra=(q.get('args')||'--window').split(' ').filter(Boolean);
  const saveArgs=['--save-path',`/saves/${sha}/battery.sav`,'--state-dir',`/saves/${sha}`];
  globalThis.Module={
   // No --bios-sha1: the runtime's built-in retail BIOS hash stays the authority.
   arguments:['--rom','/data/game.gba','--bios','/data/gba_bios.bin','--rom-sha1',sha,'--strict-asset-hashes',...saveArgs,...extra],
   print:t=>line(t),printErr:t=>line(t,true),
   preRun:[()=>{Object.assign(Module.ENV,env);Module.FS.mkdir('/data');Module.FS.writeFile('/data/game.gba',picked.rom.bytes);Module.FS.writeFile('/data/gba_bios.bin',picked.bios.bytes);saves.mount(Module,sha);}],
   onRuntimeInitialized:()=>{$('status').textContent='running';host.stats.state='running';},
   onAbort:fail,
   onExit:code=>{exitCode=code;line('[exit] code='+code);host.stats.exitCode=code;stopped();
    void settleSaves().then(()=>host.shutdown()).then(()=>{$('status').textContent='exited '+code;$('reload').disabled=false;renderSaves();globalThis.GbrExit?.(code);});},
  };
  running=true;saves.running=true;renderSaves();
  for(const id of ['pause','fullscreen','audio','stop','save','load'])$(id).disabled=false;
  const script=document.createElement('script');script.src='game.js';script.onerror=()=>fail('Failed to load game.js');document.body.appendChild(script);
 }catch(e){fail(e);}
};
$('pause').onclick=()=>{host.command('Pause');$('canvas').focus();};
$('save').onclick=()=>{host.command('Save',Number($('slot').value));$('canvas').focus();};
$('load').onclick=()=>{host.command('Load',Number($('slot').value));$('canvas').focus();};
$('fullscreen').onclick=()=>host.fullscreenRequest(document.fullscreenElement?0:1);
$('audio').onclick=()=>host.resumeAudio().catch(e=>line(e,true));
$('stop').onclick=()=>host.store('quit',1);
$('reload').onclick=()=>location.reload();
$('volume').oninput=()=>host.store('volume',Number($('volume').value));
$('filter').onchange=()=>host.store('filter',Number($('filter').value));
$('export').onclick=()=>{
 for(const url of urls)URL.revokeObjectURL(url);urls=[];$('downloads').replaceChildren();
 offer('host-diagnostics.json',JSON.stringify({...host.snapshot(),saves:saves.snapshot()},null,2),'application/json');
 // Never matches /data/game.gba or /data/gba_bios.bin: diagnostics must not re-export the ROM/BIOS.
 if(globalThis.Module?.FS){const fs=Module.FS;const walk=(dir,depth=0)=>{if(depth>4)return;for(const name of fs.readdir(dir)){if(name==='.'||name==='..')continue;const path=dir.replace(/\/$/,'')+'/'+name;try{const stat=fs.stat(path);if(fs.isDir(stat.mode)){if(!['/proc','/dev'].includes(path))walk(path,depth+1);}else if(/(recomp_coverage_.*\.json|recomp_master_misses_.*\.toml\.frag|\.sav|\.sav\.bak|\.state[0-9]+|^state[0-9]+|\.ss[0-9]|\.csv|\.png)$/.test(name))offer(name,fs.readFile(path));}catch(e){line(e,true);}}};walk('/');}
};
// Visitor-side save management. Changes need a stopped game; before the first
// Start they are queued and applied once /saves is loaded, before main().
$('exportsave').onclick=()=>{try{offer(GbrSaveStore.exportName(romBytes),saves.exportBattery());}catch(e){line('Export failed: '+e.message,true);}};
async function changeSaves(action,label){
 try{const result=await action();renderSaves();if(result==='applied'&&exitCode!==null){line(label+' stored; reloading');location.reload();}}
 catch(e){line(label+' failed: '+e.message,true);renderSaves();}
}
$('importsave').onclick=()=>$('importfile').click();
$('importfile').onchange=async()=>{const file=$('importfile').files[0];$('importfile').value='';if(file)await changeSaves(async()=>saves.importBattery(new Uint8Array(await file.arrayBuffer())),'Import');};
$('restoresave').onclick=()=>changeSaves(()=>saves.restoreBackup(),'Restore');
$('deletesaves').onclick=()=>{if(confirm('Delete the battery save, its backup and all save states for this game from this browser?'))void changeSaves(()=>saves.deleteAll(),'Delete');};
function renderSaves(){
 const s=saves.snapshot();let text,bad=false;
 if(!sha)text='waiting for manifest.json',bad=true;
 else if(blocked)text='not opened ('+blocked+')',bad=true;
 else if(s.state==='unavailable')text='unavailable, saves are lost on reload: '+s.error,bad=true;
 else if(s.state==='error')text='error: '+s.error,bad=true;
 else if(s.writeError)text='error: '+s.writeError,bad=true;
 else if(saves.busy())text='saving…';
 else if(s.lastPersisted)text=`saved ${Math.max(0,Math.round((Date.now()-s.lastPersisted)/1000))}s ago`+(s.persistent===false?' (best-effort storage: export a copy)':'');
 else if(s.pending.length)text=s.pending[0]+' queued for Start';
 else text=saves.mounted?'stored in this browser':'kept in this browser';
 $('savestatus').textContent='Browser save: '+text;$('savestatus').className=bad?'err':'';
 const locked=!sha||!!blocked||running||saves.busy();
 $('exportsave').disabled=!saves.fs;$('importsave').disabled=locked;$('restoresave').disabled=locked;$('deletesaves').disabled=locked;
}
document.addEventListener('visibilitychange',()=>{if(document.hidden)saves.persist();}); // what MEMFS already holds; the runtime flushes the rest on pause
addEventListener('beforeunload',e=>{if(saves.busy()){e.preventDefault();e.returnValue='';}});
setInterval(()=>{const s=host.snapshot();$('metrics').textContent=`${s.state} · published ${s.published||0} · consumed ${s.consumed} · GL uploads ${s.uploaded} · replaced ${s.replaced||0} · audio ${s.audio} · queue overflow ${s.audioOverflow||0}`;if(exitCode===null&&!blocked&&s.state!=='idle')$('status').textContent=s.fatal?'failed: '+s.fatal:s.state;renderSaves();},250);
renderSaves();renderAssets();
if(q.get('autostart')==='1')addEventListener('load',()=>{void ready.then(()=>{if(!$('start').disabled)$('start').click();else line('autostart: the ROM and BIOS are not loaded yet',true);});});
})();
