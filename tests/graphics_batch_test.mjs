import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {WarcraftHost} from '../web/runtime/host.mjs';
import {GraphicsBatchRegistry,GraphicsCommandQueue} from '../web/runtime/graphics-batch.mjs';
import {floatAttributes} from '../web/runtime/graphics.mjs';

const CPU=0x1000,ESP=0x10000,owner={cpu:CPU,id:1};
function fixture(graphics={}){
  const h=new WarcraftHost({memory:new WebAssembly.Memory({initial:160,maximum:160,shared:true}),graphics});
  h.base=0;h.exports={wc3_guest_alloc:()=>0x30000};h.registerContext(CPU,1);
  const registry=h.graphicsBatchRegistry=new GraphicsBatchRegistry(h),posted=[];
  const queue=new GraphicsCommandQueue(h,registry.buffer,{post:message=>posted.push(message)});
  const id=(name,dll='opengl32.dll')=>(h.resolve(dll,name)-0xf1000000)/16;
  const stack=(args,ret=0x401234)=>{h.view.setUint32(CPU+16,ESP,true);h.w32(ESP,ret);args.forEach((v,i)=>h.w32(ESP+4+i*4,v));};
  const call=(name,args,ret)=>{stack(args,ret);return queue.enqueue(id(name),CPU);};
  // What the worker hands over at a swap or synchronous import.
  const flush=()=>{queue.submit();for(const message of posted.splice(0))registry.submit(owner,message);registry.drain();};
  return {h,registry,queue,posted,id,stack,call,flush};
}
const f32=value=>new Uint32Array(Float32Array.of(value).buffer)[0];

test('GL state is deferred with call-time vector data and stdcall returns',()=>{
  const seen=[],{h,registry,id,stack,call,flush,queue}=fixture({loadMatrix:m=>seen.push([...m]),activeTexture:u=>seen.push(u)});
  for(let i=0;i<16;i++)h.view.setFloat32(0x20000+i*4,i+0.25,true);
  assert.equal(call('glLoadMatrixf',[0x20000]),true);
  h.zero(0x20000,64);
  assert.equal(call('glActiveTextureARB',[0x84c1],0x402000),true);
  assert.equal(h.view.getUint32(CPU,true),0);assert.equal(h.view.getUint32(CPU+16,true),ESP+8);assert.equal(h.view.getUint32(CPU+32,true),0x402000);
  assert.deepEqual(seen,[]);flush();
  assert.deepEqual(seen,[Array.from({length:16},(_,i)=>i+0.25),0x84c1]);
  assert.equal(registry.commands,2);assert.equal(registry.batches,1);assert.equal(h.calls.get('opengl32.dll!glLoadMatrixf'),1);
  // Queries, object creation and context management stay synchronous.
  for(const name of ['glGetIntegerv','glGetError','glGenTextures','wglMakeCurrent','wglCreateContext']){stack([0,0]);assert.equal(queue.enqueue(id(name),CPU),false,name);}
  assert.equal(queue.enqueue(id('SwapBuffers','gdi32.dll'),CPU),true,'gdi32 SwapBuffers is a deferred swap');
  assert.equal(h.view.getUint32(CPU,true),1,'SwapBuffers returns TRUE');
});

test('draws capture interleaved client arrays and rebased indices at call time',()=>{
  const drawn=[],{h,call,flush}=fixture({drawElements:(mode,indices,attributes,vertexCount)=>drawn.push({mode,indices:[...indices],vertexCount,attributes,decoded:floatAttributes(attributes,vertexCount)}),drawArrays:(...a)=>drawn.push(a)});
  const base=0x8000,stride=16;
  for(let v=0;v<6;v++){[v,v+.5,-v].forEach((x,c)=>h.view.setFloat32(base+v*stride+c*4,x,true));h.copyIn(base+v*stride+12,Uint8Array.of(v*40,255,0,128));}
  call('glVertexPointer',[3,0x1406,stride,base]);call('glColorPointer',[4,0x1401,stride,base+12]);
  call('glEnableClientState',[0x8074]);call('glEnableClientState',[0x8076]);
  [5,3,4].forEach((v,i)=>h.w16(0x9000+i*2,v));
  assert.equal(call('glDrawElements',[4,3,0x1403,0x9000]),true);
  h.zero(base,6*stride);h.zero(0x9000,6);
  flush();
  assert.equal(drawn.length,1);const [draw]=drawn;
  assert.deepEqual(draw.indices,[2,0,1]);assert.equal(draw.vertexCount,3);
  assert.equal(draw.attributes.raw.position.bytes,draw.attributes.raw.color.bytes,'interleaved arrays share one upload');
  assert.deepEqual([...draw.decoded.positions],[3,3.5,-3,4,4.5,-4,5,5.5,-5]);
  assert.ok(Math.abs(draw.decoded.colors[0]-120/255)<1e-6);assert.ok(Math.abs(draw.decoded.colors[3]-128/255)<1e-6);
  // Without an enabled vertex array the broker reports the error synchronously.
  call('glDisableClientState',[0x8074]);assert.equal(call('glDrawArrays',[4,0,3]),false);
});

