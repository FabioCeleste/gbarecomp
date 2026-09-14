"""Visitor-supplied ROM/BIOS: hash gate, no upload, remember/forget, runtime re-check.

  python3 packaging/web/serve.py <bundle> 18083 --dev-assets <dir with game.gba + gba_bios.bin>
  GBARECOMP_TEST_ROM=<rom> GBARECOMP_TEST_BIOS=<bios> python3 tests/web/test_assets.py <out> [--url http://127.0.0.1:18083/]

Exit 77 (skip) without the two files. They stay on this machine: Chrome reads them
from their paths, and the corrupted/fake copies live in temp dirs deleted at the end.
"""
import argparse,base64,hashlib,json,os,pathlib,sys,tempfile,time,urllib.parse
import websocket
from browser import Browser

p=argparse.ArgumentParser();p.add_argument('output');p.add_argument('--url',default='http://127.0.0.1:18083/');a=p.parse_args()
ROM,BIOS=os.environ.get('GBARECOMP_TEST_ROM',''),os.environ.get('GBARECOMP_TEST_BIOS','')
if not (ROM and BIOS and pathlib.Path(ROM).is_file() and pathlib.Path(BIOS).is_file()):
 print('SKIP: set GBARECOMP_TEST_ROM and GBARECOMP_TEST_BIOS to your own dumps');sys.exit(77)
out=pathlib.Path(a.output);out.mkdir(parents=True,exist_ok=True)
origin=urllib.parse.urlsplit(a.url)
HEADLESS=a.url+'?'+urllib.parse.urlencode({'args':'--no-window --frames 90','env':'GBARECOMP_SELFHEAL_RECOMPILE=0'})
results={}

def wait(tab,expr,timeout=60,what=None):
 end=time.monotonic()+timeout;last=None
 while time.monotonic()<end:
  try:last=tab.eval(expr)
  except RuntimeError as e:last=str(e)[:300]
  if last is True or (last and not isinstance(last,str)):return last
  time.sleep(.25)
 raise AssertionError(f'timeout waiting for {what or expr}; last={last!r}')
def text(tab,id):return tab.eval(f'document.getElementById("{id}").textContent')
def log(tab):return tab.eval('document.getElementById("log").innerText')
def start_enabled(tab):return tab.eval('!document.getElementById("start").disabled')
def loaded(tab):wait(tab,'document.readyState==="complete"&&!!globalThis.GbrAssets&&/needed|verified/.test(document.getElementById("romstatus").textContent)',30,'manifest loaded')
def open_page(tab,url=HEADLESS):tab.call('Page.navigate',{'url':url});loaded(tab)
def set_files(tab,*paths):
 root=tab.call('DOM.getDocument',{'depth':0})['root']['nodeId']
 node=tab.call('DOM.querySelector',{'nodeId':root,'selector':'#assetfiles'})['nodeId']
 tab.call('DOM.setFileInputFiles',{'nodeId':node,'files':[str(pathlib.Path(x).resolve()) for x in paths]})
def click(tab,id):
 x,y=tab.eval(f'(()=>{{const r=document.getElementById("{id}").getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2];}})()')
 for t in ['mousePressed','mouseReleased']:tab.call('Input.dispatchMouseEvent',{'type':t,'x':x,'y':y,'button':'left','clickCount':1})
def wait_event(tab,method,timeout=30):
 for i,e in enumerate(tab.events):
  if e.get('method')==method:return tab.events.pop(i)
 end=time.monotonic()+timeout;tab.ws.settimeout(1)
 try:
  while time.monotonic()<end:
   try:x=json.loads(tab.ws.recv())
   except websocket.WebSocketTimeoutException:continue
   if x.get('method')==method:return x
   tab.events.append(x)
 finally:tab.ws.settimeout(20)
 raise AssertionError(f'timeout waiting for {method}')

def a1_needs_files():
 open_page(b)
 m=b.eval('fetch("manifest.json").then(r=>r.json())')
 assert m['assets']['policy']=='visitor-supplied' and m['distribution']=='private-test',m
 assert not start_enabled(b),'Start enabled without files'
 assert m['assets']['rom_sha1'] in text(b,'romstatus') and m['assets']['bios_sha1'] in text(b,'biosstatus')
 assert b.eval('fetch("robots.txt").then(r=>r.text())').startswith('User-agent: *')

def a2_wrong_rom_rejected():
 with tempfile.TemporaryDirectory(prefix='gbr-wrong-rom-') as tmp:
  bad=pathlib.Path(tmp)/'wrong.gba';data=bytearray(pathlib.Path(ROM).read_bytes());data[0x1000]^=0xFF;bad.write_bytes(data)
  open_page(b);set_files(b,bad,BIOS)
  wait(b,'/BIOS: verified/.test(document.getElementById("biosstatus").textContent)',30,'BIOS verified')
  wait(b,'/this build needs/.test(document.getElementById("log").innerText)',30,'ROM rejection')
  assert not start_enabled(b),'Start enabled with a wrong ROM'
  assert not b.eval('performance.getEntriesByType("resource").some(e=>/game\\.(js|wasm)$/.test(new URL(e.name).pathname))'),'game code loaded for a rejected ROM'

