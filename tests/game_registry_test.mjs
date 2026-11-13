import test from 'node:test';
import assert from 'node:assert/strict';
import {WarcraftHost} from '../web/runtime/host.mjs';
import {REGISTRY_FILE,restoreRegistry,saveSnapshot} from '../web/runtime/persistence.mjs';

const ROOT=0x80000001,PATH='Software\\Blizzard Entertainment\\Warcraft III\\String';
function fixture(options={}){
  const h=new WarcraftHost({memory:new WebAssembly.Memory({initial:8}),...options});
  h.base=0;let next=0x10000;h.exports={wc3_guest_alloc:n=>{const p=next;next+=n;return p;}};
  const call=(name,...args)=>h.handlers.get('advapi32.dll!'+name).fn(args);
  const key=h.alloc(4),size=h.alloc(4),type=h.alloc(4),out=h.alloc(2048);
  function open(path=PATH){assert.equal(call('RegOpenKeyExA',ROOT,h.string(path),0,0,key),0);return h.u32(key);}
  function set(name,value,key=open()){
    const data=h.string(value);assert.equal(call('RegSetValueExA',key,h.string(name),0,1,data,value.length+1),0);
  }
  function get(name,key=open()){
    h.w32(size,2048);const status=call('RegQueryValueExA',key,h.string(name),0,type,out,size);
    return status===0?h.cstr(out):status;
  }
  return {h,call,key,open,set,get};
}

test('registry paths with repeated separators refer to the same key',()=>{
  const f=fixture();
  f.set('userlocal','LAN Player',f.open('Software\\\\Blizzard Entertainment\\\\Warcraft III\\\\String\\'));
  assert.equal(f.get('USERLOCAL'),'LAN Player');
});

test('LAN name and game settings survive a new host through the save overlay',()=>{
  const first=fixture();
  first.set('userlocal','SavedName');first.set('campaignprofile','MyProfile');
  const changes=saveSnapshot(first.h);
  assert.equal(changes.files.length,1);assert.equal(changes.files[0].path,REGISTRY_FILE);
  const next=fixture({graphicsSettings:{gamma:75},resolution:{width:1280,height:960}});
  for(const file of changes.files)next.h.virtualFiles.set(file.path,file.data);
  restoreRegistry(next.h);next.h.virtualFiles.checkpoint();
  assert.equal(next.get('userlocal'),'SavedName');
  assert.equal(next.get('campaignprofile'),'MyProfile');
  assert.deepEqual(saveSnapshot(next.h),{files:[],deleted:[]},'Reading restored settings creates no extra writes');
  next.set('userlocal','ChangedName');
  const changed=saveSnapshot(next.h,{full:true});
  assert.match(new TextDecoder().decode(changed.files[0].data),/ChangedName/);
  assert.doesNotMatch(new TextDecoder().decode(changes.files[0].data),/ChangedName/,'Previous snapshots are immutable');
});

test('deleted values stay deleted and launcher/bootstrap values are not restored',()=>{
  const first=fixture();first.set('userlocal','RemoveMe');saveSnapshot(first.h);
  assert.equal(first.call('RegDeleteValueA',first.open(),first.h.string('userlocal')),0);
  first.set('installpath','C:\\Other Game',first.open('Software\\Blizzard Entertainment\\Warcraft III'));
  const saved=saveSnapshot(first.h).files[0].data;
  assert.doesNotMatch(new TextDecoder().decode(saved),/Other Game|RemoveMe/);
  const next=fixture();next.h.virtualFiles.set(REGISTRY_FILE,saved);restoreRegistry(next.h);
  assert.equal(next.get('userlocal'),2);
  assert.equal(next.get('installpath',next.open('Software\\Blizzard Entertainment\\Warcraft III')),'C:\\Warcraft III');
});

test('Unicode registry strings survive settings snapshots',()=>{
  const first=fixture(),text='Игрок❄';
  const wide=(h,s)=>{const p=h.alloc((s.length+1)*2);for(let i=0;i<=s.length;i++)h.w16(p+i*2,s.charCodeAt(i)||0);return p;};
  assert.equal(first.call('RegSetValueExW',first.open(),wide(first.h,'userlocal'),0,1,wide(first.h,text),(text.length+1)*2),0);
  const next=fixture();next.h.virtualFiles.set(REGISTRY_FILE,saveSnapshot(first.h).files[0].data);restoreRegistry(next.h);
  const size=next.h.alloc(4),out=next.h.alloc(128);next.h.w32(size,128);
  assert.equal(next.call('RegQueryValueExW',next.open(),wide(next.h,'userlocal'),0,0,out,size),0);
  assert.equal(next.h.wide(out),text);
});

test('bad snapshots cannot partially restore settings or write other registry trees',()=>{
  const f=fixture();f.set('userlocal','Original');
  const value={type:1,string:'Modified',data:[77,0]};
  const state={format:'w3ft-registry-v1',keys:[['user\\software\\blizzard entertainment\\warcraft iii',[['userlocal',value]]],['user\\software\\other vendor',[]]]};
  assert.equal(f.h.registry.restore(new TextEncoder().encode(JSON.stringify(state))),false);
  assert.equal(f.get('userlocal'),'Original');
  for(const data of [new Uint8Array(300000),new TextEncoder().encode('{bad json}')])assert.equal(f.h.registry.restore(data),false);
});
