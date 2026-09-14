/* Visitor-supplied ROM and BIOS. The bundle never contains them (LEGAL.md): the
   page reads the visitor's own files, checks their SHA-1 against manifest.json
   "assets" and hands the bytes to the runtime in memory. Nothing is uploaded.
   Optionally a verified copy is kept in this browser's IndexedDB. No DOM here, so
   tests/web/asset_store_unit_test.js runs it under Node. */
(function(root) {
'use strict';
const BIOS_SIZE=0x4000;
const hex=buffer=>Array.from(new Uint8Array(buffer),b=>b.toString(16).padStart(2,'0')).join('');
async function sha1Hex(bytes) {
  const subtle=root.crypto?.subtle;
  if(!subtle)throw Error('Web Crypto is unavailable: open this page over https or on localhost');
  return hex(await subtle.digest('SHA-1',bytes));
}
function headerComplement(b){let sum=0;for(let i=0xA0;i<0xBD;++i)sum+=b[i];return (-(sum+0x19))&0xFF;}
function looksLikeRom(b){return b.length>=0xC0&&b[0xB2]===0x96&&b[0xBD]===headerComplement(b);}
function romInfo(b) {
  if(!looksLikeRom(b))return null;
  const text=(from,to)=>String.fromCharCode(...b.subarray(from,to)).replace(/[^\x20-\x7E]/g,'').trim();
  return {title:text(0xA0,0xAC),code:text(0xAC,0xB0)};
}
// The hash decides; the header only makes the rejection message useful.
async function inspect(input,expected) {
  const bytes=input instanceof Uint8Array?input:new Uint8Array(input),size=bytes.length;
  const sha1=await sha1Hex(bytes);
  if(sha1===expected.rom_sha1)return {kind:'rom',ok:true,sha1,size,info:romInfo(bytes),reason:''};
  if(sha1===expected.bios_sha1)return {kind:'bios',ok:true,sha1,size,info:null,reason:''};
  const info=romInfo(bytes);
  if(info)return {kind:'rom',ok:false,sha1,size,info,
    reason:`ROM "${info.title}" (${info.code}) has SHA-1 ${sha1}; this build needs ${expected.rom_sha1} (${expected.game_name}). Use your own dump of that exact cartridge revision.`};
  if(size===BIOS_SIZE)return {kind:'bios',ok:false,sha1,size,info:null,
    reason:`BIOS SHA-1 ${sha1} is not the retail Game Boy Advance BIOS (${expected.bios_sha1}).`};
  return {kind:'unknown',ok:false,sha1,size,info:null,
    reason:`not a GBA ROM or a 16 KB GBA BIOS (${size} bytes).`};
}
class AssetStore {
  constructor(backend){this.backend=backend;}
  static key(kind,sha1){return `${kind}:${sha1}`;}
  async remember(kind,sha1,bytes){await this.backend.put(AssetStore.key(kind,sha1),{kind,sha1,bytes:new Uint8Array(bytes),stored:Date.now()});}
  async recall(kind,sha1) {
    const key=AssetStore.key(kind,sha1),record=await this.backend.get(key);
    if(!record)return null;
    if(await sha1Hex(record.bytes)!==sha1){await this.backend.delete(key);return null;}
    return record.bytes;
  }
  async forgetAll(){for(const key of await this.backend.keys())await this.backend.delete(key);}
  list(){return this.backend.keys();}
}
function memoryBackend() {
  const map=new Map();
  return {get:async k=>map.get(k),put:async(k,v)=>{map.set(k,v);},delete:async k=>{map.delete(k);},keys:async()=>[...map.keys()]};
}
function indexedDBBackend(idb=root.indexedDB,name='gbarecomp-assets') {
  if(!idb)throw Error('IndexedDB is unavailable in this browser');
  let opened=null;
  const open=()=>opened||(opened=new Promise((resolve,reject)=>{
    const req=idb.open(name,1);
    req.onupgradeneeded=()=>req.result.createObjectStore('files');
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
    req.onblocked=()=>reject(Error('IndexedDB upgrade blocked by another tab'));
  }));
  const run=(mode,fn)=>open().then(db=>new Promise((resolve,reject)=>{
    const tx=db.transaction('files',mode),req=fn(tx.objectStore('files'));
    tx.oncomplete=()=>resolve(req.result);
    tx.onerror=tx.onabort=()=>reject(tx.error||Error('IndexedDB transaction aborted'));
  }));
  return {get:k=>run('readonly',s=>s.get(k)),put:(k,v)=>run('readwrite',s=>s.put(v,k)),
    delete:k=>run('readwrite',s=>s.delete(k)),keys:()=>run('readonly',s=>s.getAllKeys())};
}
const api={BIOS_SIZE,sha1Hex,headerComplement,looksLikeRom,romInfo,inspect,AssetStore,memoryBackend,indexedDBBackend};
root.GbrAssets=api;
if(typeof module!=='undefined')module.exports=api;
})(globalThis);