def a3_verified_files_run_without_upload():
 b.call('Network.enable');b.events.clear()
 open_page(b);set_files(b,ROM,BIOS)
 wait(b,'!document.getElementById("start").disabled',60,'Start enabled')
 click(b,'start')
 wait(b,'document.getElementById("status").textContent.startsWith("exited")||!!GbrHost.snapshot().fatal',240,'exit')
 assert not b.eval('GbrHost.snapshot().fatal'),b.eval('GbrHost.snapshot().fatal')
 assert '[exit] code=0' in log(b),log(b)[-2000:]
 assert b.eval('!!document.querySelector("meta[http-equiv=Content-Security-Policy]")'),'CSP meta missing'
 assert 'Content-Security-Policy blocked' not in log(b),log(b)[-2000:]
 b.eval('1')  # drain queued CDP events
 sent=[e['params']['request'] for e in b.events if e.get('method')=='Network.requestWillBeSent']
 base=f'{origin.scheme}://{origin.netloc}'
 assert sent,'Network domain recorded nothing'
 for r in sent:
  assert r['method']=='GET',f"non-GET request {r['method']} {r['url']}"
  assert r['url'].startswith((base,'blob:','data:')),f"request to another origin: {r['url']}"
  assert not urllib.parse.urlsplit(r['url']).path.endswith(('.gba','.bin','.agb')),f"ROM/BIOS over the network: {r['url']}"
 b.call('Network.disable')

def a4_remember_and_forget():
 open_page(b)
 assert b.eval('(()=>{const r=document.getElementById("remember");if(!r.checked)r.click();return r.checked})()')
 set_files(b,ROM,BIOS)
 wait(b,'!document.getElementById("start").disabled',60,'Start enabled')
 wait(b,'GbrAssets.indexedDBBackend().keys().then(k=>k.length===2)',30,'two records stored')
 open_page(b)
 wait(b,'!document.getElementById("start").disabled',60,'Start enabled from IndexedDB')
 assert 'remembered in this browser' in text(b,'romstatus'),text(b,'romstatus')
 click(b,'forgetassets')
 wait(b,'GbrAssets.indexedDBBackend().keys().then(k=>k.length===0)',30,'records removed')
 open_page(b);time.sleep(1)
 assert not start_enabled(b),'Start enabled after forgetting'

def a5_dev_assets_are_loopback_only():
 b2=Browser(out/'non-loopback',autoplay=False,extra_flags=['--host-resolver-rules=MAP gbr.test 127.0.0.1'])
 try:
  url=f'http://gbr.test:{origin.port}/?'+urllib.parse.urlencode({'rom':'/dev-assets/game.gba','bios':'/dev-assets/gba_bios.bin'})
  b2.call('Page.navigate',{'url':url})
  wait(b2,'/ignored outside localhost/.test(document.getElementById("log").innerText)',30,'dev assets refused by the page')
  assert not start_enabled(b2)
  status=b2.eval('fetch("/dev-assets/game.gba").then(r=>r.status)')
  assert status==403,f'serve.py served dev assets to a non-loopback Host (HTTP {status})'
 finally:b2.close()

def a6_runtime_rejects_bios_mismatch():
 with tempfile.TemporaryDirectory(prefix='gbr-fake-bios-') as tmp:
  fake=pathlib.Path(tmp)/'not_a_bios.bin';fake.write_bytes(bytes(16384))
  b.call('Fetch.enable',{'patterns':[{'urlPattern':'*manifest.json*','requestStage':'Response'}]})
  b.call('Page.navigate',{'url':HEADLESS})
  ev=wait_event(b,'Fetch.requestPaused',30);rid=ev['params']['requestId']
  body=b.call('Fetch.getResponseBody',{'requestId':rid})
  m=json.loads(base64.b64decode(body['body']) if body.get('base64Encoded') else body['body'])
  m['assets']['bios_sha1']=hashlib.sha1(bytes(16384)).hexdigest()  # page now trusts the fake BIOS
  b.call('Fetch.fulfillRequest',{'requestId':rid,'responseCode':200,'responseHeaders':[{'name':'Content-Type','value':'application/json'}],'body':base64.b64encode(json.dumps(m).encode()).decode()})
  b.call('Fetch.disable')
  loaded(b);set_files(b,ROM,fake)
  wait(b,'!document.getElementById("start").disabled',60,'page accepted the tampered BIOS hash')
  click(b,'start')
  wait(b,'/BIOS resolution failed/.test(document.getElementById("log").innerText)',120,'runtime refused the BIOS (--strict-asset-hashes)')

b=Browser(out,autoplay=False)
try:
 for name,fn in [('A1',a1_needs_files),('A2',a2_wrong_rom_rejected),('A3',a3_verified_files_run_without_upload),
                 ('A4',a4_remember_and_forget),('A5',a5_dev_assets_are_loopback_only),('A6',a6_runtime_rejects_bios_mismatch)]:
  print(f'== {name}',flush=True)
  try:fn();results[name]='PASS'
  except BaseException as e:
   results[name]=f'FAIL: {type(e).__name__}: {e}'[:500]
   try:(out/f'{name}-console.txt').write_text(log(b))
   except Exception:pass
   break
finally:
 (out/'results.json').write_text(json.dumps(results,indent=2));print(json.dumps(results,indent=2))
 b.close()
sys.exit(0 if results and all(v=='PASS' for v in results.values()) and len(results)==6 else 1)
