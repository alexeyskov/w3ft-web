#!/usr/bin/env node
// Stress Warcraft 1.26a's original RW lock over the real shared WASM module.
// Requires a locally prepared, hash-verified game/runtime; includes no game
// code or assets. Does not start a server, the GUI or a network connection.
// node tests/runtime_lock_stress.mjs --workers 4 --iterations 1000000 --compat
import assert from 'node:assert/strict';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {Worker,isMainThread,parentPort,workerData} from 'node:worker_threads';
import {createRuntime} from '../web/runtime/engine.mjs';
import {WarcraftHost} from '../web/runtime/host.mjs';
import {GuestThreadScheduler} from '../web/runtime/thread-scheduler.mjs';
import {GuestCallProxy,serializeGuestError} from '../web/runtime/thread-rpc.mjs';
import {localImportDispatcher} from '../web/runtime/worker-fast.mjs';

if(!isMainThread){
  parentPort.once('message',async({options:o})=>{
    let outcome;
    try{
      const host=new WarcraftHost({memory:o.memory});
      const rpc=new GuestCallProxy({post:m=>parentPort.postMessage(m),doorbell:o.doorbell,timeout:120000});
      const imports=host.imports();let local;
      imports.wc3.wc3_host_call=(id,cpu)=>{if(!local?.(id,cpu))rpc.call(id,cpu);};
      const instance=await WebAssembly.instantiate(o.module,imports),x=instance.exports;
      x.__stack_pointer.value=o.nativeStackTop;x.__wasm_init_tls(o.tlsBase);
      host.instance=instance;host.exports=x;host.base=o.guestBase;host.permissionsBase=o.permissionsBase;
      host.capacity=x.wc3_memory_capacity();host.registerContext(o.cpu,o.threadId,o.threadState);
      local=localImportDispatcher(host,o.localImports,o.cpu);
      const progress=new Int32Array(workerData.progress),guard=new Int32Array(workerData.guard),lock=workerData.lock;
      for(let i=0;i<workerData.iterations;i++){
        const write=i%16===0?1:0;
        host.view.setUint32(o.argPointer,write,true);host.view.setUint32(o.cpu+4,lock,true);
        Atomics.store(progress,o.threadId*2,1);
        x.wc3_call_context(o.cpu,0x026d9820,1,o.argPointer);
        Atomics.store(progress,o.threadId*2,2);
        if(write){
          assert.equal(Atomics.compareExchange(guard,0,0,-1),0,'writer excludes readers and other writers');
          host.w32(lock+16,host.u32(lock+16)+1);
          assert.equal(Atomics.exchange(guard,0,0),-1);
        }else{
          assert.ok(Atomics.add(guard,0,1)>=0,'reader excludes a writer');
          const before=host.u32(lock+16),until=performance.now()+0.01;
          while(performance.now()<until){}
          assert.equal(host.u32(lock+16),before,'protected value stays stable for a reader');
          assert.ok(Atomics.sub(guard,0,1)>0);
        }
        host.view.setUint32(o.cpu+4,lock,true);Atomics.store(progress,o.threadId*2,3);
        x.wc3_call_context(o.cpu,0x026d8950,1,o.argPointer);
        Atomics.store(progress,o.threadId*2+1,i+1);
      }
      outcome={type:'thread-exit',threadId:o.threadId,code:0};
    }catch(error){outcome={type:'thread-fault',threadId:o.threadId,error:serializeGuestError(error)};}
    // Scheduler may reclaim the shared CPU/stack after this message.
    parentPort.postMessage(outcome);
  });
}else{
  const option=(name,fallback)=>{const i=process.argv.indexOf(name);return i<0?fallback:process.argv[i+1];};
  const workers=Number(option('--workers',2)),iterations=Number(option('--iterations',1000000));
  assert.ok(Number.isInteger(workers)&&workers>=2&&workers<=8);
  assert.ok(Number.isInteger(iterations)&&iterations>=16&&iterations<=100000000);
  const compat=process.argv.includes('--compat'),root=new URL('../',import.meta.url);
  const read=p=>readFileSync(new URL(p,root));
  const profile=JSON.parse(read(`var/runtime/build${compat?'-compat':''}.json`));
  assert.equal(Number(profile.modules.find(m=>m.image.toLowerCase()==='game.dll').image_base),0x02000000);
  const engine=await createRuntime({wasm:read(`var/runtime/${profile.artifact}`),profile,
    images:['war3.exe','Storm.dll','ijl15.dll','game.dll'].map(name=>({name,bytes:read('var/game/'+name)}))});
  const h=engine.host;
  h.call(0x026d7ef0); // Original event-pool initialization, before any worker.
  const lock=h.alloc(32);h.w32(lock,1);
  const progress=new SharedArrayBuffer(32*4),guard=new SharedArrayBuffer(4);
  const scheduler=new GuestThreadScheduler(engine,{budget:0,batchGraphics:false,
    workerFactory:()=>new Worker(new URL(import.meta.url),{workerData:{lock,iterations,progress,guard}})});
  const started=performance.now(),result={passed:false,variant:compat?'compat':'standard',workers,iterations};
  let failure,timer,items=[];
  scheduler.reject=error=>{failure=error;};
  try{
    items=Array.from({length:workers},()=>scheduler.create(0x026d9820,0,4));
    const state=new Int32Array(progress),previous=new Map(),lastProgress=new Map();
    for(const item of items){lastProgress.set(item.id,started);scheduler.resume(item);}
    await new Promise((resolve,reject)=>{
      timer=setInterval(()=>{
        if(failure){reject(failure);return;}
        if(items.every(t=>t.state==='exited')){resolve();return;}
        for(const item of items){
          if(item.state==='exited')continue;
          const n=Atomics.load(state,item.id*2+1),now=performance.now();
          if(n!==previous.get(item.id)){previous.set(item.id,n);lastProgress.set(item.id,now);}
          if(now-lastProgress.get(item.id)>10000){reject(Error(`Thread ${item.id} made no progress for 10 seconds`));return;}
        }
      },250);
    });
    assert.equal(h.u32(lock),1);assert.equal(h.u32(lock+4),0);assert.equal(h.u32(lock+8),0);
    assert.equal(h.u32(lock+16),workers*Math.ceil(iterations/16));
    assert.equal(Atomics.load(new Int32Array(guard),0),0);
    assert.equal(h.threadServices.waiters.length,0);
    result.passed=true;result.acquisitions=workers*iterations;
  }catch(error){
    result.error=String(error.stack||error);result.threads=scheduler.report();
    result.lock=Array.from({length:5},(_,i)=>h.u32(lock+4*i));process.exitCode=1;
  }finally{
    clearInterval(timer);scheduler.stop();result.seconds=(performance.now()-started)/1000;
    const output=option('--output',null);
    if(output){mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(result,null,2)+'\n');}
    console.log(JSON.stringify(result));
  }
}
