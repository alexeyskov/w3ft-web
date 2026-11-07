import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {GuestCallProxy, GuestCallbackBroker, serveGuestCall, serializeGuestError, pulseGuestCall} from '../web/runtime/thread-rpc.mjs';
import {runThread} from '../web/runtime/thread-worker.mjs';

const rpcURL = new URL('../web/runtime/thread-rpc.mjs', import.meta.url).href;
const workerURL = new URL('../web/runtime/thread-worker.mjs', import.meta.url).href;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('nested callbacks execute on the original worker and their imports can await broker work',async t=>{
  const memory=new SharedArrayBuffer(128),view=new DataView(memory),callbacks=new GuestCallbackBroker();
  const worker=new Worker(`
    const {parentPort,workerData}=require('node:worker_threads');
    (async()=>{
      const {GuestCallProxy}=await import(workerData.rpcURL);
      const proxy=new GuestCallProxy({post:m=>parentPort.postMessage(m),timeout:5000});
      proxy.callback=(address,args,cpu)=>{
        if(address===100){proxy.call(2,cpu);return args[0]+new DataView(workerData.memory).getUint32(cpu,true);}
        if(address===200)return args[0]*2;
        throw Object.assign(Error('callback failure'),{name:'GuestFault',details:{address}});
      };
      proxy.call(1,16);const first=new DataView(workerData.memory).getUint32(16,true);
      proxy.call(3,16);parentPort.postMessage({type:'result',first,second:new DataView(workerData.memory).getUint32(16,true),depth:proxy.depth});
    })().catch(e=>parentPort.postMessage({type:'failure',message:e.stack}));
  `,{eval:true,workerData:{rpcURL,memory}});
  t.after(()=>worker.terminate());
  const visited=[];
  const result=await new Promise((resolve,reject)=>{
    worker.on('error',reject);
    worker.on('message',message=>{
      if(message.type==='guest-callback-result'){try{callbacks.complete(message);}catch(e){reject(e);}return;}
      if(message.type==='result'){resolve(message);return;}
      if(message.type==='failure'){reject(Error(message.message));return;}
      void serveGuestCall(message,async(id,cpu)=>{
        visited.push(id);
        if(id===1){
          const value=await callbacks.call(message,100,[7]);
          await assert.rejects(callbacks.call(message,300,[]),e=>e.name==='GuestFault'&&e.details.address===300);
          view.setUint32(cpu,value,true);
        }else if(id===2){await delay(20);view.setUint32(cpu,await callbacks.call(message,200,[5]),true);}
        else view.setUint32(cpu,view.getUint32(cpu,true)+1,true);
      }).catch(reject);
    });
  });
  assert.deepEqual(visited,[1,2,3]);assert.equal(result.first,17);assert.equal(result.second,18);assert.equal(result.depth,0);assert.equal(callbacks.pending.size,0);
});

function rpcWorker({calls, memory, timeout = 1000, invoker, heartbeat=0}) {
  const worker = new Worker(`
    const {parentPort,workerData}=require('node:worker_threads');
    (async()=>{
      const {GuestCallProxy,serializeGuestError}=await import(workerData.rpcURL);
      const proxy=new GuestCallProxy({post:message=>parentPort.postMessage(message),timeout:workerData.timeout});
      const results=[];
      for(const [id,cpu] of workerData.calls){
        try{proxy.call(id,cpu);results.push({ok:true,value:new DataView(workerData.memory).getUint32(cpu,true)});}
        catch(error){results.push({ok:false,error:serializeGuestError(error)});}
      }
      parentPort.postMessage({type:'result',results});
    })().catch(error=>parentPort.postMessage({type:'failure',message:error.stack}));
  `, {eval: true, workerData: {rpcURL, calls, memory, timeout}});
  const pending = [];
  const result = new Promise((resolve, reject) => {
    worker.on('error', reject);
    worker.on('message', message => {
      if (message.type === 'guest-call' && invoker) {
        const timer=heartbeat?setInterval(()=>pulseGuestCall(message),heartbeat):null;
        const promise = serveGuestCall(message, invoker).finally(()=>clearInterval(timer));
        pending.push(promise);
        promise.catch(reject);
      } else if (message.type === 'result') resolve(message.results);
      else if (message.type === 'failure') reject(new Error(message.message));
    });
  });
  return {worker, result, pending};
}

