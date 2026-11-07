import {GuestFault,GuestExit,GuestThreadExit} from './host.mjs';
import {serveGuestCall,GuestCallbackBroker,pulseGuestCall} from './thread-rpc.mjs';
import {GraphicsBatchRegistry,GRAPHICS_FLUSH} from './graphics-batch.mjs';

// All Win32 objects belong to this broker. Guest instructions execute in
// separate workers over one shared WASM memory; pending HLE waits release the
// broker event loop so other guest threads can signal them.
export class GuestThreadScheduler {
  constructor(engine,{workerFactory=()=>new Worker(new URL('./thread-worker.mjs',import.meta.url),{type:'module'}),log=()=>{},maxThreads=16,budget=10000000,timeout=60000,batchGraphics=true,vsync=false,maxFps=0}={}) {
    this.engine=engine;this.host=engine.host;this.exports=engine.instance.exports;
    this.workerFactory=workerFactory;this.log=log;this.maxThreads=maxThreads;this.budget=budget;
    this.threads=new Map();this.retired=[];this.nextId=2;this.stopped=false;
    this.timeout=timeout;
    this.callbacks=new GuestCallbackBroker();
    this.host.scheduler=this;
    this.rpcCount=0;
    // Guest workers count their pending synchronous messages here; queued GL
    // work yields to them, so imports never wait for a rendering time slice.
    this.doorbell=new Int32Array(new SharedArrayBuffer(4));
    if(batchGraphics)this.host.graphicsBatchRegistry=new GraphicsBatchRegistry(this.host,{onError:(error,item)=>this.fail(error,item),doorbell:this.doorbell,vsync,maxFps});
  }
  native(item,size,alignment=16) {
    const raw=this.exports.malloc(size+alignment)>>>0;
    if(!raw)throw new GuestFault('Cannot allocate native worker memory',{size});
    (item.nativeAllocations??=[]).push(raw);return Math.ceil(raw/alignment)*alignment;
  }
  descriptor(item) {
    const tlsSize=Number(this.exports.__tls_size.value),tlsAlign=Number(this.exports.__tls_align.value);
    const stack=this.native(item,16*1024*1024,16),tls=this.native(item,tlsSize,Math.max(16,tlsAlign)),args=this.native(item,4);
    this.host.view.setUint32(args,item.arg>>>0,true);
    const descriptors=this.host.thunks.map(({dll,name,argc,convention})=>({dll,name,argc,convention}));
    item.localImports={descriptors,counters:new SharedArrayBuffer(descriptors.length*4)};
    return {module:this.engine.compiledModule,memory:this.host.memory,cpu:item.cpu,entry:item.entry,
      argPointer:args,argCount:item.id===1?0:1,nativeStackTop:stack+16*1024*1024,tlsBase:tls,
      threadId:item.id,clockOrigin:performance.timeOrigin,guestBase:this.host.base,permissionsBase:this.host.permissionsBase,
      processStarted:this.host.started,localImports:item.localImports,
      graphicsBatch:this.host.graphicsBatchRegistry?.buffer,doorbell:this.doorbell.buffer,
      threadState:this.host.threadContexts.get(item.cpu).buffer,tlsSlots:this.host.tlsSlots.buffer};
  }
  create(entry,arg,flags=0,stackSize=0) {
    if(this.stopped)throw new GuestFault('Guest process has stopped');
    if(flags&~4)throw new GuestFault('Unsupported thread creation flags',{flags});
    if(this.threads.size>=this.maxThreads)throw new GuestFault('Guest worker limit reached',{limit:this.maxThreads});
    const size=Math.ceil((stackSize||1024*1024)/65536)*65536;
    if(size<4096||size>16*1024*1024)throw new GuestFault('Unsupported guest thread stack size',{size});
    const id=this.nextId++,item={kind:'thread',id,cpu:0,entry:entry>>>0,arg:arg>>>0,state:flags&4?'suspended':'running',suspendCount:flags&4?1:0,exitCode:259};
    try{
      item.guestStack=this.host.allocAligned(size);item.teb=this.host.allocAligned(8192,4096);
      item.cpu=this.exports.wc3_context_create(id,item.guestStack,size,item.teb)>>>0;
      if(!item.cpu)throw new GuestFault('Cannot allocate guest CPU context');
      this.host.registerContext(item.cpu,id);this.exports.wc3_context_set_budget?.(item.cpu,this.budget);
      this.threads.set(id,item);if(!(flags&4))this.start(item);return item;
    }catch(error){
      // start() only throws before init is successfully posted to a worker.
      item.state='exited';item.worker?.terminate();this.threads.delete(id);this.release(item);throw error;
    }
  }
  resume(item) {
    const previous=item.suspendCount||0;
    if(previous&&!--item.suspendCount){item.state='running';this.start(item);}
    return previous;
  }
  exit(code) { throw new GuestThreadExit(code>>>0); }
  start(item) {
    if(this.stopped||item.worker)return;
    const options=this.descriptor(item),worker=this.workerFactory(item);item.worker=worker;
    const receive=message=>void this.receive(item,message).catch(error=>this.fail(error,item));
    const failed=error=>this.fail(error instanceof Error?error:new GuestFault(error.message||'Guest worker failed'),item);
    if(worker.addEventListener){worker.addEventListener('message',event=>receive(event.data));worker.addEventListener('error',failed);}
    else{worker.on('message',receive);worker.on('error',failed);worker.on('exit',code=>{if(!this.stopped&&item.state!=='exited')failed(new GuestFault('Guest worker exited without a result',{code}));});}
    worker.postMessage({type:'init',options});
  }
  async receive(item,message) {
    if((message.type==='guest-call'||message.type==='guest-callback-result')&&Atomics.load(this.doorbell,0)>0)Atomics.sub(this.doorbell,0,1);
    if(this.stopped||item.state==='exited')return;
    if(message.type==='guest-call'){
      if(message.cpu!==item.cpu)throw new GuestFault('Guest RPC CPU does not belong to its worker',{threadId:item.id});
      item.rpcStack??=[];item.rpcStack.push(message);
      this.rpcCount++;
      let rpcName,rpcStarted;
      if(this.rpcByName){const handler=this.host.thunks[message.id];rpcName=handler?handler.key??=`${handler.dll}!${handler.name}`:message.id===GRAPHICS_FLUSH?'graphics-flush':String(message.id);rpcStarted=performance.now();this.rpcByName.set(rpcName,(this.rpcByName.get(rpcName)||0)+1);}
      try{await serveGuestCall(message,(id,cpu)=>{
        if(message.commands){
          // Pending GL records are queued before the import runs; the host
          // executes them first if the import is graphics-related.
          const registry=this.host.graphicsBatchRegistry;
          if(!registry)throw new GuestFault('Graphics command batching is disabled');
          registry.submit(item,message.commands);
        }
        if(id===GRAPHICS_FLUSH){if(!message.commands)throw new GuestFault('Empty graphics flush');return;}
        return this.host.invokeAsync(id,cpu);
      });}
      finally{
        if(rpcName){const key=rpcName+' ms';this.rpcByName.set(key,(this.rpcByName.get(key)||0)+performance.now()-rpcStarted);}
        if(item.rpcStack.pop()!==message&&!this.stopped)throw new GuestFault('Guest import stack ordering was violated');
      }
    }else if(message.type==='gl-chunk'){
      const registry=this.host.graphicsBatchRegistry;
      if(!registry)throw new GuestFault('Graphics command batching is disabled');
      registry.submit(item,message);
    }else if(message.type==='guest-callback-result'){
      if(message.cpu!==item.cpu)throw new GuestFault('Callback reply CPU does not belong to its worker');
      this.callbacks.complete(message);
    }else if(message.type==='thread-log')this.log(message.message);
    else if(message.type==='thread-exit'){
      if(item.rpcStack?.length)throw new GuestFault('Guest worker exited with pending imports',{threadId:item.id});
      this.host.graphicsBatchRegistry?.drain();
      item.state='exited';item.exitCode=message.code>>>0;
      this.retired.push(this.snapshot(item));if(this.retired.length>64)this.retired.shift();
      // runThread publishes this message only after DLL_THREAD_DETACH and the
      // last WASM call have returned. It never touches shared memory afterwards.
      // Thread handles retain exitCode; neither handles nor waiters own stacks.
      item.worker?.terminate();item.worker=null;
      if(item.localImports){
        const counts=new Uint32Array(item.localImports.counters);
        item.localImports.descriptors.forEach(({dll,name},i)=>{const n=Atomics.load(counts,i);if(n){const key=dll+'!'+name;this.host.calls.set(key,(this.host.calls.get(key)||0)+n);}});
        item.localImports=null;
      }
      this.threads.delete(item.id);this.release(item);this.host.notifyThreadState?.(item);
      this.log(`Guest thread ${item.id} exited (${item.exitCode})`);
      if(item.id===1){this.engine.markReturned();this.resolve?.(item.exitCode);}
    }else if(message.type==='process-exit')this.fail(new GuestExit(message.code>>>0),item);
    else if(message.type==='thread-fault'){
      const error=new GuestFault(message.error?.message||'Guest worker fault',message.error?.details||{});
      error.name=message.error?.name||message.error?.type||'GuestFault';this.fail(error,item);
    }
  }
  release(item){
    if(item.cpu&&item.id!==1){
      if(!this.exports.wc3_context_destroy(item.cpu))throw new GuestFault('Cannot release completed guest CPU',{threadId:item.id});
      this.host.threadContexts.delete(item.cpu);item.cpu=0;
    }
    for(const pointer of item.nativeAllocations||[])this.exports.free(pointer);
    item.nativeAllocations=[];
    for(const key of ['guestStack','teb'])if(item[key]){this.host.free(item[key]);item[key]=0;}
  }
  call(cpu,address,args){
    const item=[...this.threads.values()].find(t=>t.cpu===cpu),message=item?.rpcStack?.at(-1);
    if(this.stopped||!message)throw new GuestFault('Guest callback has no suspended worker',{cpu,address});
    return this.callbacks.call(message,address,args);
  }
  fail(error,item) {
    if(this.stopped)return;
    this.host.lastFaultCPU=item?.cpu;
    if(error.details?.registers)this.host.lastFaultRegisters=error.details.registers;
    error.details={...error.details,threadId:item?.id,cpu:item?.cpu};
    this.reject?.(error);this.stop();
  }
  runMain(name='war3.exe') {
    const {entry,cpu}=this.engine.prepareEntry(name,this.budget);
    const item={kind:'thread',id:1,cpu,entry,arg:0,state:'running',suspendCount:0,exitCode:259};
    this.threads.set(1,item);this.host.registerContext(cpu,1);
    return new Promise((resolve,reject)=>{
      this.settled=false;
      this.resolve=value=>{if(!this.settled){this.settled=true;resolve(value);}};
      this.reject=error=>{if(!this.settled){this.settled=true;reject(error);}};
      // Infinite Win32 waits and long asynchronous operations are valid. The
      // RPC timeout watches broker liveness; the process timeout is separate.
      this.heartbeat=setInterval(()=>{
        for(const thread of this.threads.values())for(const message of thread.rpcStack||[])pulseGuestCall(message);
      },1000);
      if(this.timeout)this.timer=setTimeout(()=>this.fail(new GuestFault('Guest process diagnostic timeout'),item),this.timeout);
      try{this.start(item);}catch(error){this.fail(error,item);}
    });
  }
  stop(reason) {
    if(this.stopped)return;this.stopped=true;clearTimeout(this.timer);clearInterval(this.heartbeat);this.host.graphicsBatchRegistry?.cancel();
    if(!this.settled)this.reject?.(reason||new GuestFault('Guest process stopped'));
    for(const item of this.threads.values())item.worker?.terminate();
    this.host.cancelThreadWaits?.(reason);
    this.callbacks.cancel(reason||new GuestFault('Guest process stopped'));
    // Workers can still be unwinding after terminate(); the process owns its
    // shared memory until all workers are discarded, so do not recycle stacks.
  }
  calls(){
    const result=Object.fromEntries(this.host.calls);
    for(const item of this.threads.values()){
      if(!item.localImports)continue;
      const counters=new Uint32Array(item.localImports.counters);
      item.localImports.descriptors.forEach(({dll,name},i)=>{const n=Atomics.load(counters,i);if(n){const key=dll+'!'+name;result[key]=(result[key]||0)+n;}});
    }
    return Object.fromEntries(Object.entries(result).sort((a,b)=>b[1]-a[1]));
  }
  snapshot({id,cpu,entry,state,exitCode,rpcStack=[]}){
    const registers=Object.fromEntries(['eax','ecx','edx','ebx','esp','ebp','esi','edi','eip'].map((name,i)=>[name,'0x'+this.host.view.getUint32(cpu+i*4,true).toString(16).padStart(8,'0')]));
    const count=this.exports.wc3_context_trace_count(cpu)>>>0,pointer=this.exports.wc3_context_trace_pointer(cpu)>>>0,trace=[];
    for(let i=Math.max(0,count-24);i<count;i++)trace.push('0x'+this.host.view.getUint32(pointer+(i%128)*4,true).toString(16));
    const pending=rpcStack.map(message=>{const handler=this.host.thunks[message.id];return `${handler?.dll}!${handler?.name}`;});
    let stack=[];try{const esp=this.host.view.getUint32(cpu+16,true);stack=Array.from({length:16},(_,i)=>'0x'+this.host.u32(esp+i*4).toString(16));}catch{}
    return {id,cpu,entry,state,exitCode,registers,trace,pending,stack};
  }
  report(){return [...this.retired,...[...this.threads.values()].map(item=>this.snapshot(item))].sort((a,b)=>a.id-b.id);}
}