test('texture uploads use the mirrored unpack state',()=>{
  const uploads=[],{h,call,flush}=fixture({texImage2D:(...a)=>uploads.push([a.slice(0,8),a[8]&&[...a[8]]]),texSubImage2D:(...a)=>uploads.push([a.slice(0,8),[...a[8]]]),pixelStorei:()=>{}});
  const pixels=Uint8Array.from({length:18},(_,i)=>i+1);h.copyIn(0xa000,pixels);
  call('glPixelStorei',[0x0cf5,1]);
  assert.equal(call('glTexImage2D',[0xde1,0,0x1907,3,2,0,0x1907,0x1401,0xa000]),true);
  assert.equal(call('glTexImage2D',[0xde1,1,0x1907,1,1,0,0x1907,0x1401,0]),true,'null pixels allocate storage');
  assert.equal(call('glTexSubImage2D',[0xde1,0,0,0,1,1,0x1907,0x1401,0]),false,'null sub-image pixels are a broker error');
  h.zero(0xa000,18);flush();
  assert.deepEqual(uploads[0],[[0xde1,0,0x1907,3,2,0,0x1907,0x1401],[...pixels]]);
  assert.deepEqual(uploads[1],[[0xde1,1,0x1907,1,1,0,0x1907,0x1401],null]);
});

test('synchronous imports carry pending records; graphics handlers execute them first',()=>{
  const seen=[],{h,registry,queue,id,stack,call}=fixture({enable:c=>seen.push(['enable',c]),isEnabled:c=>{seen.push(['query',c]);return true;}});
  call('glEnable',[0x0be2]);
  const pending=queue.syncPoint();assert.ok(pending&&pending.stream,'first segment announces the stream');
  registry.submit(owner,pending);assert.equal(registry.queue.length,1);
  // A non-graphics import neither waits for nor runs queued GL work.
  stack([]);h.invoke(id('GetCurrentThreadId','kernel32.dll'),CPU);assert.deepEqual(seen,[]);
  stack([0x0be2]);h.invoke(id('glIsEnabled'),CPU);
  assert.deepEqual(seen,[['enable',0x0be2],['query',0x0be2]]);assert.equal(h.view.getUint32(CPU,true),1);
  assert.equal(queue.syncPoint(),undefined,'nothing pending');
  call('glEnable',[0x0b71]);const next=queue.syncPoint();assert.equal(next.stream,undefined,'stream is announced once');
  registry.submit(owner,next);registry.drain();assert.deepEqual(seen.at(-1),['enable',0x0b71]);
});

test('invalid segments have no partial effects; GL errors keep the call site',()=>{
  let calls=0;const{registry,queue,posted,call}=fixture({loadIdentity:()=>calls++,enable:()=>{throw Error('bad capability');}});
  call('glLoadIdentity',[]);call('glLoadIdentity',[]);queue.submit();
  const [segment]=posted.splice(0),words=new Uint32Array(segment.stream),record=(64+segment.start)/4+4;
  words[record+1]=0xfffe;
  assert.throws(()=>registry.submit(owner,segment),/opcode/);assert.equal(calls,0);
  assert.equal(Atomics.load(new Int32Array(segment.stream,0,16),2),1,'only the writer still uses the chunk');
  call('glEnable',[123],0x401998);queue.submit();registry.submit(owner,posted.pop());
  assert.throws(()=>registry.drain(),error=>error.message==='bad capability'&&error.details.returnAddress===0x401998&&error.details.import==='opengl32.dll!glEnable');
  assert.equal(registry.queue.length,0);
});

