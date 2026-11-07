import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Worker} from 'node:worker_threads';
import {WarcraftHost,GuestFault,GuestThreadExit} from '../web/runtime/host.mjs';

function fixture(){
  const h=new WarcraftHost({memory:new WebAssembly.Memory({initial:128,maximum:128,shared:true}),listFiles:()=>[],readFile:()=>null});
  h.base=0;let nextAddress=0x10000,nextId=3;
  h.exports={wc3_guest_alloc(size){const pointer=nextAddress;nextAddress+=size;return pointer;}};
  h.registerContext(0x100,1);h.registerContext(0x200,2);
  const created=[];
  h.scheduler={
    create(entry,arg,flags,stackSize){const id=nextId++,item={kind:'thread',id,cpu:id*0x100,state:flags&4?'suspended':'running',suspendCount:flags&4?1:0,exitCode:259,entry,arg,stackSize};h.registerContext(item.cpu,id);created.push(item);return item;},
    resume(item){const previous=item.suspendCount;if(previous){item.suspendCount--;if(!item.suspendCount)item.state='running';}return previous;},
    exit(code,id){throw new GuestThreadExit(code);},
  };
  const call=(thread,name,args=[])=>{
    const previous=h.currentCPU;h.currentCPU=thread*0x100;
    try{const handler=h.handlers.get(`kernel32.dll!${name}`);assert.ok(handler,name);assert.equal(args.length,handler.argc,name);return handler.fn(args.map(value=>value>>>0));}
    finally{h.currentCPU=previous;}
  };
  const context=id=>h.threadContexts.get(id*0x100);
  return {h,call,context,created};
}

test('thread IDs, last-error and TLS values belong to their initiating CPU',()=>{
  const{h,call,context}=fixture();
  assert.equal(call(1,'GetCurrentThreadId'),1);assert.equal(call(2,'GetCurrentThreadId'),2);
  const slot=call(1,'TlsAlloc');call(1,'TlsSetValue',[slot,11]);call(1,'SetLastError',[77]);
  assert.equal(call(2,'TlsGetValue',[slot]),0);call(2,'TlsSetValue',[slot,22]);call(2,'SetLastError',[88]);
  assert.equal(call(1,'GetLastError'),77);assert.equal(call(2,'GetLastError'),88);
  assert.equal(call(1,'TlsGetValue',[slot]),11);assert.equal(call(2,'TlsGetValue',[slot]),22);
  assert.equal(call(2,'TlsFree',[slot]),1);assert.equal(call(1,'TlsGetValue',[slot]),0);assert.equal(context(1).lastError,87);
  assert.equal(context(2).tls.has(slot),false);
});

test('auto-reset wakes exactly one waiter while manual-reset wakes all',async()=>{
  const{h,call}=fixture();const event=call(1,'CreateEventA',[0,0,0,0]);
  let firstDone=false,secondDone=false;
  const first=call(1,'WaitForSingleObject',[event,0xffffffff]).then(value=>{firstDone=true;return value;});
  const second=call(2,'WaitForSingleObject',[event,0xffffffff]).then(value=>{secondDone=true;return value;});
  assert.ok(first instanceof Promise);await Promise.resolve();assert.equal(firstDone,false);assert.equal(secondDone,false);
  call(2,'SetEvent',[event]);assert.equal(await first,0);assert.equal(secondDone,false);
  call(1,'SetEvent',[event]);assert.equal(await second,0);assert.equal(call(1,'WaitForSingleObject',[event,0]),258);
  const manual=call(1,'CreateEventA',[0,1,0,0]);const a=call(1,'WaitForSingleObject',[manual,0xffffffff]),b=call(2,'WaitForSingleObject',[manual,0xffffffff]);
  call(1,'SetEvent',[manual]);assert.deepEqual(await Promise.all([a,b]),[0,0]);assert.equal(call(2,'WaitForSingleObject',[manual,0]),0);
  call(2,'ResetEvent',[manual]);assert.equal(call(1,'WaitForSingleObject',[manual,0]),258);
});

