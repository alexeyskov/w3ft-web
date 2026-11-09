import {installKernel} from './kernel.mjs';
import {installCRT} from './crt.mjs';
import {installPlatform} from './platform.mjs';
import {FileOverlay} from './persistence.mjs';
import {TlsSlots,threadContext} from './thread-state.mjs';
import {gameResolution,gameGraphics} from './launch-settings.mjs';

export class GuestFault extends Error {
  constructor(message, details = {}) { super(message); this.name = 'GuestFault'; this.details = details; }
}
export class GuestExit extends Error {
  constructor(code) { super(`Guest exited with code ${code}`); this.name = 'GuestExit'; this.code = code; }
}
export class GuestThreadExit extends Error {
  constructor(code) { super(`Guest thread exited with code ${code}`); this.name = 'GuestThreadExit'; this.code = code; }
}

export class WarcraftHost {
  constructor({memory, readFile, readFileLater = null, fileSize, listFiles = () => [], log = () => {}, graphics = null, audio = null, video = null, network = null, clock = () => performance.now(), commandLine = 'war3.exe -opengl -window',tlsSlots,resolution,graphicsSettings,allowLocalFiles=false} = {}) {
    this.memory = memory;
    this.capacity = 0x78000000;
    this.readFile = readFile;
    this.readFileLater = readFileLater; this.importMayWait = false;
    this.fileSize = fileSize;
    this.listFiles = listFiles;
    this.log = log; this.graphics = graphics; this.audio = audio; this.video=video;this.network = network; this.clock = clock;
    this.commandLine = commandLine;
    this.resolution = gameResolution(resolution);
    this.graphicsSettings = gameGraphics(graphicsSettings);
    this.allowLocalFiles = !!allowLocalFiles;
    this.handlers = new Map(); this.thunks = []; this.thunkKeys = new Map(); this.dataSymbols = new Map();
    this.handles = new Map(); this.nextHandle = 0x100; this.allocations = new Map(); this.freeBlocks = [];
    this.defaultContext = threadContext(1); this.threadContexts = new Map();
    this.tlsSlots = new TlsSlots(tlsSlots); this.events = []; this.moduleNames = new Map();
    this.calls = new Map(); this.operations = []; this.started = clock(); this.virtualFiles = new FileOverlay();
    // Last 64 imports, kept without allocating a record for every call.
    this.historyNames = new Array(64); this.historyThreads = new Uint32Array(64); this.historyReturns = new Uint32Array(64); this.historyCount = 0;
    this._attach(memory.buffer);
    installKernel(this); installCRT(this); installPlatform(this);
  }
  attach(instance) {
    this.instance = instance; this.exports = instance.exports;
    this.base = this.exports.wc3_memory_base() >>> 0;
    this.capacity = this.exports.wc3_memory_capacity?.() >>> 0 || this.capacity;
    this.permissionsBase = this.exports.wc3_permissions_pointer?.() >>> 0;
    if(this.exports.wc3_cpu_pointer)this.registerContext(this.exports.wc3_cpu_pointer(),1);
    this.commandPointer = this.string(this.commandLine);
    this.dataSymbols.set('msvcr80.dll!_acmdln', this.alloc(4));
    this.w32(this.dataSymbols.get('msvcr80.dll!_acmdln'), this.commandPointer);
    for (const name of ['_adjust_fdiv', '_fmode', '_commode']) this.dataSymbols.set(`msvcr80.dll!${name}`, this.alloc(4));
    const huge = this.alloc(8); this.view.setFloat64(this.base + huge, Infinity, true); this.dataSymbols.set('msvcr80.dll!_HUGE', huge);
  }
  // Views are cached per buffer object. Shared memory returns a new buffer
  // object after growth (also by another thread), which refreshes them.
  _attach(buffer) { this._buffer = buffer; this._length = buffer.byteLength; this._view = new DataView(buffer); this._bytes = new Uint8Array(buffer); this._i32 = new Int32Array(buffer, 0, Math.floor(buffer.byteLength / 4)); }
  get bytes() { const buffer = this.memory.buffer; if (buffer !== this._buffer) this._attach(buffer); return this._bytes; }
  get view() { const buffer = this.memory.buffer; if (buffer !== this._buffer) this._attach(buffer); return this._view; }
  get history() {
    const count = Math.min(this.historyCount, 64), first = this.historyCount - count, result = new Array(count);
    for (let i = 0; i < count; i++) { const slot = (first + i) & 63; result[i] = {name: this.historyNames[slot], threadId: this.historyThreads[slot], returnAddress: this.historyReturns[slot]}; }
    return result;
  }
  recordCall(name, threadId, returnAddress) {
    const slot = this.historyCount++ & 63;
    this.historyNames[slot] = name; this.historyThreads[slot] = threadId; this.historyReturns[slot] = returnAddress;
  }
  get threadContext() { return this.threadContexts.get(this.currentCPU) || this.defaultContext; }
  get threadId() { return this.threadContext.id; }
  get lastError() { return this.threadContext.lastError; }
  set lastError(value) { this.threadContext.lastError = value; }
  get tls() { return this.threadContext.tls; }
  registerContext(cpu,id,buffer) {
    const existing=this.threadContexts.get(cpu>>>0);
    if(existing){
      if(existing.id!==id||buffer&&existing.buffer!==buffer)throw new GuestFault('Guest CPU already has a different thread context');
      return existing;
    }
    const context=buffer?threadContext(id,buffer):id===1?this.defaultContext:threadContext(id);
    if(id===1)this.defaultContext=context;
    this.threadContexts.set(cpu>>>0,context);return context;
  }
  // After check() the cached _view/_bytes cover the whole returned range.
  check(address, length = 1) {
    address >>>= 0;
    if (!Number.isSafeInteger(length) || length < 0 || address + length > this.capacity) throw new GuestFault('Guest memory access outside address space', {address, length});
    const end = this.base + address + length;
    if (end > this._length) {
      const buffer = this.memory.buffer; if (buffer !== this._buffer) this._attach(buffer);
      if (end > this._length) throw new GuestFault('Guest memory access outside address space', {address, length});
    }
    if (this.permissionsBase && length) {
      const first=address>>>12,last=(address+length-1)>>>12,bytes=this._bytes,map=this.permissionsBase;
      for(let page=first;page<=last;page++)if(!(bytes[map+(page>>>3)]&(1<<(page&7))))throw new GuestFault('Guest access to reserved or no-access page',{address,length});
    }
    return this.base + address;
  }
  u8(p) { const at = this.check(p); return this._view.getUint8(at); }
  u16(p) { const at = this.check(p, 2); return this._view.getUint16(at, true); }
  u32(p) { const at = this.check(p, 4); return this._view.getUint32(at, true); }
  i32(p) { const at = this.check(p, 4); return this._view.getInt32(at, true); }
  w8(p, v) { const at = this.check(p); this._view.setUint8(at, v); }
  w16(p, v) { const at = this.check(p, 2); this._view.setUint16(at, v, true); }
  w32(p, v) { const at = this.check(p, 4); this._view.setUint32(at, v >>> 0, true); }
  copyOut(p, size) { const at = this.check(p, size); return this._bytes.slice(at, at + size); }
  copyIn(p, data) { const at = this.check(p, data.byteLength); this._bytes.set(data, at); }
  zero(p, size) { const at = this.check(p, size); this._bytes.fill(0, at, at + size); }
  cstr(p, maximum = 65536) {
    if (!p) return '';
    const start = this.check(p), bytes = this.bytes;
    let end = start;
    while (end < bytes.length && end - start < maximum && bytes[end]) end++;
    if (end - start === maximum || end === bytes.length) throw new GuestFault('Unterminated guest string', {address: p});
    this.check(p,end-start+1);
    return new TextDecoder('windows-1252').decode(bytes.slice(start, end));
  }
  wide(p, maximum = 32768) {
    if (!p) return ''; let s = '';
    for (let i = 0; i < maximum; i++) { const ch = this.u16(p + i * 2); if (!ch) return s; s += String.fromCharCode(ch); }
    throw new GuestFault('Unterminated wide guest string', {address: p});
  }
  string(value) { const data = new TextEncoder().encode(value + '\0'); const p = this.alloc(data.length); this.copyIn(p, data); return p; }
  writeString(p, value, capacity) {
    const data = new TextEncoder().encode(value);
    if (!capacity) return data.length;
    const count = Math.min(data.length, capacity - 1); this.copyIn(p, data.subarray(0, count)); this.w8(p + count, 0); return count;
  }
  nativeString(pointer) {
    if (!pointer) return null;
    const bytes = this.bytes; let end = pointer >>> 0;
    while (end < bytes.length && end - (pointer >>> 0) < 65536 && bytes[end]) end++;
    return new TextDecoder().decode(bytes.slice(pointer >>> 0, end));
  }
  withNativeString(value, fn) {
    if (value === null) return fn(0);
    const data = new TextEncoder().encode(value + '\0'); const p = this.exports.malloc(data.length) >>> 0;
    if (!p) throw new GuestFault('Host allocation failed');
    this.bytes.set(data, p); try { return fn(p); } finally { this.exports.free(p); }
  }
  alloc(size) { return this.allocate(size,16); }
  heapStats(){
    let liveBytes=0,freeBytes=0,largestFreeBlock=0;
    for(const size of this.allocations.values())liveBytes+=size;
    for(const block of this.freeBlocks){freeBytes+=block.size;largestFreeBlock=Math.max(largestFreeBlock,block.size);}
    return {liveBytes,liveBlocks:this.allocations.size,freeBytes,freeBlocks:this.freeBlocks.length,largestFreeBlock};
  }
  insertFree(address,size){
    if(!size)return;
    let low=0,high=this.freeBlocks.length;
    while(low<high){const mid=(low+high)>>>1;if(this.freeBlocks[mid].address<address)low=mid+1;else high=mid;}
    const before=this.freeBlocks[low-1];
    if(before&&before.address+before.size>address)throw new GuestFault('Overlapping guest free blocks');
    if(before&&before.address+before.size===address){address=before.address;size+=before.size;this.freeBlocks.splice(--low,1);}
    const after=this.freeBlocks[low];
    if(after&&address+size>after.address)throw new GuestFault('Overlapping guest free blocks');
    if(after&&address+size===after.address){size+=after.size;this.freeBlocks.splice(low,1);}
    this.freeBlocks.splice(low,0,{address,size});
  }
  allocate(size,alignment) {
    size >>>= 0;
    if (size > 256 * 1024 * 1024) throw new GuestFault('Unreasonable guest allocation', {size});
    const rounded = Math.max(16, Math.ceil(size / 16) * 16);
    const align=p=>Math.ceil(p/alignment)*alignment;
    const i = this.freeBlocks.findIndex(block => align(block.address)+rounded<=block.address+block.size);
    let address;
    if (i >= 0) {
      const block = this.freeBlocks.splice(i, 1)[0];address=align(block.address);
      this.insertFree(block.address,address-block.address);this.insertFree(address+rounded,block.address+block.size-address-rounded);
    }else{
      const total=rounded+alignment-16,raw=this.exports.wc3_guest_alloc(total)>>>0;
      if(!raw)throw new GuestFault('Guest heap exhausted',{size,alignment,heap:this.heapStats()});
      address=align(raw);this.insertFree(raw,address-raw);this.insertFree(address+rounded,raw+total-address-rounded);
    }
    this.allocations.set(address, rounded); if(this.exports.wc3_protect_guest)this.protect(address,rounded,1); this.zero(address, rounded); return address;
  }
  protect(address,size,access) {
    if(!this.exports.wc3_protect_guest)throw new GuestFault('Guest memory protection runtime is unavailable');
    if(!this.exports.wc3_protect_guest(address,size,access))throw new GuestFault('Invalid guest memory protection range',{address,size,access});
  }
  free(p) { if (!p) return; const size = this.allocations.get(p); if (size === undefined) throw new GuestFault('Invalid guest free', {address: p}); this.allocations.delete(p); this.insertFree(p,size); }
  allocAligned(size, alignment = 65536) {
    if (!Number.isInteger(alignment) || alignment < 16 || alignment > 65536 || alignment & (alignment - 1)) throw new GuestFault('Invalid allocation alignment');
    return this.allocate(size,alignment);
  }
  handle(value) { const id = this.nextHandle;this.nextHandle+=4;this.handles.set(id, value);return id; }
  getHandle(id, kind) { const item = this.handles.get(id); if (!item || kind && item.kind !== kind) { this.lastError = 6; return null; } return item; }
  add(dll, name, argc, fn, convention = 'stdcall') { this.handlers.set(`${dll.toLowerCase()}!${name}`, {dll, name, argc, fn, convention}); }
  resolve(library, name, ordinal = 0) {
    const key = `${library.toLowerCase()}!${name ?? '#' + ordinal}`;
    if (this.dataSymbols.has(key)) return this.dataSymbols.get(key);
    if (this.thunkKeys.has(key)) return 0xf1000000 + this.thunkKeys.get(key) * 16;
    const id = this.thunks.length;
    if (id >= 65536) throw new GuestFault('Import thunk limit');
    this.thunks.push(this.handlers.get(key) || {dll: library, name: name ?? '#' + ordinal, argc: 0, unsupported: true});
    this.graphicsBatchRegistry?.register(id,this.thunks[id]);
    this.thunkKeys.set(key, id);
    return 0xf1000000 + id * 16;
  }
  // call: an object to fill instead of a new one, for a caller that finishes
  // the import before any other runs (invoke); invokeAsync awaits, so it does not.
  beginImport(id, cpuPointer, call = null) {
    const handler = this.thunks[id]; cpuPointer >>>= 0;
    const esp = this.view.getUint32(cpuPointer + 16, true);
    const name = handler ? handler.key ??= `${handler.dll}!${handler.name}` : 'undefined!undefined';
    this.calls.set(name, (this.calls.get(name) || 0) + 1);
    const returnAddress = this.u32(esp), threadContext = this.threadContexts.get(cpuPointer);
    this.recordCall(name, threadContext?.id || 1, returnAddress);
    if (!handler || handler.unsupported) throw new GuestFault(`Unsupported Win32 import: ${name}`, {history: this.history,arguments:Array.from({length:12},(_,i)=>this.u32(esp+4+i*4))});
    // One permission check covers the whole stdcall argument block.
    const argc = handler.argc, args = new Array(argc);
    if (argc) { const at = this.check(esp + 4, argc * 4), view = this._view; for (let i = 0; i < argc; i++) args[i] = view.getUint32(at + i * 4, true); }
    let operation;
    if(handler.tracked ??= /(?:CreateFile|ReadFile|WriteFile|CreateIoCompletionPort|SetFilePointer|GetFileAttributes|GetVolumeInformation|RegOpenKey|RegQueryValue|RegCreateKey|GetProcAddress|LoadLibrary|_fullpath|SetCurrentDirectory)/.test(handler.name)){
      operation={name,threadId:this.threadContexts.get(cpuPointer>>>0)?.id||1,args,returnAddress:this.u32(esp)};
      const stringIndex=/RegOpenKey|RegQueryValue|RegCreateKey|GetProcAddress|_fullpath/.test(handler.name)?1:/CreateFile|GetFileAttributes|GetVolumeInformation|LoadLibrary|SetCurrentDirectory/.test(handler.name)?0:null;
      if(stringIndex!==null&&args[stringIndex]>65535){try{operation.text=handler.name.endsWith('W')?this.wide(args[stringIndex]):this.cstr(args[stringIndex]);}catch{}}
      if(['ReadFile','WriteFile','SetFilePointer'].includes(handler.name)){const file=this.handles.get(args[0]);operation.path=file?.path;operation.position=file?.position;}
      this.operations.push(operation);if(this.operations.length>256)this.operations.shift();
    }
    // Queued GL work from guest workers precedes any graphics-related import,
    // including one made by guest code that this broker is executing.
    if (handler.graphics) this.graphicsBatchRegistry?.drain();
    const previousCPU = this.currentCPU; this.currentCPU = cpuPointer;
    let result;const started=this.hostTimings?performance.now():0;
    try { result = handler.fn(args, esp, cpuPointer);if(result&&typeof result.then==='function')result=result.catch(error=>{throw this._annotate(error,name,args,returnAddress);}); }
    catch(error){throw this._annotate(error,name,args,returnAddress);} finally {
      this.currentCPU = previousCPU;
      if(this.hostTimings&&started){const elapsed=performance.now()-started,entry=this.hostTimings.get(name)||{count:0,totalMs:0,maxMs:0};entry.count++;entry.totalMs+=elapsed;entry.maxMs=Math.max(entry.maxMs,elapsed);this.hostTimings.set(name,entry);}
    }
    const context=threadContext||this.defaultContext;
    if(!call)return {handler,esp,result,operation,returnAddress,context};
    call.handler=handler;call.esp=esp;call.result=result;call.operation=operation;call.returnAddress=returnAddress;call.context=context;return call;
  }
  _annotate(error,name,args,returnAddress){error.details={...error.details,import:name,arguments:args,returnAddress};return error;}
  finishImport(cpuPointer,{handler,esp,operation,context,returnAddress},result) {
    if(operation){operation.result=(result??0)>>>0;operation.lastError=context.lastError;}
    // Calls may grow memory: the view getter refreshes after a callback or wait.
    const view = this.view; cpuPointer >>>= 0;
    view.setUint32(cpuPointer, (result ?? 0) >>> 0, true);
    view.setUint32(cpuPointer + 32, returnAddress ?? this.u32(esp), true);
    view.setUint32(cpuPointer + 16, esp + 4 + (handler.convention === 'stdcall' ? handler.argc * 4 : 0), true);
  }
  invoke(id,cpuPointer) {
    // Hundreds of thousands of calls a second: one call object for all of them.
    const call=this.beginImport(id,cpuPointer,this._call??={});
    if(call.result&&typeof call.result.then==='function'){
      call.result.catch(()=>{});
      throw new GuestFault('Blocking import inside a synchronous guest callback is unsupported',{cpu:cpuPointer>>>0});
    }
    this.finishImport(cpuPointer,call,call.result);
  }
  // importMayWait: the import being run may return a Promise and leave its
  // guest thread waiting (a guest worker's call), unlike one from guest code
  // that this worker runs itself (invoke, call).
  async invokeAsync(id,cpuPointer) {
    try{
      let call;this.importMayWait=true;
      try{call=this.beginImport(id,cpuPointer);}finally{this.importMayWait=false;}
      this.finishImport(cpuPointer,call,await call.result);
    }
    catch(error){this.lastFaultCPU=cpuPointer>>>0;throw error;}
  }
  // Finishes an import after a wait on the guest thread that made it.
  onCPU(cpuPointer,operation){
    const previous=this.currentCPU;this.currentCPU=cpuPointer;
    try{return operation();}finally{this.currentCPU=previous;}
  }
  guestOperation(operation) {
    const cpu=this.currentCPU||(this.exports.wc3_cpu_pointer?.()>>>0),depth=this.exports.wc3_context_depth?.(cpu);
    const nativeStack=this.exports.__stack_pointer?.value;
    try { return operation(cpu); }
    catch(error){
      if(cpu)this.lastFaultRegisters=Object.fromEntries(['eax','ecx','edx','ebx','esp','ebp','esi','edi','eip'].map((name,i)=>[name,'0x'+this.view.getUint32(cpu+i*4,true).toString(16).padStart(8,'0')]));
      if(nativeStack!==undefined)this.exports.__stack_pointer.value=nativeStack;
      if(depth!==undefined)this.exports.wc3_context_recover(cpu,depth);
      throw error;
    }
  }
  call(address, args = []) {
    const p = this.exports.malloc(Math.max(4, args.length * 4)) >>> 0;
    if(!p)throw new GuestFault('Host callback allocation failed');
    for (let i = 0; i < args.length; i++) this.view.setUint32(p + i * 4, args[i] >>> 0, true);
    const mayWait=this.importMayWait;this.importMayWait=false;
    try { return this.guestOperation(cpu=>cpu&&this.exports.wc3_call_context?
      this.exports.wc3_call_context(cpu,address,args.length,p)>>>0:
      this.exports.wc3_call(address,args.length,p)>>>0); }
    finally { this.importMayWait=mayWait; this.exports.free(p); }
  }
  callAsync(address,args=[],cpu=this.currentCPU){
    return this.scheduler?this.scheduler.call(cpu,address,args):Promise.resolve(this.call(address,args));
  }
  initializeLibrary(base) { return this.guestOperation(cpu=>this.exports.wc3_initialize_library(cpu,base)); }
  module(name) { return this.withNativeString(name, p => this.exports.wc3_module(p) >>> 0); }
  proc(base, name, ordinal = 0) { return this.withNativeString(name, p => this.exports.wc3_export(base, p, ordinal) >>> 0); }
  imports() {
    return {env: {memory: this.memory}, wc3: {
      wc3_host_resolve: (dll, name, ordinal) => this.resolve(this.nativeString(dll), this.nativeString(name), ordinal),
      wc3_host_call: (id, cpu) => this.invoke(id, cpu),
      wc3_host_log: p => this.log(this.nativeString(p)), wc3_host_now: () => this.clock(),
      wc3_host_fault: (address, message) => { throw new GuestFault(this.nativeString(message), {address: address >>> 0, history: this.history}); },
    }, wasi_snapshot_preview1: {
      fd_write: (fd, iovs, count, written) => { let out = '', size = 0; for (let i = 0; i < count; i++) { const p = this.view.getUint32(iovs + i*8, true), n = this.view.getUint32(iovs+i*8+4, true); out += new TextDecoder().decode(this.bytes.slice(p,p+n)); size += n; } this.view.setUint32(written,size,true); this.log(out); return 0; },
      proc_exit: code => { throw new GuestExit(code); },
      clock_time_get: (id, precision, p) => { this.view.setBigUint64(p, BigInt(Math.floor((id === 0 ? Date.now() : this.clock()) * 1e6)), true); return 0; },
      random_get: (p, n) => { for (let offset = 0; offset < n; offset += 65536) { const random = crypto.getRandomValues(new Uint8Array(Math.min(65536,n-offset))); this.bytes.set(random,p+offset); } return 0; },
      environ_sizes_get: (count, size) => { this.view.setUint32(count,0,true); this.view.setUint32(size,0,true); return 0; }, environ_get: () => 0,
      fd_close: () => 0, fd_seek: () => 8, fd_fdstat_get: (fd,p) => { this.bytes.fill(0,p,p+24); this.view.setUint8(p,2); return 0; },
      sched_yield: () => 0,
    }};
  }
  report() { return {calls: Object.fromEntries([...this.calls].sort((a,b)=>b[1]-a[1])), recent: this.history, operations:this.operations, networkOperations:this.networkOperations, windows:this.windowState?.(),declaredImports: this.thunks.length, unsupportedImports: this.thunks.filter(h=>h.unsupported).map(h=>`${h.dll}!${h.name}`)}; }
}
