import {WarcraftHost, GuestFault} from './host.mjs';
import {GuestCallProxy, serializeGuestError} from './thread-rpc.mjs';
import {localImportDispatcher} from './worker-fast.mjs';
import {GraphicsCommandQueue} from './graphics-batch.mjs';
import {webkitCollectorNudge} from './webkit-gc.mjs';

const validPointer = value => Number.isInteger(value) && value > 0 && value <= 0xffffffff;

// The broker owns loader/heap/handles and initialized shared memory. A child
// instance needs its own native stack and TLS, but must never initialize them
// by running the process reactor initializer again.
export async function runThread(options, postFn = message => globalThis.postMessage(message)) {
  let outcome;
  const threadId = options?.threadId;
  try {
    if (!Number.isInteger(threadId) || threadId < 1 || threadId > 0xffffffff) throw new GuestFault('Invalid guest thread ID', {threadId});
    const {module, memory, cpu, entry, argPointer = 0, argCount = 0, nativeStackTop, tlsBase} = options || {};
    if (!(module instanceof WebAssembly.Module) || !(memory instanceof WebAssembly.Memory) || !(memory.buffer instanceof SharedArrayBuffer)) throw new GuestFault('Thread requires a compiled WASM module and shared memory');
    if (!validPointer(cpu) || cpu % 4 || cpu + 36 > memory.buffer.byteLength || !validPointer(entry)) throw new GuestFault('Invalid thread CPU or guest entry point', {cpu, entry});
    if (!validPointer(nativeStackTop) || nativeStackTop % 16 || nativeStackTop > memory.buffer.byteLength) throw new GuestFault('Invalid native thread stack', {nativeStackTop});
    if (!Number.isInteger(argCount) || argCount < 0 || argCount > 1024 || !Number.isInteger(argPointer) || argPointer < 0 || argPointer + argCount * 4 > memory.buffer.byteLength || (argCount && !argPointer)) throw new GuestFault('Invalid native thread argument buffer', {argPointer, argCount});
    const origin = Number.isFinite(options.clockOrigin) ? options.clockOrigin : performance.timeOrigin;
    const clock = () => performance.timeOrigin + performance.now() - origin;
    const log = message => postFn({type: 'thread-log', threadId, message: String(message)});
    const rpc = new GuestCallProxy({post: postFn, timeout: options.rpcTimeout ?? 300000, doorbell: options.doorbell});
    const host = new WarcraftHost({memory, log, clock,tlsSlots:options.tlsSlots});
    host.blockingWaits = true; // Atomics.wait is allowed here, not in the broker.
    const imports = host.imports();
    let local=null,batch=null;
    // Queued GL work is handed to the broker asynchronously (callback return,
    // thread exit, swaps); the broker executes it before any graphics import.
    const flush=()=>batch?.submit();
    const hostCall = (id, context) => {
      id>>>=0;context>>>=0;
      if(batch?.enqueue(id,context)||local?.(id,context))return;
      rpc.call(id,context,batch?.syncPoint());
      batch?.afterSync(id,context);
    };
    // Safari only (webkit-gc.mjs): this worker never returns to its event loop,
    // so the nudge rides on host calls, about twice a second on a busy thread.
    const nudge = webkitCollectorNudge(memory);
    let hostCalls = 0;
    imports.wc3.wc3_host_call = nudge ? (id, context) => { if (++hostCalls >= 65536) { hostCalls = 0; nudge(); } hostCall(id, context); } : hostCall;
    imports.wc3.wc3_host_resolve = (library, name, ordinal) => {
      throw new GuestFault('A child thread cannot resolve imports outside the broker', {library: host.nativeString(library), name: host.nativeString(name), ordinal});
    };
    imports.wc3.wc3_host_fault = (address, message) => {
      throw new GuestFault(host.nativeString(message), {address: address >>> 0, threadId, cpu, eip: host.view.getUint32(cpu + 32, true)});
    };
    const yieldWord = new Int32Array(new SharedArrayBuffer(4));
    imports.wasi_snapshot_preview1.sched_yield = () => { Atomics.wait(yieldWord, 0, 0, 0); return 0; };
    const instance = await WebAssembly.instantiate(module, imports);
    const exports = instance.exports;
    if (!(exports.__stack_pointer instanceof WebAssembly.Global) || typeof exports.__wasm_init_tls !== 'function' || typeof exports.wc3_call_context !== 'function' || typeof exports.wc3_context_thread_notify !== 'function' || typeof exports.wc3_context_recover !== 'function' || typeof exports.wc3_context_depth !== 'function') throw new GuestFault('WASM lacks secondary-thread stack/TLS/context exports');
    const tlsSize = Number(exports.__tls_size?.value), tlsAlign = Number(exports.__tls_align?.value);
    if (!Number.isSafeInteger(tlsSize) || tlsSize < 0 || !Number.isSafeInteger(tlsAlign) || tlsAlign < 1 || !Number.isSafeInteger(tlsBase) || tlsBase <= 0 || tlsBase % tlsAlign || tlsBase + tlsSize > memory.buffer.byteLength) throw new GuestFault('Invalid native thread TLS allocation', {tlsBase, tlsSize, tlsAlign});
    exports.__stack_pointer.value = nativeStackTop;
    exports.__wasm_init_tls(tlsBase);
    host.instance=instance;host.exports=exports;host.base=options.guestBase??0;host.permissionsBase=options.permissionsBase??0;
    host.capacity=exports.wc3_memory_capacity?.()>>>0||host.capacity;
    host.started=options.processStarted??host.started;host.registerContext(cpu,threadId,options.threadState);
    if(options.localImports)local=localImportDispatcher(host,options.localImports,cpu);
    if(options.graphicsBatch)batch=new GraphicsCommandQueue(host,options.graphicsBatch,{post:postFn,framesInFlight:options.framesInFlight??1});
    const guestCall=call=>{
      const stack=exports.__stack_pointer.value,depth=exports.wc3_context_depth(cpu);
      try{return call();}
      catch(error){
        const registers=Object.fromEntries(['eax','ecx','edx','ebx','esp','ebp','esi','edi','eip'].map((name,i)=>[name,'0x'+host.view.getUint32(cpu+i*4,true).toString(16).padStart(8,'0')]));
        error.details={...error.details,registers};
        exports.__stack_pointer.value=stack;exports.wc3_context_recover(cpu,depth);
        throw error;
      }
    };
    rpc.callback=(address,args,context)=>{
      if(context!==cpu)throw new GuestFault('Callback CPU does not belong to this worker');
      const pointer=exports.malloc(Math.max(4,args.length*4))>>>0;if(!pointer)throw new GuestFault('Callback argument allocation failed');
      try{args.forEach((v,i)=>host.view.setUint32(pointer+i*4,v,true));return guestCall(()=>exports.wc3_call_context(cpu,address,args.length,pointer));}
      finally{try{flush();}finally{exports.free(pointer);}}
    };
    if (threadId !== 1 && !guestCall(()=>exports.wc3_context_thread_notify(cpu, 2))) throw new GuestFault('DLL_THREAD_ATTACH failed', {threadId, cpu});
    let code;
    try { code = guestCall(()=>exports.wc3_call_context(cpu, entry, argCount, argPointer)) >>> 0; }
    catch (error) {
      if (error?.name !== 'GuestThreadExit' || !Number.isInteger(error.code)) throw error;
      code = error.code >>> 0;
    }
    if (threadId !== 1 && !guestCall(()=>exports.wc3_context_thread_notify(cpu, 3))) throw new GuestFault('DLL_THREAD_DETACH failed', {threadId, cpu});
    flush();
    outcome = {type: 'thread-exit', threadId, code};
  } catch (error) {
    if (error?.name === 'GuestExit' && Number.isInteger(error.code)) {
      outcome = {type: 'process-exit', threadId, code: error.code >>> 0};
    } else outcome = {type: 'thread-fault', threadId, error: serializeGuestError(error)};
  }
  // Completion is the ownership handoff: after this publication the broker may
  // free the CPU, guest stack/TEB and native stack/TLS. No WASM or shared-memory
  // access is permitted below, including in worker adapters used by tests.
  postFn(outcome);
  return outcome;
}

if (typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope) {
  let started = false;
  globalThis.onmessage = event => {
    if (event.data?.type !== 'init') return;
    if (started) {
      globalThis.postMessage({type: 'thread-fault', error: {name: 'GuestFault', message: 'Guest thread worker was already initialized'}});
      return;
    }
    started = true;
    void runThread(event.data.options);
  };
}
