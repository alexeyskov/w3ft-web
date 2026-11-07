import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker,isMainThread,parentPort,workerData} from 'node:worker_threads';
import {WarcraftHost} from '../web/runtime/host.mjs';
import {localImportDispatcher} from '../web/runtime/worker-fast.mjs';
import {TLS_CAPACITY} from '../web/runtime/thread-state.mjs';

if(!isMainThread){
  const {memory,cpu,id,threadState,tlsSlots,imports}=workerData;
  const h=new WarcraftHost({memory,tlsSlots});h.base=0;h.registerContext(cpu,id,threadState);
  const dispatch=localImportDispatcher(h,imports,cpu),esp=0x10000+id*0x100;
  parentPort.on('message',actions=>{
    try{
      const result=actions.map(([index,...args])=>{
        h.view.setUint32(cpu+16,esp,true);h.w32(esp,0x401000);args.forEach((value,i)=>h.w32(esp+4+i*4,value));
        const local=dispatch(index,cpu);
        return local?{value:h.view.getUint32(cpu,true),esp:h.view.getUint32(cpu+16,true)}:{local:false};
      });
      parentPort.postMessage({result});
    }catch(error){parentPort.postMessage({error:error.stack});}
  });
  parentPort.postMessage({ready:true});
}else{
  test('live Workers and pending broker callbacks share exact last-error/TLS state without RPC',async()=>{
    const memory=new WebAssembly.Memory({initial:4,maximum:4,shared:true}),h=new WarcraftHost({memory});h.base=0;
    const names=['GetLastError','SetLastError','TlsGetValue','TlsSetValue','TlsAlloc','TlsFree'];
    const descriptors=names.map(name=>{const {argc,convention}=h.handlers.get('kernel32.dll!'+name);return {dll:'kernel32.dll',name,argc,convention};});
    const workers=[],contexts=[];
    const command=(worker,actions)=>new Promise((resolve,reject)=>{
      worker.once('message',message=>message.error?reject(Error(message.error)):resolve(message.result));worker.postMessage(actions);
    });
    try{
      for(const id of [1,2]){
        const cpu=id*0x1000,context=h.registerContext(cpu,id),counters=new SharedArrayBuffer(descriptors.length*4);contexts.push(context);
        context.lastError=70+id;
        const worker=new Worker(new URL(import.meta.url),{workerData:{memory,cpu,id,threadState:context.buffer,tlsSlots:h.tlsSlots.buffer,imports:{descriptors,counters}}});
        worker.counters=counters;workers.push(worker);
        await new Promise((resolve,reject)=>{worker.once('message',message=>message.ready?resolve():reject(Error(JSON.stringify(message))));worker.once('error',reject);});
      }
      // Allocate after workers start: they must observe the process registry.
      h.currentCPU=0x1000;
      const slot=h.handlers.get('kernel32.dll!TlsAlloc').fn([]);
      for(let i=0;i<2;i++){
        const values=await command(workers[i],[[0],[2,slot],[3,slot,0xfeed0000+i],[1,80+i],[0],[4],[5,slot]]);
        assert.deepEqual(values.map(value=>value.value??value.local),[71+i,0,1,0,80+i,false,false]);
        assert.equal(contexts[i].lastError,80+i);assert.equal(contexts[i].tls.get(slot),0xfeed0000+i);
        assert.equal(values[2].esp,0x10000+(i+1)*0x100+12,'local TLS uses the original stdcall stack cleanup');
      }
      // An async broker API captures the same context object the worker uses.
      let resume;
      h.add('test.dll','PendingError',0,()=>{
        const context=h.threadContext;
        return new Promise(resolve=>{resume=()=>{context.lastError=1234;resolve(0);};});
      });
      const index=(h.resolve('test.dll','PendingError')-0xf1000000)/16;
      h.view.setUint32(0x1010,0x18000,true);h.w32(0x18000,0x401000);
      const pending=h.invokeAsync(index,0x1000);h.currentCPU=0x2000;
      resume();await pending;
      assert.equal((await command(workers[0],[[0]]))[0].value,1234);
      assert.equal((await command(workers[1],[[0]]))[0].value,81);
      assert.equal(h.handlers.get('kernel32.dll!TlsFree').fn([slot]),1);
      for(const worker of workers)assert.deepEqual((await command(worker,[[2,slot],[0]])).map(value=>value.value),[0,87]);
      assert.equal(h.handlers.get('kernel32.dll!TlsAlloc').fn([]),slot,'freed indices are reusable');
      for(const worker of workers)assert.deepEqual((await command(worker,[[2,slot],[0]])).map(value=>value.value),[0,0],'reuse starts with NULL and TlsGetValue clears last-error');
      assert.equal(contexts[0].tls.has(slot),false);assert.equal(contexts[1].tls.has(slot),false);
      for(const worker of workers){
        const counts=new Uint32Array(worker.counters);
        assert.equal(counts[0],5);assert.equal(counts[2],3);assert.equal(counts[3],1);
        assert.equal(counts[4],0);assert.equal(counts[5],0,'process-wide allocation/free must remain on the broker');
      }
    }finally{await Promise.all(workers.map(worker=>worker.terminate()));}
  });

  test('TLS exhaustion and reuse preserve pointers and per-thread error values',()=>{
    const h=new WarcraftHost({memory:new WebAssembly.Memory({initial:1})});h.base=0;
    const one=h.registerContext(0x1000,1),two=h.registerContext(0x2000,2);
    const call=(name,args=[])=>h.handlers.get('kernel32.dll!'+name).fn(args);
    h.currentCPU=0x1000;
    for(let i=0;i<TLS_CAPACITY;i++)assert.equal(call('TlsAlloc'),i);
    assert.equal(call('TlsAlloc'),0xffffffff);assert.equal(one.lastError,8);assert.equal(two.lastError,0);
    const slot=TLS_CAPACITY-1;call('TlsSetValue',[slot,0x4000]);h.w32(0x4000,123);
    assert.equal(call('TlsFree',[slot]),1);assert.equal(h.u32(0x4000),123,'TlsFree never frees memory addressed by a TLS value');
    assert.equal(call('TlsAlloc'),slot);assert.equal(call('TlsGetValue',[slot]),0);
    assert.equal(one.lastError,0);assert.equal(call('TlsSetValue',[TLS_CAPACITY,1]),0);assert.equal(one.lastError,87);
  });
}
