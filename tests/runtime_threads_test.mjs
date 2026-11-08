import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {Worker,isMainThread,parentPort,workerData} from 'node:worker_threads';
import assert from 'node:assert/strict';
import {test} from 'node:test';

function recoverAbortedCall(x,memory,cpu){
  const depth=x.wc3_context_depth(cpu),stack=x.__stack_pointer.value;
  const before=new Uint8Array(memory.buffer,cpu,x.wc3_cpu_size()).slice();
  assert.throws(()=>x.wc3_call_context(cpu,0x401020,0,0),/Expected guest thread exit/);
  assert.equal(x.wc3_context_depth(cpu),depth+1);
  assert.ok(x.__stack_pointer.value<stack,'host exception bypasses native stack epilogue');
  x.__stack_pointer.value=stack;
  assert.equal(x.wc3_context_recover(cpu,depth),1);
  assert.equal(x.wc3_context_depth(cpu),depth);
  assert.deepEqual(new Uint8Array(memory.buffer,cpu,x.wc3_cpu_size()),before);
}
function hostCall(id,cpu,x,memory){
  if(id===1)throw Error('Expected guest thread exit');
  assert.equal(id,2);assert.equal(x.wc3_context_depth(cpu),1);
  recoverAbortedCall(x,memory,cpu);
  assert.equal(x.wc3_context_depth(cpu),1,'nested exception must preserve outer call frame');
  assert.equal(x.wc3_context_destroy(cpu),0,'active_context must be restored to outer context');
}
function imports(memory,onCall){
  const string=p=>{const bytes=new Uint8Array(memory.buffer);let end=p;while(bytes[end])end++;return new TextDecoder().decode(bytes.slice(p,end));};
  return {env:{memory},wc3:{wc3_host_call:onCall,wc3_host_resolve:()=>0,
    wc3_host_log:()=>{},wc3_host_now:()=>performance.now(),wc3_host_fault:(address,p)=>{throw Error(string(p));}},
    wasi_snapshot_preview1:{sched_yield:()=>0,proc_exit:code=>{throw Error('WASI exit '+code);},fd_close:()=>0,fd_seek:()=>8,fd_write:()=>8,
      clock_time_get:(_id,_precision,out)=>{new DataView(memory.buffer).setBigUint64(out,BigInt(Date.now())*1000000n,true);return 0;}}};
}

