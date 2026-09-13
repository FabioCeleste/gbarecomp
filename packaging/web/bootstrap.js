'use strict';
(()=>{
const $=id=>document.getElementById(id),q=new URLSearchParams(location.search);
let started=false,exitCode=null,urls=[];
function line(text,error=false){text=String(text).slice(0,2000);(error?console.error:console.log)(text);const el=document.createElement('div');el.textContent=text;if(error)el.className='err';$('log').appendChild(el);while($('log').children.length>4000)$('log').firstChild.remove();}
const host=globalThis.GbrHost=new GbrWebHost($('canvas'),t=>line(t));
function fail(e){host.fail(e);$('status').textContent='failed: '+e;line(e,true);void host.shutdown();}
addEventListener('error',e=>line(e.message,true));addEventListener('unhandledrejection',e=>line(e.reason,true));
$('start').onclick=async()=>{
 if(started)return;started=true;$('start').disabled=true;$('status').textContent='loading';host.stats.state='loading';
 try{
  host.preflight();
  const audioReady=host.startAudio(); // create/resume in this gesture, before fetch
  const rom=q.get('rom')||'game.gba',bios=q.get('bios')||'gba_bios.bin';
  const assets=await Promise.all([rom,bios].map(async name=>{const r=await fetch(name);if(!r.ok)throw Error(`${name}: HTTP ${r.status}`);return new Uint8Array(await r.arrayBuffer());}));
  await audioReady;
  const env={};for(const item of (q.get('env')||'').split(',')){const i=item.indexOf('=');if(i>0)env[item.slice(0,i)]=item.slice(i+1);}
  const sha=q.get('sha1')||globalThis.GBARECOMP_ROM_SHA1||'';
  const extra=(q.get('args')||'--window').split(' ').filter(Boolean);
  globalThis.Module={
   arguments:['--rom','/data/game.gba','--bios','/data/gba_bios.bin',...(sha?['--rom-sha1',sha]:[]),...extra],
   print:t=>line(t),printErr:t=>line(t,true),
   preRun:[()=>{Object.assign(Module.ENV,env);Module.FS.mkdir('/data');Module.FS.writeFile('/data/game.gba',assets[0]);Module.FS.writeFile('/data/gba_bios.bin',assets[1]);}],
   onRuntimeInitialized:()=>{$('status').textContent='running';host.stats.state='running';},
   onAbort:fail,
   onExit:code=>{exitCode=code;line('[exit] code='+code);host.stats.exitCode=code;void host.shutdown().then(()=>{$('status').textContent='exited '+code;globalThis.GbrExit?.(code);});},
  };
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
 const offer=(name,data,type='application/octet-stream')=>{const url=URL.createObjectURL(new Blob([data],{type}));urls.push(url);const a=document.createElement('a');a.href=url;a.download=name;a.textContent=name;a.style.marginRight='12px';$('downloads').appendChild(a);};
 offer('host-diagnostics.json',JSON.stringify(host.snapshot(),null,2),'application/json');
 if(globalThis.Module?.FS){const fs=Module.FS;const walk=(dir,depth=0)=>{if(depth>4)return;for(const name of fs.readdir(dir)){if(name==='.'||name==='..')continue;const path=dir.replace(/\/$/,'')+'/'+name;try{const stat=fs.stat(path);if(fs.isDir(stat.mode)){if(!['/proc','/dev'].includes(path))walk(path,depth+1);}else if(/(recomp_coverage_.*\.json|recomp_master_misses_.*\.toml\.frag|\.sav|\.state[0-9]+|\.ss[0-9]|\.csv|\.png)$/.test(name))offer(name,fs.readFile(path));}catch(e){line(e,true);}}};walk('/');}
};
setInterval(()=>{const s=host.snapshot();$('metrics').textContent=`${s.state} · published ${s.published||0} · consumed ${s.consumed} · GL uploads ${s.uploaded} · replaced ${s.replaced||0} · audio ${s.audio} · queue overflow ${s.audioOverflow||0}`;if(exitCode===null&&s.state!=='idle')$('status').textContent=s.fatal?'failed: '+s.fatal:s.state;},250);
if(q.get('autostart')==='1')addEventListener('load',()=>$('start').click());
})();