test('two real workers await overlapping broker promises and observe shared CPU writes', async t => {
  const memory = new SharedArrayBuffer(128), view = new DataView(memory);
  let active = 0, maximum = 0, started = 0, releaseBoth;
  const bothEntered = new Promise(resolve => { releaseBoth = resolve; });
  const invoker = async (id, cpu) => {
    maximum = Math.max(maximum, ++active);
    if (++started === 2) releaseBoth();
    await bothEntered;
    await delay(30);
    view.setUint32(cpu, view.getUint32(cpu, true) + id, true);
    active--;
  };
  const first = rpcWorker({memory, calls: [[7, 16], [5, 16]], invoker});
  const second = rpcWorker({memory, calls: [[9, 32], [4, 32]], invoker});
  t.after(async () => { await first.worker.terminate(); await second.worker.terminate(); });
  const [a, b] = await Promise.all([first.result, second.result]);
  assert.deepEqual(a, [{ok: true, value: 7}, {ok: true, value: 12}]);
  assert.deepEqual(b, [{ok: true, value: 9}, {ok: true, value: 13}]);
  assert.equal(maximum, 2);
  assert.equal(active, 0);
});

test('guest-call RPC preserves async errors, guest context, and exit code', async t => {
  const memory = new SharedArrayBuffer(128);
  const cases = [
    {name: 'GuestFault', message: 'Unsupported opcode', details: {address: 0x1234, history: ['guest!call'], threadId: 3}},
    {name: 'GuestThreadExit', message: 'Thread finished', code: 41},
    {name: 'GuestExit', message: 'Process finished', code: 42},
  ];
  const fixture = rpcWorker({memory, calls: cases.map((_, id) => [id, 16]), invoker: async id => {
    await delay(1); throw Object.assign(new Error(cases[id].message), cases[id]);
  }});
  t.after(() => fixture.worker.terminate());
  assert.deepEqual(await fixture.result, cases.map(error => ({ok: false, error})));
});

test('worker timeout is a fault, poisons its proxy, and suppresses a late success', async t => {
  const memory = new SharedArrayBuffer(128);
  let completed = false;
  const fixture = rpcWorker({memory, timeout: 30, calls: [[1, 16], [2, 16]], invoker: async () => {
    await delay(90); completed = true;
  }});
  t.after(() => fixture.worker.terminate());
  const result = await fixture.result;
  assert.equal(result[0].ok, false);
  assert.match(result[0].error.message, /timed out/);
  assert.equal(result[0].error.details.mayHaveExecuted, true);
  assert.equal(result[1].ok, false);
  assert.match(result[1].error.message, /unavailable after a timeout/);
  const replies = await Promise.all(fixture.pending);
  assert.equal(completed, true);
  assert.equal(replies[0].cancelled, true);
  assert.equal(replies[0].ok, false);
});

test('a live broker can hold a legitimate wait longer than the transport timeout',async t=>{
  const memory=new SharedArrayBuffer(128),view=new DataView(memory);
  const fixture=rpcWorker({memory,timeout:60,heartbeat:10,calls:[[1,16]],invoker:async()=>{
    await delay(240);view.setUint32(16,42,true);
  }});
  t.after(()=>fixture.worker.terminate());
  assert.deepEqual(await fixture.result,[{ok:true,value:42}]);
  assert.equal((await Promise.all(fixture.pending))[0].ok,true);
});

test('queued cancellation does not call broker; duplicate messages execute once', async t => {
  const memory = new SharedArrayBuffer(128);
  const fixture = rpcWorker({memory, timeout: 20, calls: [[1, 16]]});
  t.after(() => fixture.worker.terminate());
  let request;
  fixture.worker.on('message', message => { if (message.type === 'guest-call') request = message; });
  const result = await fixture.result;
  assert.equal(result[0].error.details.mayHaveExecuted, false);
  const cancelled = await serveGuestCall(request, () => assert.fail('cancelled queued call executed'));
  assert.equal(cancelled.cancelled, true);
  const fresh = {...request, replySAB: new SharedArrayBuffer(request.replySAB.byteLength)};
  Atomics.store(new BigInt64Array(fresh.replySAB,0,1),0,BigInt(fresh.sequence)<<32n);
  let count = 0;
  const original = serveGuestCall(fresh, async () => { count++; await delay(5); });
  assert.equal((await serveGuestCall(fresh, () => assert.fail('duplicate executed'))).duplicate, true);
  assert.equal((await original).ok, true);
  assert.equal(count, 1);
});