test('records larger than a command chunk fall back to a synchronous import',()=>{
  const {h,call}=fixture({});
  call('glPixelStorei',[0x0cf5,1]);
  assert.equal(call('glTexImage2D',[0xde1,0,0x1908,1024,1025,0,0x1908,0x1401,0x100000]),false);
  assert.equal(h.view.getUint32(CPU+16,true),ESP,'stack untouched for the synchronous path');
});

test('a worker stays at most one frame ahead of the broker',async t=>{
  const order=[],graphics={enable:c=>order.push(c),swapBuffers:()=>{order.push('swap');return {};}};
  const {h,registry,id}=fixture(graphics);
  const ids={enable:id('glEnable'),swap:id('wglSwapLayerBuffers')};
  const worker=new Worker(`
    const {parentPort,workerData:d}=require('node:worker_threads');
    (async()=>{
      const {WarcraftHost}=await import(d.hostURL),{GraphicsCommandQueue}=await import(d.batchURL);
      const h=new WarcraftHost({memory:d.memory});h.base=0;
      const queue=new GraphicsCommandQueue(h,d.registry,{post:m=>parentPort.postMessage(m),framesInFlight:1});
      const call=(id,args)=>{h.view.setUint32(0x2010,0x18000,true);h.w32(0x18000,0x401000);args.forEach((v,i)=>h.w32(0x18004+i*4,v));if(!queue.enqueue(id,0x2000))throw Error('not deferred');};
      for(let frame=1;frame<=4;frame++){
        call(d.ids.enable,[frame]);call(d.ids.swap,[1,1]);
        parentPort.postMessage({type:'swapped',frame,completed:Atomics.load(queue.control,1)});
      }
    })().catch(e=>parentPort.postMessage({type:'failure',message:e.stack}));
  `,{eval:true,workerData:{memory:h.memory,registry:registry.buffer,ids,
    hostURL:new URL('../web/runtime/host.mjs',import.meta.url).href,batchURL:new URL('../web/runtime/graphics-batch.mjs',import.meta.url).href}});
  t.after(()=>worker.terminate());
  const thread={cpu:0x2000,id:2}; // persistent, like a scheduler thread item
  const swaps=await new Promise((resolve,reject)=>{
    const result=[];worker.on('error',reject);
    worker.on('message',message=>{
      if(message.type==='failure')reject(Error(message.message));
      else if(message.type==='gl-chunk')registry.submit(thread,message);
      else if(message.type==='swapped'){result.push(message);if(result.length===4)resolve(result);}
    });
  });
  for(const {frame,completed} of swaps)assert.ok(completed>=frame-1,`frame ${frame} ran ahead of the broker (${completed} completed)`);
  registry.drain();
  assert.deepEqual(order,[1,'swap',2,'swap',3,'swap',4,'swap']);
});

test('the frame-rate cap paces presented swaps; without a cap they present at once',async()=>{
  for(const [maxFps,minimum] of [[50,18],[0,0]]){
    const times=[],{h,id,stack}=fixture({swapBuffers:()=>{times.push(performance.now());return {};}});
    const registry=h.graphicsBatchRegistry=new GraphicsBatchRegistry(h,{maxFps});
    const queue=new GraphicsCommandQueue(h,registry.buffer,{post:message=>registry.submit(owner,message),framesInFlight:8});
    for(let frame=0;frame<4;frame++){stack([1,1]);assert.equal(queue.enqueue(id('wglSwapLayerBuffers'),CPU),true);}
    const start=performance.now();
    while(times.length<4&&performance.now()-start<2000)await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal(times.length,4);
    const gaps=times.slice(1).map((time,i)=>time-times[i]);
    if(minimum)for(const gap of gaps)assert.ok(gap>=minimum,`${maxFps} FPS cap: frames ${gaps.map(Math.round)} ms apart`);
    else assert.ok(times[3]-times[0]<15,`uncapped swaps waited ${Math.round(times[3]-times[0])} ms`);
    registry.cancel();
  }
});