if(!isMainThread&&workerData?.scheduler){
  const {runThread}=await import('../web/runtime/thread-worker.mjs');
  parentPort.once('message',async({options})=>{
    await runThread(options,message=>parentPort.postMessage(message));
    parentPort.close();
  });
}else if(!isMainThread){
  try{
    const {module,memory,stackTop,tlsBase,cpu,args,tid}=workerData;
    const {exports:x}=await WebAssembly.instantiate(module,imports(memory,(id,cpu)=>hostCall(id,cpu,x,memory)));
    x.__stack_pointer.value=stackTop;x.__wasm_init_tls(tlsBase);
    assert.equal(x.fixture_marker(0)>>>0,0xbeefcafe,'clone must not reinitialize shared data');
    assert.equal(x.wc3_context_thread_notify(cpu,2),1);
    const code=x.wc3_call_context(cpu,0x401000,1,args);
    assert.equal(x.wc3_context_thread_notify(cpu,3),1);
    parentPort.postMessage({code,tid,tls:x.fixture_tls(0),trace:x.wc3_context_trace_count(cpu)});
  }catch(error){parentPort.postMessage({error:error.stack});}
}else if(process.argv[2]){
  const directory=process.argv[2],module=await WebAssembly.compile(readFileSync(join(directory,'threads.wasm')));
  const memory=new WebAssembly.Memory({initial:128,maximum:16384,shared:true});
  const {exports:x}=await WebAssembly.instantiate(module,imports(memory,(id,cpu)=>hostCall(id,cpu,x,memory)));
  x._initialize();assert.equal(x.wc3_init(0x10000000),1);x.fixture_marker(0xbeefcafe);x.fixture_tls(99);
  const nativeString=s=>{const bytes=new TextEncoder().encode(s+'\0'),p=x.malloc(bytes.length)>>>0;new Uint8Array(memory.buffer).set(bytes,p);return p;};
  for(const name of ['a.dll','b.dll','c.dll','main.exe']){
    const bytes=readFileSync(join(directory,name)),p=x.malloc(bytes.length)>>>0,nativeName=nativeString(name);
    new Uint8Array(memory.buffer).set(bytes,p);assert.ok(x.wc3_load(nativeName,p,bytes.length));x.free(p);x.free(nativeName);
  }
  assert.equal(x.wc3_link(),1);assert.equal(x.wc3_initialize_startup(0x400000),1);
  const events=()=>Array.from({length:x.fixture_event_count()},(_,i)=>Array.from(new Uint32Array(memory.buffer,x.fixture_events()+i*12,3)));
  assert.deepEqual(events(),[[1,0x20000,1],[1,0x10000,1]],'startup initializes only executable dependencies');
  assert.ok(x.fixture_reserved(0));assert.ok(x.fixture_reserved(1),'startup DllMain receives non-NULL reserved');
  assert.equal(x.wc3_module_initialized(0x30000),0);
  assert.equal(x.wc3_initialize_library(x.wc3_cpu_pointer(),0x30000),1);
  assert.equal(x.fixture_reserved(2),0,'dynamic DllMain receives NULL reserved');
  assert.equal(x.wc3_initialize_library(x.wc3_cpu_pointer(),0x30000),1);
  assert.equal(x.wc3_module_initialized(0x30000),1);
  assert.deepEqual(events(),[[1,0x20000,1],[1,0x10000,1],[1,0x30000,1]],'PROCESS_ATTACH follows dependencies');
  assert.equal(x.wc3_disable_thread_calls(0x20000),1);assert.equal(x.wc3_disable_thread_calls(0xdead0000),0);
  assert.equal(x.wc3_context_thread_notify(x.wc3_cpu_pointer(),2),1);assert.equal(events().length,3);
  assert.equal(x.wc3_context_create(0,0x2000000,0x100000,0x200000),0);
  assert.equal(x.wc3_context_create(7,0x200000,0x100000,0x200000),0,'overlap rejected');
  const mainTrace=x.wc3_trace_count(),mainCPU=x.wc3_cpu_pointer();
  const workers=[101,202].map((tid,index)=>{
    const stack=x.malloc(1024*1024)>>>0,tlsRaw=x.malloc(x.__tls_size.value+x.__tls_align.value)>>>0;
    const tlsBase=Math.ceil(tlsRaw/x.__tls_align.value)*x.__tls_align.value;
    const guestStack=0x2000000+index*0x200000,teb=0x200000+index*0x2000;
    const cpu=x.wc3_context_create(tid,guestStack,0x100000,teb)>>>0,args=x.malloc(4)>>>0;
    assert.ok(cpu);new DataView(memory.buffer).setUint32(args,777,true);
    const guest=x.wc3_memory_base()>>>0,view=new DataView(memory.buffer);
    assert.equal(view.getUint32(guest+teb+0x24,true),tid);
    assert.equal(view.getUint32(guest+teb+4,true),guestStack+0x100000);
    assert.equal(view.getUint32(guest+teb+8,true),guestStack);
    x.wc3_context_set_budget(cpu,100);
    const worker=new Worker(new URL(import.meta.url),{workerData:{module,memory,tid,cpu,args,stackTop:stack+1024*1024,tlsBase}});
    return {worker,cpu,args,stack,tlsRaw};
  });
  const results=await Promise.all(workers.map(({worker})=>new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{worker.terminate();reject(Error('Shared runtime worker timeout'));},15000);
    worker.on('message',result=>{clearTimeout(timer);result.error?reject(Error(result.error)):resolve(result);});
    worker.on('error',error=>{clearTimeout(timer);reject(error);});
    worker.on('exit',code=>{if(code){clearTimeout(timer);reject(Error('Worker exit '+code));}});
  })));
  for(const result of results){
    assert.equal(result.code,777+result.tid);assert.equal(result.tls,result.tid);assert.ok(result.trace>=10);
    assert.deepEqual(events().filter(e=>e[0]===result.tid),[[result.tid,0x10000,2],[result.tid,0x30000,2],
      [result.tid,0x30000,3],[result.tid,0x10000,3]],'thread notifications preserve dependency order and suppression');
  }
  for(let i=3;i<x.fixture_event_count();i++)assert.equal(x.fixture_reserved(i),0,'thread notifications receive NULL reserved');
  assert.equal(new DataView(memory.buffer).getUint32((x.wc3_memory_base()>>>0)+0x100000,true),200000);
  assert.equal(x.fixture_tls(0),99);assert.equal(x.wc3_trace_count(),mainTrace,'worker trace must not overwrite main context');
  assert.equal(x.wc3_cpu_pointer(),mainCPU);assert.equal(x.wc3_context_destroy(mainCPU),0);
  for(const item of workers){
    await item.worker.terminate();
    for(let i=0;i<3;i++)recoverAbortedCall(x,memory,item.cpu);
    assert.equal(x.wc3_context_thread_notify(item.cpu,3),1,'DLL detach remains callable after recovery');
    assert.equal(x.wc3_context_destroy(item.cpu),1);x.free(item.args);x.free(item.stack);x.free(item.tlsRaw);
  }
  const stack=x.__stack_pointer.value;
  assert.throws(()=>x.fixture_no_context_fault(),/eip=0x00000000/,'no dangling active_context after destroy');
  x.__stack_pointer.value=stack;
  const args=x.malloc(4);new DataView(memory.buffer).setUint32(args,9,true);
  assert.equal(x.wc3_call(0x401010,1,args),10,'existing main-thread wrapper still works');
  x.wc3_set_budget(1);const limitedStack=x.__stack_pointer.value,limitedDepth=x.wc3_context_depth(mainCPU);
  assert.throws(()=>x.wc3_call(0x401010,1,args),/dispatch budget exhausted/,'finite diagnostic budget still stops execution');
  x.__stack_pointer.value=limitedStack;x.wc3_context_recover(mainCPU,limitedDepth);
  x.wc3_set_budget(0);
  for(let i=0;i<100;i++)assert.equal(x.wc3_call(0x401010,1,args),10,'interactive zero budget permits repeated dispatch');
  x.free(args);
  const {WarcraftHost}=await import('../web/runtime/host.mjs');
  const {GuestThreadScheduler}=await import('../web/runtime/thread-scheduler.mjs');
  const host=new WarcraftHost({memory});
  // The fixture reserves 256 MiB, while the production guest heap starts at
  // 768 MiB. Use a disjoint arena inside this smaller guest address space.
  let guestNext=0x5000000;
  host.attach({exports:{...x,wc3_guest_alloc:size=>{const p=guestNext;guestNext+=size;return p;}}});
  host.resolve('kernel32.dll','GetCurrentThreadId');
  const scheduler=new GuestThreadScheduler({host,instance:{exports:x},compiledModule:module},{maxThreads:2,
    workerFactory:()=>new Worker(new URL(import.meta.url),{workerData:{scheduler:true}})});
  let failure;scheduler.reject=error=>{failure=error;};
  const start=()=>host.threadServices.create(0x401030,700,4,65536);
  const first=start(),second=start(),firstItem=host.handles.get(first),secondItem=host.handles.get(second);
  assert.throws(()=>start(),/worker limit/,'simultaneously live and suspended threads still obey the limit');
  const handles=[first,second],nativeSizes=[],guestSizes=[];
  try{
    for(let i=0;i<40;i++){
      const handle=i<2?handles[i]:start(),item=host.handles.get(handle),tid=item.id;
      const waited=host.threadServices.wait([handle],false,10000);
      // Closing a handle cannot prevent the scheduler from reclaiming memory,
      // and an existing wait must keep the exited thread object alive.
      if(i===0)host.handlers.get('kernel32.dll!CloseHandle').fn([handle]);
      assert.equal(scheduler.resume(item),1);
      assert.equal(await waited,0);
      assert.equal(failure,undefined);assert.equal(item.state,'exited');assert.equal(item.exitCode,700+tid);
      assert.equal(item.cpu,0);assert.equal(item.worker,null);assert.equal(item.localImports,null);
      assert.equal(host.threadServices.threads.has(tid),false);
      if(i!==0){
        assert.equal(host.threadServices.wait([handle],false,0),0,'an exited thread remains waitable until its handle is closed');
        const output=0x100100;
        assert.equal(host.handlers.get('kernel32.dll!GetExitCodeThread').fn([handle,output]),1);
        assert.equal(host.u32(output),700+tid);
        host.handlers.get('kernel32.dll!CloseHandle').fn([handle]);
      }
      assert.equal(scheduler.calls()['kernel32.dll!GetCurrentThreadId'],i+1,'retiring a worker preserves its import counters exactly once');
      if(i>=1){nativeSizes.push(memory.buffer.byteLength);guestSizes.push(guestNext);}
    }
    assert.equal(new Set(nativeSizes).size,1,'native memory stops growing when completed worker stacks/TLS/CPUs are reclaimed');
    assert.equal(new Set(guestSizes).size,1,'guest stacks and TEBs are reused across more than 16 thread creations');
    assert.equal(scheduler.threads.size,0);assert.equal(host.threadContexts.size,1);
    assert.equal(scheduler.report().length,40);assert.ok(scheduler.report().every(item=>item.state==='exited'&&item.trace.length));
    assert.equal(firstItem.exitCode,702);assert.equal(secondItem.exitCode,703);
  }finally{scheduler.stop();}
  console.log(JSON.stringify({ok:true,workers:results,recycledWorkers:40,atomicGuestIncrements:200000,tlsSize:x.__tls_size.value,tlsAlign:x.__tls_align.value}));
}else{
  test('shared WASM CPU fixture (compiled and invoked by Python suite)',{skip:'Run tests/test_runtime_threads.py to build the fixture'},()=>{});
}
