'use strict';
const assert=require('node:assert/strict');
const nodeCrypto=require('node:crypto');
const A=require('../../packaging/web/asset_store.js');
const sha=b=>nodeCrypto.createHash('sha1').update(b).digest('hex');
// Synthetic header: no Nintendo logo, only the fields the checks read.
function fakeRom(size=0x200,title='TESTTITLE',code='ZZZE'){
  const b=new Uint8Array(size);b.set([0x2E,0,0,0xEA],0);
  b.set(Buffer.from(title.padEnd(12,'\0'),'latin1'),0xA0);b.set(Buffer.from(code,'latin1'),0xAC);
  b[0xB2]=0x96;b[0xBD]=A.headerComplement(b);return b;
}
(async()=>{
  const rom=fakeRom(),bios=new Uint8Array(A.BIOS_SIZE).fill(7);
  const expected={rom_sha1:sha(rom),bios_sha1:sha(bios),game_name:'Test Game'};
  assert.equal(await A.sha1Hex(rom),sha(rom));
  assert(A.looksLikeRom(rom));
  const broken=rom.slice();broken[0xBD]^=1;assert(!A.looksLikeRom(broken));
  // Accepted by hash, whatever the file was called.
  let r=await A.inspect(rom,expected);
  assert.deepEqual([r.kind,r.ok,r.info.title,r.info.code],['rom',true,'TESTTITLE','ZZZE']);
  r=await A.inspect(bios,expected);assert.deepEqual([r.kind,r.ok],['bios',true]);
  // Rejections explain what was expected.
  r=await A.inspect(fakeRom(0x200,'OTHER','YYYE'),expected);
  assert.deepEqual([r.kind,r.ok],['rom',false]);assert.match(r.reason,/OTHER/);assert.match(r.reason,new RegExp(expected.rom_sha1));assert.match(r.reason,/Test Game/);
  r=await A.inspect(new Uint8Array(A.BIOS_SIZE),expected);assert.deepEqual([r.kind,r.ok],['bios',false]);assert.match(r.reason,new RegExp(expected.bios_sha1));
  r=await A.inspect(new Uint8Array(10),expected);assert.deepEqual([r.kind,r.ok],['unknown',false]);assert.match(r.reason,/10 bytes/);
  // Store: recall re-verifies; a corrupted record is dropped, never returned.
  const backend=A.memoryBackend(),store=new A.AssetStore(backend);
  await store.remember('rom',expected.rom_sha1,rom);
  assert.deepEqual(await store.recall('rom',expected.rom_sha1),rom);
  (await backend.get(A.AssetStore.key('rom',expected.rom_sha1))).bytes[0]^=1;
  assert.equal(await store.recall('rom',expected.rom_sha1),null);
  assert.deepEqual(await store.list(),[]);
  // remember() stores a copy: later changes to the caller's buffer do not leak in.
  const src=fakeRom(),h=sha(src);await store.remember('rom',h,src);src[1]=0x55;
  assert.deepEqual(await store.recall('rom',h),fakeRom());
  await store.remember('bios',expected.bios_sha1,bios);await store.forgetAll();
  assert.deepEqual(await store.list(),[]);
  console.log('web asset store PASS (hash gate, rejection reasons, verified recall, forget)');
})().catch(e=>{console.error(e);process.exit(1);});