test('wait-all acquires atomically, returns timeout and keeps last-error isolated',async()=>{
  const{h,call,context}=fixture(),a=call(1,'CreateEventA',[0,0,1,0]),b=call(1,'CreateEventA',[0,0,0,0]),ids=h.alloc(8);
  h.w32(ids,a);h.w32(ids+4,b);let completed=false;
  const pending=call(1,'WaitForMultipleObjects',[2,ids,1,0xffffffff]).then(value=>{completed=true;return value;});
  assert.equal(call(2,'WaitForSingleObject',[a,0]),0,'Unready wait-all cannot consume its first event');
  call(2,'SetEvent',[b]);await Promise.resolve();assert.equal(completed,false);
  call(2,'SetEvent',[a]);assert.equal(await pending,0);
  assert.equal(call(2,'WaitForSingleObject',[a,0]),258);assert.equal(call(2,'WaitForSingleObject',[b,0]),258);
  call(1,'SetLastError',[71]);call(2,'SetLastError',[72]);assert.equal(await call(2,'WaitForSingleObject',[b,5]),258);
  assert.equal(context(1).lastError,71);assert.equal(context(2).lastError,72,'Wait timeout does not overwrite GetLastError');
});

test('mutexes track owners, recursion and abandoned ownership after thread exit',async()=>{
  const{h,call}=fixture(),mutex=call(1,'CreateMutexA',[0,1,0]);
  assert.equal(call(2,'ReleaseMutex',[mutex]),0);assert.equal(call(2,'GetLastError'),288);
  assert.equal(call(2,'WaitForSingleObject',[mutex,0]),258);
  const pending=call(2,'WaitForSingleObject',[mutex,0xffffffff]);assert.equal(call(1,'ReleaseMutex',[mutex]),1);assert.equal(await pending,0);
  assert.equal(call(2,'WaitForSingleObject',[mutex,0]),0);assert.equal(call(2,'ReleaseMutex',[mutex]),1);
  assert.equal(call(1,'WaitForSingleObject',[mutex,0]),258);
  h.notifyThreadState({kind:'thread',id:2,cpu:0x200,state:'exited',exitCode:9});
  assert.equal(call(1,'WaitForSingleObject',[mutex,0]),0x80);assert.equal(call(1,'ReleaseMutex',[mutex]),1);
});

test('critical-section contention yields and grants ownership to captured waiter',async()=>{
  const{h,call}=fixture(),section=h.alloc(24);call(1,'InitializeCriticalSection',[section]);
  call(1,'EnterCriticalSection',[section]);call(1,'EnterCriticalSection',[section]);assert.equal(call(2,'TryEnterCriticalSection',[section]),0);
  let entered=false;const pending=call(2,'EnterCriticalSection',[section]).then(()=>{entered=true;});
  call(1,'LeaveCriticalSection',[section]);await Promise.resolve();assert.equal(entered,false);
  call(1,'LeaveCriticalSection',[section]);await pending;assert.equal(h.u32(section+12),2);assert.equal(h.u32(section+8),1);
  assert.throws(()=>call(1,'LeaveCriticalSection',[section]),/not owned/);
  call(2,'LeaveCriticalSection',[section]);call(1,'DeleteCriticalSection',[section]);
});

test('thread handles expose actual scheduler lifecycle and ExitThread is distinct',async()=>{
  const{h,call,created}=fixture(),idOut=h.alloc(4),exitCode=h.alloc(4);
  const handle=call(1,'CreateThread',[0,4096,0x401000,0xabcdef,4,idOut]);assert.ok(handle);
  const thread=created[0];assert.equal(thread.id,h.u32(idOut));assert.equal(thread.entry,0x401000);assert.equal(thread.arg,0xabcdef);assert.equal(thread.stackSize,4096);assert.equal(thread.state,'suspended');
  assert.equal(call(2,'GetExitCodeThread',[handle,exitCode]),1);assert.equal(h.u32(exitCode),259);
  const completion=call(2,'WaitForSingleObject',[handle,0xffffffff]);assert.equal(call(1,'ResumeThread',[handle]),1);assert.equal(thread.state,'running');
  assert.throws(()=>call(thread.id,'ExitThread',[17]),problem=>problem instanceof GuestThreadExit&&problem.code===17);
  thread.state='exited';thread.exitCode=17;h.notifyThreadState(thread);assert.equal(await completion,0);
  call(1,'GetExitCodeThread',[handle,exitCode]);assert.equal(h.u32(exitCode),17);
  assert.throws(()=>call(1,'CreateThread',[0,0,0x401000,0,0x10000,0]),/Unsupported CreateThread flags/);
});