test('reused reply buffer rejects an old duplicate after the next call becomes pending', async t => {
  const memory=new SharedArrayBuffer(128),fixture=rpcWorker({memory,calls:[[11,16],[22,16]]});
  t.after(()=>fixture.worker.terminate());
  let first, sharedCounter;
  const checks=[];
  fixture.worker.on('message',message=>{
    if(message.type!=='guest-call')return;
    const task=(async()=>{
      if(!first){first=message;sharedCounter=new BigInt64Array(first.replySAB,0,1);}
      else{
        assert.equal(message.sequence,first.sequence+1);
        assert.equal(Number(BigInt.asUintN(64,Atomics.load(sharedCounter,0))>>32n),message.sequence,'same shared memory carries next generation');
        const old=await serveGuestCall(first,()=>assert.fail('old call claimed new pending generation'));
        assert.equal(old.stale,true);assert.equal(old.ok,false);
      }
      await serveGuestCall(message,(id,cpu)=>new DataView(memory).setUint32(cpu,id,true));
    })();checks.push(task);
  });
  const result=await fixture.result;
  await Promise.all(checks);
  assert.deepEqual(result,[{ok:true,value:11},{ok:true,value:22}]);
});

test('error JSON is bounded and malformed requests never claim success', async () => {
  const circular = {}; circular.self = circular;
  for (const details of [circular, {text: 'x'.repeat(100000)}]) {
    const serialized = serializeGuestError({name: 'GuestFault', message: 'Original failure', code: 12, details});
    assert.equal(serialized.name, 'GuestFault');
    assert.equal(serialized.message, 'Original failure');
    assert.equal(serialized.code, 12);
    assert.equal(serialized.details.truncated, true);
    assert.ok(new TextEncoder().encode(JSON.stringify(serialized)).length <= 65536);
  }
  assert.deepEqual(await serveGuestCall({type: 'unrelated'}, () => {}), {handled: false});
  await assert.rejects(serveGuestCall({type: 'guest-call', replySAB: new SharedArrayBuffer(4)}, () => {}), /Invalid guest-call reply/);
  assert.throws(() => new GuestCallProxy({timeout: 0}), /Invalid guest-call RPC/);
});

// Tiny actual WASM fixture: imported shared memory and HLE; _initialize traps
// to ensure child setup never repeats process initialization. TLS writes a
// marker, and wc3_call_context returns the CPU EAX written by the broker.
function threadModule() {
  const uleb = n => { const out = []; do { const b = n & 127; n >>>= 7; out.push(b | (n ? 128 : 0)); } while (n); return out; };
  const str = s => [...uleb(s.length), ...Buffer.from(s)];
  const vector = items => [...uleb(items.length), ...items.flat()];
  const section = (id, data) => [id, ...uleb(data.length), ...data];
  const type = (args, results) => [0x60, ...vector(args.map(() => [0x7f])), ...vector(results.map(() => [0x7f]))];
  const body = code => [...uleb(code.length + 1), 0, ...code];
  const exports = [
    ['__stack_pointer', 3, 0], ['__tls_size', 3, 1], ['__tls_align', 3, 2],
    ['__wasm_init_tls', 0, 1], ['wc3_call_context', 0, 2], ['_initialize', 0, 3], ['wc3_context_thread_notify', 0, 4],
    ['wc3_context_depth',0,5],['wc3_context_recover',0,6],
  ].map(([name, kind, index]) => [...str(name), kind, index]);
  const bytes = [0, 97, 115, 109, 1, 0, 0, 0,
    ...section(1, vector([type([0, 0], []), type([0], []), type([0, 0, 0, 0], [0]), type([], []), type([0, 0], [0]),type([0],[0])])),
    ...section(2, vector([[...str('wc3'), ...str('wc3_host_call'), 0, 0], [...str('env'), ...str('memory'), 2, 3, 1, 2]])),
    ...section(3, vector([[1], [2], [3], [4], [5], [0]])),
    ...section(6, vector([[0x7f, 1, 0x41, 0, 0x0b], [0x7f, 0, 0x41, 16, 0x0b], [0x7f, 0, 0x41, 16, 0x0b]])),
    ...section(7, vector(exports)),
    ...section(10, vector([
      body([0x20, 0, 0x41, 37, 0x36, 2, 0, 0x0b]),
      body([0x23,0,0x41,16,0x6b,0x24,0,0x20,1,0x20,0,0x10,0,0x23,0,0x41,16,0x6a,0x24,0,0x20,0,0x28,2,0,0x0b]),
      body([0, 0x0b]),
      body([0x41, 0x80, 0x04, 0x20, 1, 0x36, 2, 0, 0x41, 1, 0x0b]),
      body([0x41,0,0x0b]),
      body([0x41,0x88,0x04,0x23,0,0x36,2,0,0x0b]),
    ])),
  ];
  return new WebAssembly.Module(new Uint8Array(bytes));
}

