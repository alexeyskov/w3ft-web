import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {WarcraftHost} from '../web/runtime/host.mjs';
import {GraphicsBatchRegistry,GraphicsCommandQueue,GRAPHICS_NATIVE_FLUSH} from '../web/runtime/graphics-batch.mjs';

const seen=[],memory=new WebAssembly.Memory({initial:1024,maximum:65536,shared:true});
const h=new WarcraftHost({memory,graphics:{
  activeTexture:unit=>seen.push(['texture',unit]),loadMatrix:m=>seen.push(['matrix',...m]),
  lightfv:(light,parameter,values)=>seen.push(['light',light,parameter,...values]),
  enable:cap=>seen.push(['enable',cap]),isEnabled:cap=>{seen.push(['query',cap]);return true;},
  drawArrays:(...args)=>seen.push(['draw',...args]),
}});
const imports=h.imports();let x,queue,registry,flushes=0,normalCalls=0,throwFlush=false;
imports.wc3.wc3_host_call=(id,cpu)=>{
  if((id>>>0)===GRAPHICS_NATIVE_FLUSH){
    flushes++;if(throwFlush)throw Error('synthetic flush failure');
    queue.appendNative(x.wc3_graphics_pointer()>>>0,x.wc3_graphics_bytes());return;
  }
  normalCalls++;
  if(!queue.enqueue(id,cpu)){registry.submit(owner,queue.syncPoint());registry.drain();h.invoke(id,cpu);}
};
const {instance}=await WebAssembly.instantiate(await readFile(process.argv[2]),imports);x=instance.exports;
h.instance=instance;h.exports=x;x._initialize();assert.equal(x.wc3_init(0x7fff0000),1);h.attach(instance);
const cpu=x.wc3_cpu_pointer(),owner={cpu,id:1},stack=h.view.getUint32(cpu+16,true),returned=0x123abc;
registry=h.graphicsBatchRegistry=new GraphicsBatchRegistry(h);
queue=new GraphicsCommandQueue(h,registry.buffer,{post:message=>registry.submit(owner,message)});
function invoke(name,args=[],dll='opengl32.dll'){
  const id=(h.resolve(dll,name)-0xf1000000)/16;
  h.view.setUint32(cpu+16,stack,true);h.w32(stack,returned);args.forEach((v,i)=>h.w32(stack+4+i*4,v));
  x.fixture_import(cpu,id);
  assert.equal(h.view.getUint32(cpu+32,true),returned);
  assert.equal(h.view.getUint32(cpu+16,true),stack+4+(dll==='opengl32.dll'?args.length*4:0));
  return id;
}
const flush=()=>{x.wc3_graphics_flush(cpu);queue.submit();registry.drain();};
assert.equal(x.wc3_bind_graphics_import(65536,0),0);assert.equal(x.wc3_bind_graphics_import(123,0xa5800101),0,'dynamic vector descriptor needs enough arguments');
invoke('glActiveTextureARB',[0x84c0]);assert.equal(normalCalls,1,'old/default mode retains JS path');flush();
assert.equal(x.wc3_graphics_enable(1),1);
const initialNormal=normalCalls,matrix=h.alloc(64),vector=h.alloc(16);
for(let i=0;i<16;i++)h.view.setFloat32(h.base+matrix+i*4,i+.5,true);
[.25,.5,.75,1].forEach((v,i)=>h.view.setFloat32(h.base+vector+i*4,v,true));
invoke('glLoadMatrixf',[matrix]);invoke('glLightfv',[0x4000,0x1201,vector]);
h.zero(matrix,64);h.zero(vector,16);
assert.equal(normalCalls,initialNormal,'selected GL calls never cross WASM to JS');
assert.ok(x.wc3_graphics_bytes()>0);assert.equal(x.wc3_graphics_enable(0),0,'pending work cannot silently be disabled');flush();
assert.deepEqual(seen.at(-2),['matrix',...Array.from({length:16},(_,i)=>i+.5)]);
assert.deepEqual(seen.at(-1),['light',0x4000,0x1201,.25,.5,.75,1]);
// Host query observes native records before executing, with call diagnostics.
invoke('glEnable',[0x0be2]);invoke('glIsEnabled',[0x0be2]);
assert.deepEqual(seen.slice(-2),[['enable',0x0be2],['query',0x0be2]]);
assert.equal(h.calls.get('opengl32.dll!glLoadMatrixf'),1);
assert.equal(h.history.find(item=>item.name==='opengl32.dll!glLoadMatrixf').returnAddress,returned);
// Array mirror calls stay in JS; a draw uses the current pointer and data.
invoke('glVertexPointer',[3,0x1406,0,matrix]);invoke('glEnableClientState',[0x8074]);
invoke('glDrawArrays',[4,0,3]);flush();assert.equal(seen.at(-1)[0],'draw');
const before=flushes;for(let i=0;i<2000;i++)invoke('glActiveTextureARB',[0x84c0+(i&1)]);
assert.ok(flushes>before,'bounded buffer automatically flushes');assert.ok(x.wc3_graphics_bytes()<=32768);flush();
assert.deepEqual(seen.slice(-2000),Array.from({length:2000},(_,i)=>['texture',0x84c0+(i&1)]));
invoke('glActiveTextureARB',[0x84c0]);const beforeCRT=flushes;
invoke('memset',[vector,0,16],'MSVCR80.dll');assert.equal(flushes,beforeCRT+1,'pure native CRT is an ordering boundary too');flush();
invoke('glActiveTextureARB',[0x84c1]);throwFlush=true;assert.throws(flush,/synthetic flush failure/);
throwFlush=false;x.wc3_graphics_discard();assert.equal(x.wc3_graphics_bytes(),0);
invoke('glActiveTextureARB',[0x84c0]);flush();assert.deepEqual(seen.at(-1),['texture',0x84c0]);
assert.equal(x.wc3_graphics_enable(0),1);invoke('glActiveTextureARB',[0x84c1]);flush();assert.deepEqual(seen.at(-1),['texture',0x84c1]);
registry.cancel();console.log('Native graphics staging passed',JSON.stringify({normalCalls,flushes,commands:registry.commands}));