test('IO completion waits retain output context and can be fulfilled by another CPU',async()=>{
  const{h,call,context}=fixture(),port=call(1,'CreateIoCompletionPort',[0xffffffff,0,0,1]);
  const bytes=h.alloc(4),key=h.alloc(4),overlapped=h.alloc(4);
  call(1,'SetLastError',[123]);const timeout=call(2,'GetQueuedCompletionStatus',[port,bytes,key,overlapped,5]);
  assert.equal(await timeout,0);assert.equal(context(2).lastError,258);assert.equal(context(1).lastError,123);
  const wait=call(2,'GetQueuedCompletionStatus',[port,bytes,key,overlapped,0xffffffff]);
  call(1,'PostQueuedCompletionStatus',[port,99,0x1234,0x5566]);assert.equal(await wait,1);
  assert.deepEqual([h.u32(bytes),h.u32(key),h.u32(overlapped)],[99,0x1234,0x5566]);
});

test('scheduler shutdown cancels waits, sleeps and contended critical sections',async()=>{
  const{h,call}=fixture(),event=call(1,'CreateEventA',[0,0,0,0]),section=h.alloc(24);
  call(1,'InitializeCriticalSection',[section]);call(1,'EnterCriticalSection',[section]);
  const pending=[call(2,'WaitForSingleObject',[event,0xffffffff]),call(2,'Sleep',[0xffffffff]),call(2,'EnterCriticalSection',[section])];
  const assertions=pending.map(promise=>assert.rejects(promise,GuestFault));h.cancelThreadWaits();await Promise.all(assertions);
  assert.equal(h.threadServices.waiters.length,0);assert.equal(h.threadServices.sleeps.size,0);
});

test('invokeAsync resumes the correct CPU stack after interleaved broker calls',async()=>{
  const{h,call,context}=fixture(),event=call(1,'CreateEventA',[0,0,0,0]);
  const invoke=(thread,name,args,returnAddress)=>{
    const cpu=thread*0x100,stack=0x4000+thread*0x100;
    h.view.setUint32(cpu+16,stack,true);h.w32(stack,returnAddress);
    args.forEach((value,i)=>h.w32(stack+4+i*4,value));
    const id=(h.resolve('kernel32.dll',name)-0xf1000000)/16;
    return h.invokeAsync(id,cpu);
  };
  call(1,'SetLastError',[101]);call(2,'SetLastError',[202]);
  const waiting=invoke(1,'WaitForSingleObject',[event,0xffffffff],0x401111);
  assert.equal(h.currentCPU,undefined);assert.equal(h.view.getUint32(0x110,true),0x4100);
  await invoke(2,'SetEvent',[event],0x402222);await waiting;
  assert.equal(h.view.getUint32(0x100,true),0);assert.equal(h.view.getUint32(0x200,true),1);
  assert.equal(h.view.getUint32(0x110,true),0x410c);assert.equal(h.view.getUint32(0x210,true),0x4208);
  assert.equal(h.view.getUint32(0x120,true),0x401111);assert.equal(h.view.getUint32(0x220,true),0x402222);
  assert.equal(context(1).lastError,101);assert.equal(context(2).lastError,202);
  assert.equal(h.currentCPU,undefined);
});

test('Interlocked host calls remain atomic against a concurrent guest-memory worker',{timeout:10000},async()=>{
  const{h,call}=fixture(),pointer=h.alloc(8),count=200000;
  const word=new Int32Array(h.memory.buffer,pointer,2);
  const worker=new Worker(`
    const {parentPort,workerData}=require('node:worker_threads');
    const word=new Int32Array(workerData.buffer,workerData.pointer,2);
    parentPort.postMessage('ready');
    Atomics.wait(word,1,0);
    for(let i=0;i<workerData.count;i++)Atomics.add(word,0,1);
    parentPort.postMessage('done');
  `,{eval:true,workerData:{buffer:h.memory.buffer,pointer,count}});
  try{
    await new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);});
    const done=new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);});
    Atomics.store(word,1,1);Atomics.notify(word,1);
    const increment=h.handlers.get('kernel32.dll!InterlockedIncrement').fn;
    for(let i=0;i<count;i++)increment([pointer]);
    await done;assert.equal(Atomics.load(word,0),count*2);
    assert.equal(call(1,'InterlockedExchangeAdd',[pointer,7]),count*2);
    assert.equal(call(1,'InterlockedDecrement',[pointer]),count*2+6);
    assert.equal(call(1,'InterlockedExchange',[pointer,44]),count*2+6);
    assert.equal(call(1,'InterlockedCompareExchange',[pointer,99,44]),44);assert.equal(h.u32(pointer),99);
    assert.throws(()=>call(1,'InterlockedIncrement',[pointer+1]),/Unaligned Interlocked/);
  }finally{await worker.terminate();}
});