test('secondary worker initializes stack/TLS and maps normal, thread, process, and fault exits', async t => {
  const module = threadModule();
  for (const mode of ['normal', 'thread', 'process', 'fault']) {
    const memory = new WebAssembly.Memory({initial: 1, maximum: 2, shared: true});
    const options = {module, memory, cpu: 1024, entry: 7, argPointer: 0, argCount: 0, nativeStackTop: 60000, tlsBase: 4096, threadId: 3, clockOrigin: performance.timeOrigin};
    const worker = new Worker(`
      const {parentPort,workerData}=require('node:worker_threads');
      import(workerData.workerURL).then(({runThread})=>runThread(workerData.options,message=>parentPort.postMessage(message)));
    `, {eval: true, workerData: {workerURL, options}});
    t.after(() => worker.terminate());
    const result = await new Promise((resolve, reject) => {
      worker.on('error', reject);
      worker.on('message', message => {
        if (message.type !== 'guest-call') { resolve(message); return; }
        serveGuestCall(message, (id, cpu) => {
          assert.equal(id, 7); assert.equal(cpu, 1024);
          assert.equal(new DataView(memory.buffer).getUint32(4096, true), 37);
          assert.equal(new DataView(memory.buffer).getUint32(512, true), 2);
          if (mode === 'normal') new DataView(memory.buffer).setUint32(cpu, 99, true);
          else throw Object.assign(new Error('fixture failure'), {name: mode === 'thread' ? 'GuestThreadExit' : mode === 'process' ? 'GuestExit' : 'GuestFault', code: 42, details: {mode}});
        }).catch(reject);
      });
    });
    assert.equal(result.threadId, 3);
    if (mode === 'fault') { assert.equal(result.type, 'thread-fault'); assert.equal(result.error.details.mode, mode); }
    else { assert.equal(result.type, mode === 'process' ? 'process-exit' : 'thread-exit'); assert.equal(result.code, mode === 'normal' ? 99 : 42); }
    assert.equal(new DataView(memory.buffer).getUint32(512, true), mode === 'normal' || mode === 'thread' ? 3 : 2);
    assert.equal(new DataView(memory.buffer).getUint32(520, true), mode === 'normal' ? 0 : 60000, 'native stack restored before context recovery');
    await worker.terminate();
  }
});

test('secondary thread reports invalid descriptors without instantiating a fake runtime', async () => {
  const messages = [];
  const result = await runThread({threadId: 9}, message => messages.push(message));
  assert.equal(result.type, 'thread-fault');
  assert.match(result.error.message, /compiled WASM module/);
  assert.deepEqual(messages, [result]);
});

test('a real secondary WASM instance executes eligible imports locally without a broker round trip',async()=>{
  const memory=new WebAssembly.Memory({initial:1,maximum:2,shared:true}),view=new DataView(memory.buffer),cpu=1024;
  view.setUint32(cpu+16,12000,true);view.setUint32(12000,0x401000,true);
  const descriptors=Array(8).fill(null);descriptors[7]={dll:'kernel32.dll',name:'GetCurrentThreadId',argc:0,convention:'stdcall'};
  const counters=new SharedArrayBuffer(32),messages=[];
  const result=await runThread({module:threadModule(),memory,cpu,entry:7,argPointer:0,argCount:0,
    nativeStackTop:60000,tlsBase:4096,threadId:3,guestBase:0,localImports:{descriptors,counters}},m=>messages.push(m));
  assert.equal(result.type,'thread-exit');assert.equal(result.code,3);
  assert.equal(messages.some(m=>m.type==='guest-call'),false);assert.equal(Atomics.load(new Uint32Array(counters),7),1);
  assert.equal(view.getUint32(cpu+16,true),12004);assert.equal(view.getUint32(cpu+32,true),0x401000);
});
