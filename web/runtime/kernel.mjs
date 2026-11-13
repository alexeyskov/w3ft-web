// Stateful Win32 kernel/window/registry services. These execute no native code.
// Operations requiring a guest thread scheduler or a missing renderer fail
// explicitly instead of reporting a successful operation that never happened.
import {GuestFault, GuestExit} from './host.mjs';
import {GameRegistry} from './game-registry.mjs';
import {ThreadServices} from './thread-services.mjs';
import {createFilterGraph} from './directshow.mjs';
import {GAME_RESOLUTIONS} from './launch-settings.mjs';

const INVALID = 0xffffffff, WAIT_TIMEOUT = 258;
const INSTALL = 'C:\\Warcraft III';
const utf8 = new TextEncoder();
const fail = operation => { throw new GuestFault(`${operation} requires an unimplemented guest service`); };

export function installKernel(h) {
  const add = (name, count, fn) => h.add('kernel32.dll', name, count, fn);
  const user = (name, count, fn) => h.add('user32.dll', name, count, fn);
  const gdi = (name, count, fn) => h.add('gdi32.dll', name, count, fn);
  const adv = (name, count, fn) => h.add('advapi32.dll', name, count, fn);
  const error = (code, result = 0) => { h.lastError = code; return result; };
  const heap = h.handle({kind: 'heap', blocks: new Set()});
  const virtual = new Map(), named = new Map(), threads = new ThreadServices(h);
  const mappingFiles = new Map(), mappingViews = new Map(), mappingAccess = new Map();
  let currentDirectory = '', errorMode = 0;
  const directories = new Set(['', 'maps', 'save', 'replay', 'profiles']);
  const inputString = (pointer, wide) => wide ? h.wide(pointer) : h.cstr(pointer);
  for(const[suffix,wide]of[['A',false],['W',true]])user(`MessageBox${suffix}`,4,([window,text,caption,flags])=>{
    const details={window,text:inputString(text,wide),caption:inputString(caption,wide),flags};
    if(h.currentCPU){const esp=h.view.getUint32(h.currentCPU+16,true);details.stack=Array.from({length:384},(_,i)=>'0x'+h.u32(esp+i*4).toString(16));}
    throw new GuestFault(`Guest requested a dialog: ${details.caption}: ${details.text}`,details);
  });
  const writeWide = (pointer, value, capacity) => {
    const length = Math.min(value.length, Math.max(0, capacity - 1));
    for (let i = 0; i < length; i++) h.w16(pointer + i * 2, value.charCodeAt(i));
    if (capacity) h.w16(pointer + length * 2, 0);
    return length;
  };
  const writeText = (pointer, value, capacity, wide = false) => wide ? writeWide(pointer, value, capacity) : h.writeString(pointer, value, capacity);
  const textBytes = (value, wide = false) => {
    if (!wide) return utf8.encode(value + '\0');
    const bytes = new Uint8Array((value.length + 1) * 2), view = new DataView(bytes.buffer);
    for (let i = 0; i < value.length; i++) view.setUint16(i * 2, value.charCodeAt(i), true);
    return bytes;
  };
  const allocText = (value, wide = false) => { const bytes = textBytes(value, wide), pointer = h.alloc(bytes.length); h.copyIn(pointer, bytes); return pointer; };
  const qword = (pointer, value) => { h.w32(pointer, Number(value & 0xffffffffn)); h.w32(pointer + 4, Number(value >> 32n)); };
  const readQword = pointer => BigInt(h.u32(pointer)) | BigInt(h.u32(pointer + 4)) << 32n;
  const filetime = date => BigInt(Math.trunc(date.getTime()) + 11644473600000) * 10000n;

  add('GetLastError', 0, () => h.lastError);
  add('SetLastError', 1, ([value]) => { h.lastError = value; });
  add('GetCurrentProcess', 0, () => INVALID);
  add('GetCurrentThread', 0, () => 0xfffffffe);
  add('GetCurrentProcessId', 0, () => 1);
  add('GetCurrentThreadId', 0, () => h.threadId||1);
  add('GetProcessHeap', 0, () => heap);
  add('GetProcessHeaps', 2, ([count, pointer]) => { const heaps = [...h.handles].filter(([, item]) => item.kind === 'heap').map(([id]) => id); for (let i = 0; i < Math.min(count, heaps.length); i++) h.w32(pointer + i * 4, heaps[i]); return heaps.length; });
  add('HeapCreate', 3, () => h.handle({kind: 'heap', blocks: new Set()}));
  add('HeapDestroy', 1, ([id]) => { const item = h.getHandle(id, 'heap'); if (!item || id === heap) return error(6); for (const pointer of item.blocks) if (h.allocations.has(pointer)) h.free(pointer); h.handles.delete(id); return 1; });
  add('HeapAlloc', 3, ([id, flags, size]) => { const item = h.getHandle(id, 'heap'); if (!item) return 0; const pointer = h.alloc(size); item.blocks.add(pointer); return pointer; });
  add('HeapFree', 3, ([id, flags, pointer]) => { const item = h.getHandle(id, 'heap'); if (!item || !item.blocks.has(pointer)) return error(6); h.free(pointer); item.blocks.delete(pointer); return 1; });
  add('HeapSize', 3, ([id, flags, pointer]) => { const item = h.getHandle(id, 'heap'); return item?.blocks.has(pointer) ? h.allocations.get(pointer) : error(6, INVALID); });
  add('HeapReAlloc', 4, ([id, flags, pointer, size]) => {
    const item = h.getHandle(id, 'heap'); if (!item?.blocks.has(pointer)) return error(6);
    const previous = h.allocations.get(pointer); if (size <= previous) return pointer;
    if (flags & 16) return error(8);
    const replacement = h.alloc(size); h.copyIn(replacement, h.copyOut(pointer, previous)); h.free(pointer);
    item.blocks.delete(pointer); item.blocks.add(replacement); return replacement;
  });
  for (const name of ['HeapLock', 'HeapUnlock']) add(name, 1, ([id]) => h.getHandle(id, 'heap') ? 1 : 0);
  add('HeapValidate', 3, ([id, flags, pointer]) => { const item = h.getHandle(id, 'heap'); return item && (!pointer || item.blocks.has(pointer)) ? 1 : error(6); });
  for (const prefix of ['Global', 'Local']) {
    add(`${prefix}Alloc`, 2, ([flags, size]) => {
      const pointer = h.alloc(size);
      return flags & 2 ? h.handle({kind: 'movable-memory', pointer, locks: 0}) : pointer;
    });
    add(`${prefix}Lock`, 1, ([value]) => { const item = h.handles.get(value); if (item?.kind === 'movable-memory') { item.locks++; return item.pointer; } return h.allocations.has(value) ? value : error(6); });
    add(`${prefix}Unlock`, 1, ([value]) => { const item = h.handles.get(value); if (!item || item.kind !== 'movable-memory' || !item.locks) return error(158); item.locks--; h.lastError = 0; return item.locks ? 1 : 0; });
    add(`${prefix}Size`, 1, ([value]) => { const pointer = h.handles.get(value)?.pointer ?? value; return h.allocations.get(pointer) ?? error(6); });
    add(`${prefix}Free`, 1, ([value]) => { if (!value) return 0; const item = h.handles.get(value), pointer = item?.kind === 'movable-memory' ? item.pointer : value; if (!h.allocations.has(pointer)) return error(6, value); h.free(pointer); if (item?.kind === 'movable-memory') h.handles.delete(value); return 0; });
  }
  add('GlobalHandle', 1, ([pointer]) => { for (const [id, value] of h.handles) if (value.kind === 'movable-memory' && value.pointer === pointer) return id; return h.allocations.has(pointer) ? pointer : error(6); });
  add('VirtualAlloc', 4, ([address, size, flags, protection]) => {
    if (!size || !(flags & 0x3000)) return error(87);
    if (![1,4,0x40].includes(protection)) throw new GuestFault('VirtualAlloc access protection is unsupported', {address,size,flags,protection});
    const commit = (base,region,start,end) => {
      for(let page=start;page<end;page+=4096){
        const offset=page-base;
        if(!region.pages.has(offset)){h.protect(page,4096,1);h.zero(page,4096);}
        region.pages.set(offset,protection);h.protect(page,4096,protection===1?0:1);
      }
    };
    if (address) {
      const page = Math.floor(address/4096)*4096, end = Math.ceil((address+size)/4096)*4096;
      for (const [base,region] of virtual) if (page>=base && end<=base+region.size && flags & 0x1000 && !(flags & 0x2000)) {
        commit(base,region,page,end);return page;
      }
      return error(487);
    }
    const length = Math.ceil(size / 4096) * 4096, pointer = h.allocAligned(length, flags & 0x2000 ? 65536 : 4096);
    const region={size:length,protection,pages:new Map()};virtual.set(pointer,region);h.protect(pointer,length,0);
    if(flags&0x1000)commit(pointer,region,pointer,pointer+length);return pointer;
  });
  add('VirtualFree', 3, ([address, size, flags]) => {
    if(flags===0x8000&&size===0){const region=virtual.get(address);if(!region)return error(487);h.protect(address,region.size,0);h.free(address);virtual.delete(address);return 1;}
    if(flags===0x4000){
      for(const[base,region]of virtual)if(address>=base&&address<base+region.size){
        const start=Math.floor(address/4096)*4096,end=size?Math.ceil((address+size)/4096)*4096:base+region.size;
        if(end>base+region.size||(!size&&address!==base))return error(487);
        for(let page=start;page<end;page+=4096)region.pages.delete(page-base);h.protect(start,end-start,0);return 1;
      }
      return error(487);
    }
    return error(87);
  });
  add('VirtualProtect', 4, ([address, size, protection, previous]) => {
    if (!previous || !size) return error(87);
    let region,allocation;
    for (const [base, value] of virtual) if (address >= base && address + size <= base + value.size) { region = value;allocation=base;break; }
    if (!region) return error(487);
    if (![1,4,0x40].includes(protection)) fail('VirtualProtect access enforcement');
    const start=Math.floor(address/4096)*4096,end=Math.ceil((address+size)/4096)*4096;
    for(let page=start;page<end;page+=4096)if(!region.pages.has(page-allocation))return error(487);
    h.w32(previous,region.pages.get(start-allocation));
    for(let page=start;page<end;page+=4096)region.pages.set(page-allocation,protection);
    h.protect(start,end-start,protection===1?0:1);return 1;
  });
  add('VirtualQuery', 3, ([address, output, length]) => {
    if (length < 28) return error(87);
    for (const [base, value] of virtual) if (address >= base && address < base + value.size) {
      const start=Math.floor((address-base)/4096)*4096,protection=value.pages.get(start);let end=start+4096;
      while(end<value.size&&value.pages.get(end)===protection)end+=4096;
      [base+start, base, value.protection, end-start, protection===undefined?0x2000:0x1000, protection??0, 0x20000].forEach((v, i) => h.w32(output + i * 4, v)); return 28;
    }
    for(const views of mappingViews.values())for(const view of views)if(address>=view.base&&address<view.base+view.size){
      const page=Math.floor(address/4096)*4096,end=Math.ceil((view.base+view.size)/4096)*4096;
      [page,view.base,view.private?8:4,end-page,0x1000,view.private?8:4,0x40000].forEach((value,index)=>h.w32(output+index*4,value));return 28;
    }
    return error(487);
  });
  for (const name of ['VirtualLock', 'VirtualUnlock']) add(name, 2, () => fail(`${name} page residency`));
  add('FlushInstructionCache', 3, ([process, address, length]) => { if (address && length) h.check(address, length); return 1; });
  add('TlsAlloc', 0, () => {
    const id=h.tlsSlots.available();if(id<0)return error(8,INVALID);
    // Initialize every extant thread before publishing a newly allocated slot.
    h.defaultContext.tls.delete(id);for(const context of h.threadContexts.values())context.tls.delete(id);
    h.tlsSlots.add(id);return id;
  });
  add('TlsFree', 1, ([id]) => {if(!h.tlsSlots.delete(id))return error(87);h.defaultContext.tls.delete(id);for(const context of h.threadContexts.values())context.tls.delete(id);return 1;});
  add('TlsSetValue', 2, ([id, value]) => { if (!h.tlsSlots.has(id)) return error(87); h.tls.set(id, value); return 1; });
  add('TlsGetValue', 1, ([id]) => { if (!h.tlsSlots.has(id)) return error(87); h.lastError = 0; return h.tls.get(id)||0; });
  // Other workers execute guest LOCK instructions concurrently with the
  // broker, so serializing JS handlers alone cannot make these operations atomic.
  const atomicWord=pointer=>{const address=h.check(pointer,4);if(address&3)throw new GuestFault('Unaligned Interlocked operand',{address:pointer});return new Uint32Array(h.memory.buffer,address,1);};
  add('InterlockedIncrement',1,([pointer])=>(Atomics.add(atomicWord(pointer),0,1)+1)>>>0);
  add('InterlockedDecrement',1,([pointer])=>(Atomics.sub(atomicWord(pointer),0,1)-1)>>>0);
  add('InterlockedExchange',2,([pointer,value])=>Atomics.exchange(atomicWord(pointer),0,value));
  add('InterlockedExchangeAdd',2,([pointer,value])=>Atomics.add(atomicWord(pointer),0,value));
  add('InterlockedCompareExchange',3,([pointer,value,comparand])=>Atomics.compareExchange(atomicWord(pointer),0,comparand,value));
  add('InitializeCriticalSection',1,([pointer])=>threads.initializeCritical(pointer));
  add('InitializeCriticalSectionAndSpinCount',2,([pointer,spin])=>{threads.initializeCritical(pointer,spin);return 1;});
  add('EnterCriticalSection',1,([pointer])=>threads.enterCritical(pointer));
  add('TryEnterCriticalSection',1,([pointer])=>threads.enterCritical(pointer,true));
  add('LeaveCriticalSection',1,([pointer])=>threads.leaveCritical(pointer));
  add('DeleteCriticalSection',1,([pointer])=>threads.deleteCritical(pointer));

  const namedObject = (kind, pointer, factory, open = false) => {
    const name = pointer ? h.cstr(pointer) : null;
    let object = name ? named.get(name) : null;
    if (object && object.kind !== kind) return error(6);
    if (!object && open) return error(2);
    h.lastError = object ? 183 : 0;
    if (!object) { object = {...factory(), kind, name}; if (name) named.set(name, object); }
    return h.handle(object);
  };
  add('CreateEventA', 4, ([security, manual, signal, name]) => namedObject('event', name, () => ({manual: !!manual, signal: !!signal})));
  add('OpenEventA', 3, ([access, inherit, name]) => namedObject('event', name, null, true));
  add('SetEvent', 1, ([id]) => { const item = h.getHandle(id, 'event'); if (!item) return 0; item.signal = true;threads.notify();return 1; });
  add('ResetEvent', 1, ([id]) => { const item = h.getHandle(id, 'event'); if (!item) return 0; item.signal = false; return 1; });
  add('CreateMutexA', 3, ([security, owned, name]) => namedObject('mutex', name, () => ({owner:owned?(h.threadId||1):0,recursion: owned ? 1 : 0})));
  add('OpenMutexA', 3, ([access, inherit, name]) => namedObject('mutex', name, null, true));
  add('ReleaseMutex', 1, ([id]) => { const item = h.getHandle(id, 'mutex'); if (!item) return 0; if (!item.recursion||item.owner!==(h.threadId||1)) return error(288);item.recursion--;if(!item.recursion)item.owner=0;threads.notify();return 1; });
  add('CreateSemaphoreA', 4, ([security, initial, maximum, name]) => initial > maximum || !maximum || maximum>0x7fffffff ? error(87) : namedObject('semaphore', name, () => ({count: initial, maximum})));
  add('ReleaseSemaphore', 3, ([id, count, previous]) => { const item = h.getHandle(id, 'semaphore'); if (!item) return 0; if (!count || count > item.maximum - item.count) return error(298); if (previous) h.w32(previous, item.count); item.count += count;threads.notify();return 1; });
  add('WaitForSingleObject',2,([id,timeout])=>threads.wait([id],false,timeout));
  add('WaitForMultipleObjects', 4, ([count, pointer, all, timeout]) => {
    if (!count || count > 64) return error(87, INVALID);
    const ids = Array.from({length: count}, (_, i) => h.u32(pointer + i * 4));
    if (new Set(ids).size !== count) return error(87, INVALID);
    return threads.wait(ids,!!all,timeout);
  });
  add('WaitForSingleObjectEx',3,([id,timeout,alertable])=>{if(alertable)fail('Alertable wait/APC delivery');return threads.wait([id],false,timeout);});
  add('WaitForMultipleObjectsEx',5,([count,pointer,all,timeout,alertable])=>{if(alertable)fail('Alertable wait/APC delivery');return h.handlers.get('kernel32.dll!WaitForMultipleObjects').fn([count,pointer,all,timeout]);});
  add('Sleep',1,([milliseconds])=>threads.sleep(milliseconds));
  add('CreateThread',6,([security,stack,entry,arg,flags,id])=>threads.create(entry,arg,flags,stack,id));
  add('ResumeThread',1,([id])=>threads.resume(id));
  add('GetExitCodeThread',2,([id,output])=>{const item=threads.thread(id);if(!item)return 0;h.w32(output,item.state==='exited'?item.exitCode:259);return 1;});
  for(const[name,argc]of[['SuspendThread',1],['TerminateThread',2],['CreateProcessA',10]])add(name,argc,()=>fail(name));
  add('SetThreadPriority',2,([id,priority])=>{const item=threads.thread(id);if(!item)return 0;item.priority=priority;return 1;});
  add('GetThreadPriority',1,([id])=>{const item=threads.thread(id);return item?(item.priority||0):error(6,0x7fffffff);});
  add('ExitProcess', 1, ([code]) => { throw new GuestExit(code); });
  add('ExitThread',1,([code])=>threads.exit(code));
  add('TerminateProcess', 2, ([process, code]) => { if (process !== INVALID) return error(6); throw new GuestExit(code); });
  add('CloseHandle', 1, ([id]) => { const object = h.getHandle(id); if (!object) return 0; h.handles.delete(id);mappingAccess.delete(id); if(object.kind==='mapping')releaseMapping(object);else if (object.name && ![...h.handles.values()].includes(object)) named.delete(object.name); return 1; });
  add('DuplicateHandle', 7, ([sourceProcess, source, targetProcess, target, access, inherit, options]) => { const item = h.getHandle(source); if (!item || !target) return error(6);const id=h.handle(item);if(item.kind==='mapping')mappingAccess.set(id,options&2?mappingAccess.get(source):access);h.w32(target,id); if (options & 1){h.handles.delete(source);mappingAccess.delete(source);} return 1; });
  add('CreateIoCompletionPort',4,([file,existing,key,concurrency])=>{
    const item=file===INVALID?null:h.network?.sockets.get(file)||h.getHandle(file,'file');
    if(file!==INVALID&&!item)return 0;
    const port=existing?h.getHandle(existing,'completion-port'):{kind:'completion-port',queue:[]};if(!port)return 0;
    if(item?.port&&item.port!==port)return error(87);
    if(item){item.port=port;item.completionKey=key;}
    return existing||h.handle(port);
  });
  add('PostQueuedCompletionStatus',4,([id,bytes,key,overlapped])=>{const port=h.getHandle(id,'completion-port');if(!port)return 0;port.queue.push({bytes,key,overlapped});threads.notify();return 1;});
  add('GetQueuedCompletionStatus',5,([id,bytes,key,overlapped,timeout])=>{
    const port=h.getHandle(id,'completion-port'),context=threads.context();if(!port)return 0;
    const check=()=>{const packet=port.queue.shift();if(!packet)return null;
      if(packet.status!==undefined){h.w32(packet.overlapped,packet.status);h.w32(packet.overlapped+4,packet.bytes);}
      h.w32(bytes,packet.bytes);h.w32(key,packet.key);h.w32(overlapped,packet.overlapped);
      if(packet.error){context.lastError=packet.error;return 0;}return 1;
    };
    return threads.until(check,timeout,()=>{h.w32(overlapped,0);context.lastError=WAIT_TIMEOUT;return 0;});
  });

  add('GetTickCount', 0, () => Math.floor(h.clock() - h.started) >>> 0);
  h.add('winmm.dll','timeGetTime',0,()=>Math.floor(h.clock()-h.started)>>>0);
  add('QueryPerformanceFrequency', 1, ([pointer]) => { qword(pointer, 1000000n); return 1; });
  add('QueryPerformanceCounter', 1, ([pointer]) => { qword(pointer, BigInt(Math.floor(h.clock() * 1000))); return 1; });
  add('GetSystemTimeAsFileTime', 1, ([pointer]) => qword(pointer, filetime(new Date())));
  const systemTime = (pointer, date) => [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDay(), date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds()].forEach((value, i) => h.w16(pointer + i * 2, value));
  for (const name of ['GetSystemTime', 'GetLocalTime']) add(name, 1, ([pointer]) => systemTime(pointer, new Date()));
  add('SystemTimeToFileTime', 2, ([input, output]) => { const value = i => h.u16(input + i * 2), date = new Date(Date.UTC(value(0), value(1) - 1, value(3), value(4), value(5), value(6), value(7))); if (date.getUTCFullYear() !== value(0) || date.getUTCMonth() !== value(1) - 1 || date.getUTCDate() !== value(3) || value(4) > 23 || value(5) > 59 || value(6) > 59 || value(7) > 999 || value(0) < 1601) return error(87); qword(output, filetime(date)); return 1; });
  add('FileTimeToSystemTime', 2, ([input, output]) => { const date = new Date(Number(readQword(input) / 10000n) - 11644473600000); if (!Number.isFinite(date.getTime())) return error(87); systemTime(output, date); return 1; });
  for (const name of ['FileTimeToLocalFileTime', 'LocalFileTimeToFileTime']) add(name, 2, ([input, output]) => { h.copyIn(output, h.copyOut(input, 8)); return 1; });
  add('CompareFileTime', 2, ([a, b]) => readQword(a) < readQword(b) ? -1 : readQword(a) > readQword(b) ? 1 : 0);
  add('GetTimeZoneInformation', 1, ([pointer]) => { h.zero(pointer, 172); writeWide(pointer + 4, 'UTC', 32); return 0; });
  add('GetVersion', 0, () => 0x0a280105); // Windows XP 5.1 build 2600 virtual ABI.
  add('GetVersionExA', 1, ([pointer]) => { const length = h.u32(pointer); if (length < 148) return error(87); h.zero(pointer + 4, length - 4); h.w32(pointer + 4, 5); h.w32(pointer + 8, 1); h.w32(pointer + 12, 2600); h.w32(pointer + 16, 2); h.writeString(pointer + 20, 'Service Pack 3', 128); if (length >= 156) h.w16(pointer + 148, 3); return 1; });
  add('GetSystemInfo', 1, ([pointer]) => { h.zero(pointer, 36); h.w16(pointer, 0); h.w32(pointer + 4, 4096); h.w32(pointer + 8, 0x10000); h.w32(pointer + 12, h.capacity - 1); h.w32(pointer + 16, 1); h.w32(pointer + 20, 1); h.w32(pointer + 24, 586); h.w32(pointer + 28, 65536); h.w16(pointer + 32, 6); });
  for(const[suffix,wide]of[['A',false],['W',true]])add(`GetVolumeInformation${suffix}`,8,([root,label,labelSize,serial,maxComponent,flags,filesystem,filesystemSize])=>{
    const path=root?inputString(root,wide).replaceAll('/','\\').toLowerCase():'c:\\';
    if(path!=='c:\\')return error(15);
    const volume='Warcraft Web',format='WC3VFS';
    if(label&&labelSize<=volume.length||filesystem&&filesystemSize<=format.length)return error(234);
    if(label)writeText(label,volume,labelSize,wide);if(filesystem)writeText(filesystem,format,filesystemSize,wide);
    if(serial)h.w32(serial,0x57433301);if(maxComponent)h.w32(maxComponent,255);
    if(flags)h.w32(flags,0x6); // Case-preserving, Unicode names; lookups are case-insensitive.
    return 1;
  });
  add('GlobalMemoryStatus', 1, ([pointer]) => { h.zero(pointer, 32); const used = [...h.allocations.values()].reduce((sum, value) => sum + value, 0), total = h.capacity; [32, Math.floor(100 * used / total), total, total - used, total, total - used, total, total - used].forEach((value, i) => h.w32(pointer + i * 4, value)); });
  add('GetStartupInfoA', 1, ([pointer]) => { h.zero(pointer, 68); h.w32(pointer, 68); });
  add('IsDebuggerPresent', 0, () => 0);
  add('SetErrorMode', 1, ([value]) => { const previous = errorMode; errorMode = value; return previous; });
  add('OutputDebugStringA', 1, ([pointer]) => h.log(h.cstr(pointer)));
  add('OutputDebugStringW', 1, ([pointer]) => h.log(h.wide(pointer)));
  add('FormatMessageA', 7, ([flags, source, messageId, language, output, size, argumentsPointer]) => {
    const systemMessages = new Map([
      [0,'The operation completed successfully.'],[2,'The system cannot find the file specified.'],
      [3,'The system cannot find the path specified.'],[5,'Access is denied.'],[6,'The handle is invalid.'],
      [8,'Not enough memory resources are available to process this command.'],[14,'Not enough storage is available to complete this operation.'],
      [18,'There are no more files.'],[32,'The process cannot access the file because it is being used by another process.'],
      [80,'The file exists.'],[87,'The parameter is incorrect.'],[112,'There is not enough space on the disk.'],
      [122,'The data area passed to a system call is too small.'],[126,'The specified module could not be found.'],
      [127,'The specified procedure could not be found.'],[183,'Cannot create a file when that file already exists.'],
      [193,'%1 is not a valid Win32 application.'],[203,'The system could not find the environment option that was entered.'],
      [234,'More data is available.'],[258,'The wait operation timed out.'],[259,'No more data is available.'],
      [487,'Attempt to access invalid address.'],[1113,'No mapping for the Unicode character exists in the target multi-byte code page.'],
    ]);
    let message;
    if (flags & 0x400) { if (!source) return error(87); message = h.cstr(source); }
    else if (flags & 0x1000 && systemMessages.has(messageId)) message = systemMessages.get(messageId) + '\r\n';
    else return error(317);
    message = message.split('%0')[0];
    if (!(flags & 0x200)) {
      let invalid = false;
      message = message.replace(/%([1-9][0-9]?)(?:!([^!]*)!)?/g, (whole, number, format = 's') => {
        if (!argumentsPointer) { invalid = true; return whole; }
        const value = h.u32(argumentsPointer + (Number(number) - 1) * 4);
        if (format === 's') return h.cstr(value);
        if (format === 'ls' || format === 'S') return h.wide(value);
        const numeric = /^(0?)(\d*)([duxX])$/.exec(format);
        if (!numeric) { invalid = true; return whole; }
        const formatted = numeric[3] === 'd' ? String(value | 0) : numeric[3] === 'u' ? String(value) : value.toString(16);
        const width = Math.min(1024, Number(numeric[2]) || 0);
        return (numeric[3] === 'X' ? formatted.toUpperCase() : formatted).padStart(width, numeric[1] ? '0' : ' ');
      });
      if (invalid) return error(87);
    }
    message = message.replace(/%%|%[nrtb]/g, token => ({'%%':'%','%n':'\r\n','%r':'\r','%t':'\t','%b':' '})[token]);
    const bytes = utf8.encode(message + '\0');
    if (flags & 0x100) { if (!output) return error(87); const pointer = h.alloc(Math.max(size,bytes.length));h.copyIn(pointer,bytes);h.w32(output,pointer); }
    else { if (!output || size < bytes.length) return error(122);h.copyIn(output,bytes); }
    return bytes.length-1;
  });
  add('DisableThreadLibraryCalls',1,([base])=>{if(!base)return error(126);if(!h.exports.wc3_disable_thread_calls)fail('DisableThreadLibraryCalls loader state');return h.exports.wc3_disable_thread_calls(base)?1:error(87);});
  let exceptionFilter = 0;
  add('SetUnhandledExceptionFilter', 1, ([pointer]) => { const previous = exceptionFilter; exceptionFilter = pointer; return previous; });
  add('UnhandledExceptionFilter', 1, () => fail('Windows exception dispatch'));

  const environment = new Map([['PATH', INSTALL], ['TEMP', `${INSTALL}\\Temp`], ['TMP', `${INSTALL}\\Temp`], ['USERNAME', 'Player'], ['WINDIR', 'C:\\Windows']]);
  // The virtual Windows installation uses en-US, consistent with its ANSI
  // code page and registry defaults. Thread locale is independently mutable.
  for(const name of ['GetUserDefaultLCID','GetSystemDefaultLCID','GetUserDefaultLangID','GetSystemDefaultLangID','GetUserDefaultUILanguage','GetSystemDefaultUILanguage'])add(name,0,()=>0x409);
  add('GetThreadLocale',0,()=>h.threadContext.locale||0x409);
  add('SetThreadLocale',1,([locale])=>{if(locale!==0x409&&locale!==0x400&&locale!==0x800)return error(87);h.threadContext.locale=0x409;return 1;});
  // The virtual Windows environment uses en-US/CP1252, consistently with
  // GetUserDefaultLCID, GetACP and SetThreadLocale. Game asset language is
  // independent. These are NLS strings, including the terminating character.
  const localeStrings=new Map([
    [1,'0409'],[2,'English (United States)'],[3,'ENU'],[4,'English'],[5,'1'],[6,'United States'],[7,'USA'],[8,'United States'],
    [9,'0409'],[10,'1'],[11,'437'],[12,','],[13,'1'],[14,'.'],[15,','],[16,'3;0'],[17,'2'],[18,'1'],[19,'0123456789'],
    [20,'$'],[21,'USD'],[22,'.'],[23,','],[24,'3;0'],[25,'2'],[26,'2'],[27,'0'],[28,'0'],[29,'/'],[30,':'],
    [31,'M/d/yyyy'],[32,'dddd, MMMM dd, yyyy'],[33,'0'],[34,'0'],[35,'0'],[40,'AM'],[41,'PM'],
    [0x1001,'English'],[0x1002,'United States'],[0x1004,'1252'],[0x59,'en'],[0x5a,'US'],[0x1003,'h:mm:ss tt'],
  ]);
  // GetDateFormat/GetTimeFormat with the en-US pictures above (the virtual
  // clock is UTC, as GetTimeZoneInformation reports).
  // https://learn.microsoft.com/windows/win32/intl/day--month--year--and-era-format-pictures
  const MONTHS=['January','February','March','April','May','June','July','August','September','October','November','December'];
  const DAYS=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const formatPicture=(picture,fields)=>{
    let result='';
    for(let i=0;i<picture.length;){
      const char=picture[i];
      if(char==="'"&&picture[i+1]==="'"){result+="'";i+=2;continue;} // '' is a quote
      if(char==="'"){
        let end=i+1;for(;end<picture.length;end++){if(picture[end]==="'"){if(picture[end+1]==="'"){result+="'";end++;continue;}break;}result+=picture[end];}
        i=end+1;continue;
      }
      let count=1;while(picture[i+count]===char)count++;
      const value=fields(char,count);result+=value??char.repeat(count);i+=count;
    }
    return result;
  };
  const pad=(value,count)=>String(value).padStart(count,'0');
  const pictureTime=(pointer)=>{
    if(!pointer)return new Date();
    const value=i=>h.u16(pointer+i*2),date=new Date(Date.UTC(value(0),value(1)-1,value(3),value(4),value(5),value(6),value(7)));
    return date.getUTCFullYear()===value(0)&&date.getUTCMonth()===value(1)-1&&date.getUTCDate()===value(3)&&value(4)<24&&value(5)<60&&value(6)<60?date:null;
  };
  const writeFormatted=(text,output,capacity,wide)=>{
    const needed=text.length+1;if(!capacity)return needed;
    if(!output||capacity<needed)return error(122);
    writeText(output,text,needed,wide);return needed;
  };
  for(const[suffix,wide]of[['A',false],['W',true]]){
    add('GetDateFormat'+suffix,6,([locale,flags,time,format,output,capacity])=>{
      if(locale===0)locale=h.threadContext.locale||0x409;
      if(![0x409,0x400,0x800].includes(locale)||capacity>0x7fffffff)return error(87);if(format&&flags&0xff)return error(1004);
      const date=pictureTime(time);if(!date)return error(87);
      const picture=format?inputString(format,wide):localeStrings.get(flags&2?32:31);
      const text=formatPicture(picture,(char,count)=>{
        if(char==='d')return count===1?String(date.getUTCDate()):count===2?pad(date.getUTCDate(),2):count===3?DAYS[date.getUTCDay()].slice(0,3):DAYS[date.getUTCDay()];
        if(char==='M')return count===1?String(date.getUTCMonth()+1):count===2?pad(date.getUTCMonth()+1,2):count===3?MONTHS[date.getUTCMonth()].slice(0,3):MONTHS[date.getUTCMonth()];
        if(char==='y')return count===1?String(date.getUTCFullYear()%100):count===2?pad(date.getUTCFullYear()%100,2):String(date.getUTCFullYear());
        if(char==='g')return 'A.D.';
        return null;
      });
      return writeFormatted(text,output,capacity,wide);
    });
    add('GetTimeFormat'+suffix,6,([locale,flags,time,format,output,capacity])=>{
      if(locale===0)locale=h.threadContext.locale||0x409;
      if(![0x409,0x400,0x800].includes(locale)||capacity>0x7fffffff)return error(87);
      const date=pictureTime(time);if(!date)return error(87);
      let picture=format?inputString(format,wide):localeStrings.get(0x1003);
      if(!format){
        if(flags&1)picture=picture.replace(/:mm:ss/,'');else if(flags&2)picture=picture.replace(/:ss/,'');
        if(flags&4)picture=picture.replace(/ tt/,'');
        if(flags&8)picture=picture.replace(/h/,'H');
      }
      const hours=date.getUTCHours();
      const text=formatPicture(picture,(char,count)=>{
        if(char==='h')return pad(hours%12||12,Math.min(count,2));
        if(char==='H')return pad(hours,Math.min(count,2));
        if(char==='m')return pad(date.getUTCMinutes(),Math.min(count,2));
        if(char==='s')return pad(date.getUTCSeconds(),Math.min(count,2));
        if(char==='t')return (hours<12?'AM':'PM').slice(0,count===1?1:2);
        return null;
      });
      return writeFormatted(text,output,capacity,wide);
    });
  }
  const localeNumbers=new Set([1,5,9,10,11,13,17,18,25,26,27,28,33,34,35,0x1004]);
  for(const[suffix,wide]of[['A',false],['W',true]])add('GetLocaleInfo'+suffix,4,([locale,type,out,capacity])=>{
    if(locale===0)locale=h.threadContext.locale||0x409;
    if(![0x409,0x400,0x800].includes(locale)||capacity>0x7fffffff)return error(87);
    const key=type&0x0fffffff,value=localeStrings.get(key);
    if(type&0x10000000||value===undefined)return error(1004);
    const numeric=!!(type&0x20000000);
    if(numeric&&!localeNumbers.has(key))return error(1004);
    const needed=numeric?(wide?2:4):value.length+1;
    if(!capacity)return needed;
    if(!out||capacity<needed)return error(122);
    if(numeric)h.w32(out,parseInt(value,key===1||key===9?16:10));
    else if(wide){for(let i=0;i<value.length;i++)h.w16(out+i*2,value.charCodeAt(i));h.w16(out+value.length*2,0);}
    else h.writeString(out,value,needed);
    return needed;
  });
  const comInitialize=(reserved,flags)=>{
    if(reserved||flags&~0xe)return 0x80070057;
    const thread=h.threadContext,model=flags&2;
    if(thread.comCount&&thread.comModel!==model)return 0x80010106;
    const existed=!!thread.comCount;thread.comModel=model;thread.comCount=(thread.comCount||0)+1;return existed?1:0;
  };
  h.add('ole32.dll','CoInitialize',1,([reserved])=>comInitialize(reserved,2));
  h.add('ole32.dll','CoInitializeEx',2,([reserved,flags])=>comInitialize(reserved,flags));
  h.add('ole32.dll','CoUninitialize',0,()=>{const thread=h.threadContext;if(thread.comCount)thread.comCount--;});
  h.add('ole32.dll','CoCreateInstance',5,([classId,outer,context,iid,output])=>{
    if(!output)return 0x80004003;h.w32(output,0);
    if(!h.threadContext.comCount)return 0x800401f0;
    h.check(classId,16);h.check(iid,16);
    return createFilterGraph(h,classId,outer,iid,output);
  });
  for(const[name,operation]of[['CoTaskMemAlloc','allocate'],['CoTaskMemFree','free']])h.add('ole32.dll',name,1,([value])=>operation==='allocate'?h.alloc(value):h.free(value));
  for (const [suffix, wide] of [['A', false], ['W', true]]) {
    add(`GetCommandLine${suffix}`, 0, () => wide ? (h.commandWide ??= allocText(h.commandLine, true)) : h.commandPointer);
    add(`GetEnvironmentVariable${suffix}`, 3, ([name, output, length]) => { const value = environment.get(inputString(name, wide).toUpperCase()); if (value === undefined) return error(203); const needed = value.length + 1; if (length < needed) return needed; writeText(output, value, length, wide); return needed - 1; });
    add(`SetEnvironmentVariable${suffix}`, 2, ([name, value]) => { const key = inputString(name, wide).toUpperCase(); if (!key || key.includes('=')) return error(87); if (value) environment.set(key, inputString(value, wide)); else environment.delete(key); return 1; });
    add(`GetEnvironmentStrings${suffix}`, 0, () => allocText([...environment].map(([key, value]) => `${key}=${value}`).join('\0') + '\0', wide));
    add(`FreeEnvironmentStrings${suffix}`, 1, ([pointer]) => { if (!h.allocations.has(pointer)) return error(87); h.free(pointer); return 1; });
    add(`GetComputerName${suffix}`, 2, ([output, length]) => { const name = 'WC3-WEB', capacity = h.u32(length); if (capacity <= name.length) { h.w32(length, name.length + 1); return error(111); } writeText(output, name, capacity, wide); h.w32(length, name.length); return 1; });
    for (const [operation, directory] of [['GetWindowsDirectory', 'C:\\Windows'], ['GetSystemDirectory', 'C:\\Windows\\System32'], ['GetTempPath', `${INSTALL}\\Temp\\`]]) {
      add(`${operation}${suffix}`, 2, args => { const [output, length] = operation === 'GetTempPath' ? [args[1], args[0]] : args; if (length <= directory.length) return directory.length + 1; writeText(output, directory, length, wide); return directory.length; });
    }
  }
  add('GetEnvironmentStrings', 0, () => h.handlers.get('kernel32.dll!GetEnvironmentStringsA').fn([]));
  const virtualModules = new Map();
  const moduleName = name => name.replaceAll('/', '\\').split('\\').at(-1).toLowerCase();
  const moduleHandle = (name, load = false, initialize = false) => {
    if (!name) return h.module('war3.exe');
    let key = moduleName(name); if (!key.includes('.')) key += '.dll';
    const native = h.module(key);
    if (native) {
      if(initialize && !h.initializeLibrary(native))return error(1114);
      if(!initialize && h.exports.wc3_module_initialized && !h.exports.wc3_module_initialized(native))return error(126);
      return native;
    }
    if (virtualModules.has(key)) return virtualModules.get(key);
    if (load && [...h.handlers.keys()].some(value => value.startsWith(key + '!'))) { const handle = h.handle({kind: 'module', name: key}); virtualModules.set(key, handle); return handle; }
    return error(126);
  };
  for (const [suffix, wide] of [['A', false], ['W', true]]) {
    add(`LoadLibrary${suffix}`, 1, ([pointer]) => moduleHandle(inputString(pointer, wide), true, true));
    add(`GetModuleHandle${suffix}`, 1, ([pointer]) => moduleHandle(pointer ? inputString(pointer, wide) : null, true));
    add(`GetModuleFileName${suffix}`, 3, ([base, output, length]) => { if (!length) return error(122); const name = base ? h.moduleNames.get(base) || h.handles.get(base)?.name : 'war3.exe'; if (!name) return error(126); const path = `${INSTALL}\\${name}`; writeText(output, path, length, wide); if (path.length >= length) return error(122, length); return path.length; });
  }
  add('GetProcAddress', 2, ([base, value]) => { const name = value <= 0xffff ? null : h.cstr(value), ordinal = name ? 0 : value; const item = h.handles.get(base); if (item?.kind === 'module') { const key = `${item.name}!${name ?? '#' + ordinal}`; return h.handlers.has(key) || h.dataSymbols.has(key) ? h.resolve(item.name, name, ordinal) : error(127); } return h.proc(base, name, ordinal) || error(127); });
  add('FreeLibrary', 1, ([base]) => { if (!base) return error(6); if (h.moduleNames.has(base) || h.handles.get(base)?.kind === 'module') return 1; return error(6); });

  const resource = (image, name, type, language = 0) => {
    const base = image || h.module('war3.exe');
    if (!base || h.u16(base) !== 0x5a4d) return null;
    const pe = base + h.u32(base+0x3c); if (h.u32(pe)!==0x4550 || h.u16(pe+24)!==0x10b) return null;
    const imageSize=h.u32(pe+24+56),directory=h.u32(pe+24+112),size=h.u32(pe+24+116);
    if(!directory||!size||directory+size>imageSize)return null;
    const at=(offset,length)=>{if(!Number.isSafeInteger(offset)||offset<0||length<0||offset+length>size)throw new GuestFault('Malformed PE resource directory');return base+directory+offset;};
    const entries=offset=>{const pointer=at(offset,16),count=h.u16(pointer+12)+h.u16(pointer+14);at(offset+16,count*8);return Array.from({length:count},(_,i)=>({name:h.u32(pointer+16+i*8),child:h.u32(pointer+20+i*8)}));};
    const lookup=(offset,identifier)=>entries(offset).find(item=>{
      if(!(item.name&0x80000000))return typeof identifier==='number'&&item.name===identifier;
      if(typeof identifier!=='string')return false;
      const pointer=at(item.name&0x7fffffff,2),length=h.u16(pointer);at((item.name&0x7fffffff)+2,length*2);
      let text='';for(let i=0;i<length;i++)text+=String.fromCharCode(h.u16(pointer+2+i*2));return text.toLowerCase()===identifier.toLowerCase();
    });
    const typeEntry=lookup(0,type);if(!typeEntry||!(typeEntry.child&0x80000000))return null;
    const nameEntry=lookup(typeEntry.child&0x7fffffff,name);if(!nameEntry||!(nameEntry.child&0x80000000))return null;
    const languages=entries(nameEntry.child&0x7fffffff),leaf=languages.find(item=>item.name===language)||(!language&&(languages.find(item=>item.name===1033)||languages[0]));
    if(!leaf||(leaf.child&0x80000000))return null;
    const pointer=at(leaf.child,16),offset=h.u32(pointer),length=h.u32(pointer+4);
    if(offset+length>imageSize)throw new GuestFault('Resource data lies outside its PE image');
    return {kind:'resource',base,address:base+offset,size:length,codepage:h.u32(pointer+8)};
  };
  h.findResource = resource;
  for(const[suffix,wide]of[['A',false],['W',true]]) {
    const identifier=pointer=>pointer<=0xffff?pointer:inputString(pointer,wide);
    add(`FindResource${suffix}`,3,([base,name,type])=>{const found=resource(base,identifier(name),identifier(type));return found?h.handle(found):error(1814);});
    add(`FindResourceEx${suffix}`,4,([base,type,name,language])=>{const found=resource(base,identifier(name),identifier(type),language);return found?h.handle(found):error(1814);});
    user(`LoadString${suffix}`,4,([base,id,output,capacity])=>{
      const found=resource(base,Math.floor(id/16)+1,6);if(!found)return error(1814);
      let offset=0;
      for(let i=0;i<16;i++){
        if(offset+2>found.size)throw new GuestFault('Truncated PE string table');
        const length=h.u16(found.address+offset);offset+=2;
        if(offset+length*2>found.size)throw new GuestFault('Truncated PE string resource');
        if(i===(id&15)){
          if(wide&&!capacity){h.w32(output,found.address+offset);return length;}
          let value='';for(let j=0;j<length;j++)value+=String.fromCharCode(h.u16(found.address+offset+j*2));
          return capacity?writeText(output,value,capacity,wide):0;
        }
        offset+=length*2;
      }
      return 0;
    });
  }
  add('LoadResource',2,([base,id])=>{const item=h.getHandle(id,'resource');return item&&(!base||base===item.base)?id:error(6);});
  add('LockResource',1,([id])=>h.getHandle(id,'resource')?.address||0);
  add('SizeofResource',2,([base,id])=>{const item=h.getHandle(id,'resource');return item&&(!base||base===item.base)?item.size:error(6);});
  add('FreeResource',1,()=>0); // Win32 resource mappings remain owned by the module.

  const codepage = cp => cp===0?1252:cp===1?437:cp;
  const oemHigh='ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';
  const decoder = (cp,fatal=false) => {
    cp=codepage(cp);
    if(cp===437)return{decode:bytes=>Array.from(bytes,value=>value<128?String.fromCharCode(value):oemHigh[value-128]).join('')};
    if(cp===20127)return{decode:bytes=>Array.from(bytes,value=>{if(value<128)return String.fromCharCode(value);if(fatal)throw new TypeError('Non-ASCII input');return '\ufffd';}).join('')};
    const labels={1252:'windows-1252',1251:'windows-1251',65001:'utf-8'};if(!labels[cp])throw new GuestFault('Unsupported Windows codepage',{codepage:cp});return new TextDecoder(labels[cp],{fatal,ignoreBOM:true});
  };
  const encodeText = (value,cp,defaultByte=63) => {
    cp=codepage(cp);if(cp===65001)return {data:utf8.encode(value),usedDefault:false};
    const decode=decoder(cp),reverse=new Map();for(let i=0;i<(cp===20127?128:256);i++)reverse.set(decode.decode(Uint8Array.of(i)),i);
    let usedDefault=false;const bytes=[];for(const character of value){let byte=reverse.get(character);if(byte===undefined){byte=defaultByte;usedDefault=true;}bytes.push(byte);}return{data:Uint8Array.from(bytes),usedDefault};
  };
  const rawWide = (pointer,length) => {if(length===0xffffffff)return h.wide(pointer)+'\0';let value='';h.check(pointer,length*2);for(let i=0;i<length;i++)value+=String.fromCharCode(h.u16(pointer+i*2));return value;};
  const rawAnsi = (pointer,length) => {if(length===0xffffffff){let size=0;while(h.u8(pointer+size)){if(++size>1048576)throw new GuestFault('Unterminated encoding input');}length=size+1;}return h.copyOut(pointer,length);};
  add('GetACP',0,()=>1252);
  add('GetOEMCP',0,()=>437);
  add('MultiByteToWideChar',6,([cp,flags,input,length,output,capacity])=>{
    if(!input||!length)return error(87);let value;try{value=decoder(cp,!!(flags&8)).decode(rawAnsi(input,length));}catch(problem){if(problem instanceof GuestFault)throw problem;return error(1113);}
    if(!capacity)return value.length;if(capacity<value.length)return error(122);for(let i=0;i<value.length;i++)h.w16(output+i*2,value.charCodeAt(i));return value.length;
  });
  add('WideCharToMultiByte',8,([cp,flags,input,length,output,capacity,defaultCharacter,usedDefault])=>{
    if(!input||!length||(codepage(cp)===65001&&(defaultCharacter||usedDefault)))return error(87);const value=rawWide(input,length);if(flags&0x80&&value.isWellFormed&&!value.isWellFormed())return error(1113);const encoded=encodeText(value,cp,defaultCharacter?h.u8(defaultCharacter):63);
    if(usedDefault)h.w32(usedDefault,encoded.usedDefault?1:0);if(!capacity)return encoded.data.length;if(capacity<encoded.data.length)return error(122);h.copyIn(output,encoded.data);return encoded.data.length;
  });
  add('GetCPInfo',2,([cp,output])=>{cp=codepage(cp);if(![1252,1251,65001,437,20127].includes(cp))return error(87);h.zero(output,20);h.w32(output,cp===65001?4:1);h.w8(output+4,63);return 1;});
  const characterType = character => (/\p{Lu}/u.test(character)?1:0)|(/\p{Ll}/u.test(character)?2:0)|(/\p{Nd}/u.test(character)?4:0)|(/\s/u.test(character)?8:0)|(/\p{P}/u.test(character)?16:0)|(/[\x00-\x1f\x7f]/.test(character)?32:0)|(/[ \t]/.test(character)?64:0)|(/[0-9a-fA-F]/.test(character)?128:0)|(/\p{L}/u.test(character)?256:0)|512;
  add('GetStringTypeW',4,([type,input,length,output])=>{if(type!==1)fail(`GetStringTypeW classification ${type}`);const value=rawWide(input,length);for(let i=0;i<value.length;i++)h.w16(output+i*2,characterType(value[i]));return 1;});
  add('GetStringTypeA',5,([locale,type,input,length,output])=>{if(type!==1)fail(`GetStringTypeA classification ${type}`);const value=decoder(1252).decode(rawAnsi(input,length));for(let i=0;i<value.length;i++)h.w16(output+i*2,characterType(value[i]));return 1;});
  for(const[suffix,wide]of[['A',false],['W',true]])add(`LCMapString${suffix}`,6,([locale,flags,input,length,output,capacity])=>{
    let value=wide?rawWide(input,length):decoder(1252).decode(rawAnsi(input,length));
    if(flags&~0x300)fail('LCMapString flags');if(flags&0x100)value=value.toLowerCase();if(flags&0x200)value=value.toUpperCase();
    const bytes=wide?null:encodeText(value,1252).data,needed=wide?value.length:bytes.length;if(!capacity)return needed;if(capacity<needed)return error(122);
    if(wide)for(let i=0;i<value.length;i++)h.w16(output+i*2,value.charCodeAt(i));else h.copyIn(output,bytes);return needed;
  });
  add('lstrlenA',1,([pointer])=>h.cstr(pointer).length);
  add('lstrcpynA',3,([output,input,capacity])=>{h.writeString(output,h.cstr(input),capacity);return output;});
  add('lstrcatA',2,([output,input])=>{const value=h.cstr(output)+h.cstr(input);h.copyIn(output,utf8.encode(value+'\0'));return output;});
  add('MulDiv',3,([a,b,c])=>{if(!(c|0))return INVALID;const value=(a|0)*(b|0)/(c|0),rounded=Math.sign(value)*Math.floor(Math.abs(value)+0.5);return rounded<-2147483648||rounded>2147483647?INVALID:rounded;});
  for(const name of ['IsBadReadPtr','IsBadWritePtr'])add(name,2,([address,length])=>{try{if(!address&&length)return 1;h.check(address,length);return 0;}catch{return 1;}});

  // Files live under the configured installation. No path is passed directly
  // to a host filesystem, and traversal never reaches the range provider.
  const pathKey = value => {
    let path = value.replaceAll('\\', '/');
    if (/^[A-Za-z]:/.test(path)) { if (!path.toLowerCase().startsWith('c:/warcraft iii/')) { if (path.toLowerCase() === 'c:/warcraft iii') return ''; throw new GuestFault('Path lies outside the game installation', {path: value}); } path = path.slice(16); }
    else if (path.startsWith('/')) throw new GuestFault('Absolute guest path outside installation', {path: value});
    else if (currentDirectory) path = currentDirectory + '/' + path;
    const parts = path.split('/').filter(part => part !== '' && part !== '.');
    if (parts.some(part => part === '..' || part.includes(':') || /[\x00-\x1f]/.test(part))) throw new GuestFault('Unsafe guest file path', {path: value});
    return parts.join('/').toLowerCase();
  };
  // A hidden entry ({path, hidden:true}) opens by its exact path but is not
  // listed in a folder that has visible content: old save games still find
  // maps recorded under a former folder that the map list no longer shows.
  const entries = () => {
    const result = new Map(), hidden = new Set();
    for (const value of h.listFiles()) {
      const path = typeof value === 'string' ? value : value.path; if (typeof path !== 'string') continue;
      const key = path.replaceAll('\\', '/').toLowerCase(); result.set(key, path);
      if (value.hidden === true) hidden.add(key); else hidden.delete(key);
    }
    for (const key of h.virtualFiles.keys()) { result.set(key, key); hidden.delete(key); }
    result.hidden = hidden;
    return result;
  };
  const info = key => {
    if (h.virtualFiles.has(key)) return {path: key, size: h.virtualFiles.get(key).length};
    const path = entries().get(key); if (path === undefined) return null;
    if (h.fileSize) return {path, size: h.fileSize(path)};
    const data = h.readFile(path); if (!(data instanceof Uint8Array)) return null;
    return {path, size: data.length, data};
  };
  const fileData = (item, offset, count) => {
    const local = h.virtualFiles.get(item.key); if (local) return local.slice(offset, offset + count);
    if (item.data) return item.data.slice(offset, offset + count);
    return h.readFile(item.path, offset, count);
  };
  const fileSize = item => h.virtualFiles.get(item.key)?.length ?? item.size;
  // Mapping references follow Windows object lifetimes: views keep an object
  // alive after its last handle closes. Shared ranges use the same guest bytes,
  // including ranges opened through different mappings of the same file.
  // https://learn.microsoft.com/windows/win32/api/memoryapi/nf-memoryapi-mapviewoffile
  const mappingAlive = key => !!mappingFiles.get(key)?.objects.size;
  const mappingHandle = (object,access=0x000f001f) => {const id=h.handle(object);mappingAccess.set(id,access);return id;};
  const releaseMapping = object => {
    if(object.views.size||[...h.handles.values()].includes(object))return;
    if(object.name)named.delete(object.name);
    const store=object.store;store.objects.delete(object);
    if(store.objects.size)return;
    for(const segment of store.segments){h.protect(segment.base,segment.allocated,0);h.free(segment.base);}
    if(store.file)mappingFiles.delete(store.file.key);
  };
  const mappingBytes = (store,offset,size) => {
    if(!store.file)return new Uint8Array(size);
    const available=Math.max(0,Math.min(size,fileSize(store.file)-offset)),data=new Uint8Array(size);
    if(available){const bytes=fileData(store.file,offset,available);if(!(bytes instanceof Uint8Array)||bytes.length!==available)throw new GuestFault('Truncated file mapping range');data.set(bytes);}
    return data;
  };
  const permissionsForSegment = segment => {
    h.protect(segment.base,segment.allocated,0);
    for(const view of segment.views)h.protect(view.base,Math.ceil(view.size/4096)*4096,1);
  };
  const flushMapping = (view,start,count) => {
    if(view.private||!view.object.store.file)return 1;
    const file=view.object.store.file,offset=view.offset+(start-view.base),size=fileSize(file);
    if(size>128*1024*1024)throw new GuestFault('Writable mappings exceed the virtual file size limit');
    const data=new Uint8Array(size);if(size)data.set(fileData(file,0,size));
    const length=Math.min(count,Math.max(0,size-offset));if(length)data.set(h.copyOut(start,length),offset);
    h.virtualFiles.set(file.key,data);return 1;
  };
  add('CreateFileMappingA',6,([fileId,security,protection,high,low,namePointer])=>{
    const name=namePointer?h.cstr(namePointer):null;
    if(name?.startsWith('Global\\'))fail('Cross-process global file mappings');
    const existing=name?named.get(name):null;
    if(existing){if(existing.kind!=='mapping')return error(6);h.lastError=183;return mappingHandle(existing);}
    const basic=protection&255,attributes=(protection&0xffffff00)>>>0;
    if(![2,4,8,0x20,0x40,0x80].includes(basic))return error(87);
    if(attributes&&attributes!==0x08000000)fail(`CreateFileMapping attributes 0x${attributes.toString(16)}`);
    const maximum=BigInt(high)*0x100000000n+BigInt(low);if(maximum>BigInt(Number.MAX_SAFE_INTEGER))return error(87);
    let file=null,store,size=Number(maximum);
    if(fileId===INVALID){if(!size)return error(87);store={file:null,segments:[],objects:new Set()};}
    else{
      file=h.getHandle(fileId,'file');if(!file)return 0;
      if(!file.reading||([4,0x40].includes(basic)&&!file.writing)||([0x20,0x40,0x80].includes(basic)&&!(file.access&0x20000000)))return error(5);
      const current=fileSize(file);if(!size)size=current;if(!size)return error(1006);
      if(size>current){
        if(!file.writing||![4,0x40].includes(basic))return error(5);
        if(size>128*1024*1024)return error(112);
        const data=new Uint8Array(size);if(current)data.set(fileData(file,0,current));h.virtualFiles.set(file.key,data);
      }
      store=mappingFiles.get(file.key)||{file,segments:[],objects:new Set()};mappingFiles.set(file.key,store);
    }
    const object={kind:'mapping',name,store,size,protection:basic,views:new Set()};store.objects.add(object);if(name)named.set(name,object);h.lastError=0;return mappingHandle(object);
  });
  add('OpenFileMappingA',3,([access,inherit,namePointer])=>{
    const object=named.get(h.cstr(namePointer));if(!object)return error(2);if(object.kind!=='mapping')return error(6);
    if(access&2&&![4,0x40].includes(object.protection))return error(5);return mappingHandle(object,access);
  });
  add('MapViewOfFile',5,([id,access,high,low,count])=>{
    const object=h.getHandle(id,'mapping');if(!object)return 0;
    if(access===0x000f001f)access=2;
    if(access&~0x27)fail(`MapViewOfFile access flags 0x${access.toString(16)}`);
    const copy=!!(access&1),write=!!(access&2),execute=!!(access&0x20);
    if(copy&&write)return error(87);if(!copy&&!write&&!(access&4))return error(87);
    if(copy)fail('Copy-on-write views require per-page write-fault tracking');
    const rights=mappingAccess.get(id)||0;
    if(rights!==0x000f001f&&((write&&!(rights&2))||(!write&&!(rights&4))||(execute&&!(rights&0x20))))return error(5);
    if(write&&![4,0x40].includes(object.protection))return error(5);
    if(execute&&![0x20,0x40,0x80].includes(object.protection))return error(5);
    if(!copy&&!write)fail('Read-only mapped views require separate guest write permissions');
    const rawOffset=BigInt(high)*0x100000000n+BigInt(low);if(rawOffset>BigInt(Number.MAX_SAFE_INTEGER))return error(87);
    const offset=Number(rawOffset);if(offset%65536)return error(1132);
    const size=count||object.size-offset;if(!Number.isSafeInteger(size)||size<=0||offset+size>object.size)return error(87);
    const allocated=Math.ceil(size/4096)*4096;if(allocated>256*1024*1024-65536)return error(8);
    const store=object.store;if(write&&store.file&&fileSize(store.file)>128*1024*1024)fail('Writable mappings exceed the virtual file size limit');
    let segment;
    if(!copy){
      const overlaps=store.segments.filter(item=>offset<item.offset+item.size&&item.offset<offset+size);
      if(overlaps.length){
        if(overlaps.length!==1||offset<overlaps[0].offset||offset+size>overlaps[0].offset+overlaps[0].size)fail('Expanding overlapping mapped views requires guest virtual aliases');
        segment=overlaps[0];
      }
    }
    if(!segment){
      const base=h.allocAligned(allocated,65536);
      try{h.copyIn(base,mappingBytes(store,offset,size));}catch(problem){h.protect(base,allocated,0);h.free(base);throw problem;}
      segment={base,offset,size,allocated,views:new Set()};if(!copy)store.segments.push(segment);
    }
    const base=segment.base+offset-segment.offset,view={object,segment,offset,size,base,private:copy};
    object.views.add(view);segment.views.add(view);if(!mappingViews.has(base))mappingViews.set(base,[]);mappingViews.get(base).push(view);
    permissionsForSegment(segment);return base;
  });
  add('FlushViewOfFile',2,([address,count])=>{
    const view=[...mappingViews.values()].flat().find(item=>address>=item.base&&address<item.base+item.size);
    if(!view)return error(487);const length=count||view.base+view.size-address;if(address+length>view.base+view.size)return error(87);
    return flushMapping(view,address,length);
  });
  add('UnmapViewOfFile',1,([address])=>{
    const views=mappingViews.get(address),view=views?.at(-1);if(!view)return error(487);
    flushMapping(view,view.base,view.size);
    views.pop();if(!views.length)mappingViews.delete(address);view.object.views.delete(view);view.segment.views.delete(view);
    if(view.private){h.protect(view.segment.base,view.segment.allocated,0);h.free(view.segment.base);}else permissionsForSegment(view.segment);
    releaseMapping(view.object);return 1;
  });
  const directoryExists = key => directories.has(key) || [...entries().keys()].some(path => path.startsWith(key ? key + '/' : ''));
  // A folder does not disappear with its last file, as on a real disk.
  const keepFolders = key => { const parts = key.split('/'); for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join('/')); };
  const createFile = (args, wide) => {
    const [name, access, sharing, security, disposition, flags] = args;
    let key; try { key = pathKey(inputString(name, wide)); } catch { return error(5, INVALID); }
    const existing = info(key), writing = !!(access & 0x40000000), reading = !!(access & 0x80000000);
    if (directoryExists(key) && !existing) return error(5, INVALID);
    if (![1,2,3,4,5].includes(disposition)) return error(87, INVALID);
    if (disposition === 1 && existing) return error(80, INVALID);
    if(existing&&[2,5].includes(disposition)&&mappingAlive(key))return error(1224,INVALID);
    if ((disposition === 3 || disposition === 5) && !existing) return error(2, INVALID);
    if ([1,2,5].includes(disposition) && !writing) return error(5, INVALID);
    for (const item of h.handles.values()) if (item.kind === 'file' && item.key === key &&
      ((reading && !(item.sharing & 1)) || (writing && !(item.sharing & 2)) || (item.reading && !(sharing & 1)) || (item.writing && !(sharing & 2)))) return error(32, INVALID);
    if (!existing || [1,2,5].includes(disposition)) h.virtualFiles.set(key, new Uint8Array());
    h.lastError = existing && [2,4].includes(disposition) ? 183 : 0;
    return h.handle({kind: 'file', key, path: existing?.path || key, size: existing?.size || 0, data: existing?.data, position: 0, reading, writing, sharing, access,overlapped:!!(flags&0x40000000),ioSignal:true});
  };
  for (const [suffix, wide] of [['A', false], ['W', true]]) {
    add(`CreateFile${suffix}`, 7, args => createFile(args, wide));
    add(`GetFileAttributes${suffix}`, 1, ([name]) => { let key; try { key = pathKey(inputString(name, wide)); } catch { return error(5, INVALID); } return info(key) ? 0x80 : directoryExists(key) ? 0x10 : error(2, INVALID); });
    add(`CreateDirectory${suffix}`, 2, ([name]) => { let key; try { key = pathKey(inputString(name, wide)); } catch { return error(5); } if (directoryExists(key) || info(key)) return error(183); directories.add(key); return 1; });
    add(`SetCurrentDirectory${suffix}`, 1, ([name]) => { let key; try { key = pathKey(inputString(name, wide)); } catch { return error(5); } if (!directoryExists(key)) return error(3); currentDirectory = key; return 1; });
    add(`GetCurrentDirectory${suffix}`, 2, ([length, output]) => { const path = INSTALL + (currentDirectory ? '\\' + currentDirectory.replaceAll('/', '\\') : ''); if (length <= path.length) return path.length + 1; writeText(output, path, length, wide); return path.length; });
    add(`DeleteFile${suffix}`, 1, ([name]) => { let key; try { key = pathKey(inputString(name, wide)); } catch { return error(5); } if(mappingAlive(key))return error(5);if (!h.virtualFiles.has(key)) return error(info(key) ? 5 : 2); keepFolders(key); h.virtualFiles.delete(key); return 1; });
    // Deleting a profile in Warcraft removes its files, then save\<profile>.
    add(`RemoveDirectory${suffix}`, 1, ([name]) => {
      let key; try { key = pathKey(inputString(name, wide)); } catch { return error(5); }
      if (!key) return error(5);
      if (info(key)) return error(267); // ERROR_DIRECTORY: a file, not a folder
      if (!directoryExists(key)) return error(2);
      const prefix = key + '/';
      if ([...entries().keys(), ...directories].some(path => path.startsWith(prefix))) return error(145); // ERROR_DIR_NOT_EMPTY
      if (currentDirectory === key || currentDirectory.startsWith(prefix)) return error(32); // in use
      directories.delete(key); return 1;
    });
    // Leaving a network game writes the replay to a temporary file, then moves
    // it to Replay\LastReplay.w3g. Files of the installation are read-only.
    // https://learn.microsoft.com/windows/win32/api/winbase/nf-winbase-movefileexa
    const moveFile = (source, target, flags) => {
      let from, to; try { from = pathKey(inputString(source, wide)); to = target ? pathKey(inputString(target, wide)) : null; } catch { return error(5); }
      if (to === null || flags & ~0xb) return error(87); // no reboot to delay a move or deletion until
      const file = info(from); if (!file) return error(directoryExists(from) ? 5 : 2);
      if (!h.virtualFiles.has(from) || mappingAlive(from)) return error(5);
      const open = key => [...h.handles.values()].filter(item => item.kind === 'file' && item.key === key);
      if (open(from).some(item => !(item.sharing & 4))) return error(32); // opened without FILE_SHARE_DELETE
      if (to === from) return 1;
      if (info(to) || directoryExists(to)) {
        if (!(flags & 1)) return error(183); // MOVEFILE_REPLACE_EXISTING not given
        if (!h.virtualFiles.has(to) || mappingAlive(to)) return error(5);
        if (open(to).length) return error(32);
      }
      const data = h.virtualFiles.get(from);
      keepFolders(from); h.virtualFiles.delete(from); h.virtualFiles.set(to, data);
      for (const item of open(from)) { item.key = to; item.path = to; } // handles follow the file
      return 1;
    };
    add(`MoveFile${suffix}`, 2, ([source, target]) => moveFile(source, target, 0));
    add(`MoveFileEx${suffix}`, 3, ([source, target, flags]) => moveFile(source, target, flags));
    add(`CopyFile${suffix}`, 3, ([source, target, failIfExists]) => {
      let from, to; try { from = pathKey(inputString(source, wide)); to = pathKey(inputString(target, wide)); } catch { return error(5); }
      const file = info(from); if (!file) return error(directoryExists(from) ? 5 : 2);
      const open = key => [...h.handles.values()].filter(item => item.kind === 'file' && item.key === key);
      if (open(from).some(item => item.writing || !(item.sharing & 1))) return error(32);
      if (to === from) return error(32);
      if (info(to) || directoryExists(to)) {
        if (failIfExists) return error(80); // ERROR_FILE_EXISTS
        if (!h.virtualFiles.has(to) || mappingAlive(to)) return error(5);
        if (open(to).length) return error(32);
      }
      const data = fileData({key:from, path:file.path, data:file.data}, 0, file.size);
      if (!(data instanceof Uint8Array) || data.length !== file.size) return error(30); // ERROR_READ_FAULT
      h.virtualFiles.set(to, data.slice());
      return 1;
    });
    // Attributes are not stored: GetFileAttributes reports a normal file.
    add(`SetFileAttributes${suffix}`, 2, ([name]) => { let key; try { key = pathKey(inputString(name, wide)); } catch { return error(5); } return info(key) || directoryExists(key) ? 1 : error(2); });
  }
  const ioPosition=(item,overlapped,writing=false)=>{
    if(!overlapped){if(item.overlapped){error(87);return null;}return {offset:item.position,overlapped:0};}
    h.check(overlapped,20);
    const low=h.u32(overlapped+8),high=h.u32(overlapped+12),eventValue=h.u32(overlapped+16),eventId=(eventValue&~1)>>>0;
    const offset=writing&&low===INVALID&&high===INVALID?fileSize(item):high*4294967296+low;
    if(!Number.isSafeInteger(offset)){error(87);return null;}
    const event=eventId?h.getHandle(eventId,'event'):null;if(eventId&&!event)return null;
    return {offset,overlapped,event,eventValue};
  };
  const completeIO=(item,operation,count,status=0,code=0)=>{
    const {offset,overlapped,event,eventValue}=operation;
    if(!item.overlapped)item.position=offset+count;
    item.ioSignal=true;
    if(overlapped){
      // This VFS finishes transfers synchronously. Overlapped handles may
      // still complete immediately, but their completion packets are required.
      const queued=item.port&&!(eventValue&1)&&!code;
      h.w32(overlapped,queued?0x103:status);h.w32(overlapped+4,queued?0:count);
      if(event)event.signal=true;
      if(queued)item.port.queue.push({bytes:count,key:item.completionKey,overlapped,status,error:code});
      threads.notify();
    }
    return code?error(code):1;
  };
  add('GetOverlappedResult',4,([id,overlapped,transferred,wait])=>{
    if(!h.getHandle(id,'file'))return 0;if(!overlapped||!transferred)return error(87);
    h.check(overlapped,20);h.check(transferred,4);const context=threads.context();
    const check=()=>{
      const status=h.u32(overlapped);if(status===0x103)return null;
      h.w32(transferred,h.u32(overlapped+4));
      if(status){context.lastError=({[0xc0000011]:38,[0xc0000120]:995,[0xc000007f]:112,[0xc0000022]:5})[status]||31;return 0;}return 1;
    };
    return threads.until(check,wait?INVALID:0,()=>{context.lastError=996;return 0;});
  });
  add('ReadFile', 5, ([id, output, count, read, overlapped]) => {
    if (read) h.w32(read, 0);
    const item = h.getHandle(id, 'file'); if (!item) return 0; if (!item.reading) return error(5);
    const operation=ioPosition(item,overlapped);if(!operation)return 0;
    h.check(output, count); const length = Math.min(count, Math.max(0, fileSize(item) - operation.offset));
    if(count&&!length&&overlapped)return completeIO(item,operation,0,0xc0000011,38);
    const finish=data=>{
      if (!(data instanceof Uint8Array) || data.length !== length) throw new GuestFault('File provider returned a truncated range', {path: item.path, offset: operation.offset, length});
      h.copyIn(output, data);if(read)h.w32(read,data.length);return completeIO(item,operation,data.length);
    };
    // Bytes the server has to send: only this guest thread waits for them,
    // as for a slow disk, while the broker serves the others (rendering too).
    if(length&&h.importMayWait&&h.readFileLater&&!h.virtualFiles.has(item.key)&&!item.data){
      const later=h.readFileLater(item.path,operation.offset,length,{stood:(h.threadContext?.id??1)===1});
      if(later){const cpu=h.currentCPU;return later.then(data=>h.onCPU(cpu,()=>finish(data)));}
    }
    return finish(length ? fileData(item, operation.offset, length) : new Uint8Array());
  });
  add('WriteFile', 5, ([id, input, count, written, overlapped]) => {
    if (written) h.w32(written, 0);
    const item = h.getHandle(id); if (!item) return 0;
    if (item.kind === 'console') { h.log(new TextDecoder().decode(h.copyOut(input, count))); if (written) h.w32(written, count); return 1; }
    if (item.kind !== 'file' || !item.writing) return error(5);
    const operation=ioPosition(item,overlapped,true);if(!operation)return 0;
    const size = count?Math.max(fileSize(item), operation.offset + count):fileSize(item); if (size > 128 * 1024 * 1024) return completeIO(item,operation,0,0xc000007f,112);
    const data = new Uint8Array(size), previous = fileSize(item); if (previous) data.set(fileData(item, 0, previous));
    if(count)data.set(h.copyOut(input, count), operation.offset);h.virtualFiles.set(item.key, data);if(written)h.w32(written,count);return completeIO(item,operation,count);
  });
  add('SetFilePointer', 4, ([id, low, high, origin]) => {
    const item = h.getHandle(id, 'file'); if (!item) return INVALID;
    const delta = high ? BigInt(h.i32(high)) * 0x100000000n + BigInt(low) : BigInt(low | 0);
    const start = origin === 0 ? 0 : origin === 1 ? item.position : origin === 2 ? fileSize(item) : null;
    if (start === null) return error(87, INVALID);
    const position = BigInt(start) + delta; if (position < 0n || position > BigInt(Number.MAX_SAFE_INTEGER)) return error(131, INVALID);
    item.position = Number(position); if (high) h.w32(high, Number(position >> 32n)); h.lastError = 0; return Number(position & 0xffffffffn);
  });
  add('GetFileSize', 2, ([id, high]) => { const item = h.getHandle(id, 'file'); if (!item) return INVALID; const size = fileSize(item); if (high) h.w32(high, Math.floor(size / 0x100000000)); h.lastError = 0; return size >>> 0; });
  add('GetFileSizeEx', 2, ([id, output]) => { const item = h.getHandle(id, 'file'); if (!item) return 0; qword(output, BigInt(fileSize(item))); return 1; });
  add('SetEndOfFile', 1, ([id]) => { const item = h.getHandle(id, 'file'); if (!item) return 0; if (!item.writing) return error(5);if(mappingAlive(item.key))return error(1224); if (item.position > 128 * 1024 * 1024) return error(112); const data = new Uint8Array(item.position), length = Math.min(item.position, fileSize(item)); if (length) data.set(fileData(item, 0, length)); h.virtualFiles.set(item.key, data); return 1; });
  add('FlushFileBuffers', 1, ([id]) => h.getHandle(id, 'file') ? 1 : 0);
  add('GetFileType', 1, ([id]) => { const item = h.getHandle(id); return item?.kind === 'file' ? 1 : item?.kind === 'console' ? 2 : 0; });
  const standard = new Map([[0xfffffff6, h.handle({kind: 'console', input: true})], [0xfffffff5, h.handle({kind: 'console'})], [0xfffffff4, h.handle({kind: 'console'})]]);
  add('GetStdHandle', 1, ([which]) => standard.get(which) ?? error(87, INVALID));
  add('SetStdHandle', 2, ([which, id]) => { if (!standard.has(which) || !h.getHandle(id)) return error(6); standard.set(which, id); return 1; });
  add('SetHandleCount', 1, ([count]) => count);
  add('GetFileTime', 4, ([id, creation, access, modified]) => { const item = h.getHandle(id, 'file'); if (!item) return 0; for (const pointer of [creation, access, modified]) if (pointer) qword(pointer, item.time ?? 0n); return 1; });
  add('SetFileTime', 4, ([id, creation, access, modified]) => { const item = h.getHandle(id, 'file'); if (!item || !item.writing) return error(5); if (modified) item.time = readQword(modified); return 1; });
  const writeFind = (output, item) => { h.zero(output, 320); h.w32(output, item.directory ? 0x10 : 0x80); const size = item.directory ? 0 : info(item.path)?.size || 0; h.w32(output + 28, Math.floor(size / 0x100000000)); h.w32(output + 32, size); h.writeString(output + 44, item.name, 260); };
  add('FindFirstFileA', 2, ([name, output]) => {
    let pattern; try { pattern = pathKey(h.cstr(name)); } catch { return error(5, INVALID); }
    const slash = pattern.lastIndexOf('/'), parent = slash < 0 ? '' : pattern.slice(0, slash), wildcard = pattern.slice(slash + 1);
    const expression = new RegExp('^' + (wildcard === '*.*' ? '*' : wildcard).replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*').replaceAll('?', '.') + '$', 'i');
    const children = new Map(), all = entries(), within = key => !parent || key.startsWith(parent + '/');
    const visibleFolder = directories.has(parent) || [...all.keys()].some(key => within(key) && !all.hidden.has(key));
    for (const key of new Set([...all.keys(), ...directories])) { if (!within(key) || visibleFolder && all.hidden.has(key)) continue; const tail = parent ? key.slice(parent.length + 1) : key; if (!tail) continue; const child = tail.split('/')[0]; if (expression.test(child)) children.set(child, {name: child, path: parent ? parent + '/' + child : child, directory: tail.includes('/') || directories.has(key)}); }
    const matches = [...children.values()].sort((a, b) => a.name.localeCompare(b.name)); if (!matches.length) return error(2, INVALID);
    writeFind(output, matches[0]); return h.handle({kind: 'find', matches, index: 1});
  });
  add('FindNextFileA', 2, ([id, output]) => { const item = h.getHandle(id, 'find'); if (!item) return 0; if (item.index >= item.matches.length) return error(18); writeFind(output, item.matches[item.index++]); return 1; });
  add('FindClose', 1, ([id]) => { if (!h.getHandle(id, 'find')) return 0; h.handles.delete(id); return 1; });
  add('GetDriveTypeA', 1, ([root]) => !root || /^c:/i.test(h.cstr(root)) ? 3 : 1);
  add('GetLogicalDriveStringsA', 2, ([length, output]) => { if (length < 5) return 5; h.copyIn(output, Uint8Array.of(67,58,92,0,0)); return 4; });
  add('GetDiskFreeSpaceA', 5, ([root, sectors, bytes, free, total]) => { if (root && !/^c:/i.test(h.cstr(root))) return error(15); h.w32(sectors, 8); h.w32(bytes, 512); h.w32(free, 32768); h.w32(total, 32768); return 1; });

  installWindows(h, {user, gdi, error, fail, writeText, inputString});
  installRegistry(h, {adv, error, writeText, inputString, textBytes});
}

function installWindows(h, {user, gdi, error, fail, writeText, inputString}) {
  const classes = new Map(), atoms = new Map(), timers = new Map();
  let nextAtom = 0xc000, active = 0, focus = 0, capture = 0, cursor = 0, cursorCount = 0;
  const dimensions = () => [h.graphics?.canvas?.width || h.resolution.width, h.graphics?.canvas?.height || h.resolution.height];
  const displayName = '\\\\.\\DISPLAY1';
  // Every launch resolution is a mode the game's own Video options can list.
  const displayModes = [...new Map([[640,480],[1280,720],[1280,1024],[1600,900],[1920,1080],...GAME_RESOLUTIONS].map(mode => [mode.join('x'), mode])).values()]
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const initialDisplay=dimensions();let savedDisplay=initialDisplay.slice();
  for(const [suffix,wide] of [['A',false],['W',true]]){
    user(`EnumDisplayDevices${suffix}`,4,([device,index,output,flags])=>{
      const size=wide?840:424,unit=wide?2:1;
      if(!output||h.u32(output)!==size||flags&~1)return error(87);
      if(index!==0||device&&inputString(device,wide).toUpperCase()!==displayName)return 0;
      h.zero(output,size);h.w32(output,size);
      writeText(output+4,displayName+(device?'\\Monitor0':''),32,wide);
      writeText(output+4+32*unit,device?'Browser canvas':'Warcraft WebGL display',128,wide);
      h.w32(output+4+160*unit,device?1:5);
      writeText(output+8+160*unit,device?'MONITOR\\WC3WEB':'WC3WEB\\DISPLAY',128,wide);
      return 1;
    });
    const displaySettings=([device,index,output,flags=0])=>{
      if(device&&inputString(device,wide).toUpperCase()!==displayName)return 0;
      if(flags&~6)return error(87);
      const sizeOffset=wide?68:36,fieldsOffset=wide?72:40,bitsOffset=wide?168:104;
      const size=output?h.u16(output+sizeOffset):0;
      if(size<bitsOffset+20||size>(wide?220:156))return error(87);
      const mode=index===0xffffffff?dimensions():index===0xfffffffe?savedDisplay:displayModes[index];
      if(!mode)return 0;
      h.zero(output,size);writeText(output,displayName,32,wide);
      h.w16(output+sizeOffset-4,0x401);h.w16(output+sizeOffset,size);
      h.w32(output+fieldsOffset,0x5c0000);
      [32,mode[0],mode[1],0,60].forEach((v,i)=>h.w32(output+bitsOffset+i*4,v));
      return 1;
    };
    user(`EnumDisplaySettings${suffix}`,3,displaySettings);
    user(`EnumDisplaySettingsEx${suffix}`,4,displaySettings);
    const changeDisplay=([device,mode,windowId,flags,reserved])=>{
      if(device&&inputString(device,wide).toUpperCase()!==displayName)return -5;
      if(windowId||reserved)return -5;
      if(flags&~0x50000007)return -4;
      let size=savedDisplay.slice();
      if(mode){
        const sizeOffset=wide?68:36,fieldsOffset=wide?72:40,bitsOffset=wide?168:104;
        if(h.u16(mode+sizeOffset)<bitsOffset+20)return -5;
        const fields=h.u32(mode+fieldsOffset);
        if(fields&0x40000&&h.u32(mode+bitsOffset)!==32)return -2;
        if(fields&0x80000)size[0]=h.u32(mode+bitsOffset+4);
        if(fields&0x100000)size[1]=h.u32(mode+bitsOffset+8);
        if(fields&0x400000&&![0,1,60].includes(h.u32(mode+bitsOffset+16)))return -2;
        if(!displayModes.some(([w,h])=>w===size[0]&&h===size[1])&&!(size[0]===initialDisplay[0]&&size[1]===initialDisplay[1]))return -2;
      }
      if(flags&2)return 0;
      if(flags&1)savedDisplay=size.slice();
      if(flags&0x10000000)return flags&1?0:-4;
      if(h.graphics?.canvas){h.graphics.canvas.width=size[0];h.graphics.canvas.height=size[1];}
      for(const[id,item]of h.handles)if(item.kind==='window'&&!item.desktop)enqueue({hwnd:id,message:0x7e,wParam:32,lParam:(size[1]<<16)|size[0]});
      return 0;
    };
    user(`ChangeDisplaySettings${suffix}`,2,([mode,flags])=>changeDisplay([0,mode,0,flags,0]));
    user(`ChangeDisplaySettingsEx${suffix}`,5,changeDisplay);
  }
  const desktop = h.handle({kind: 'window', desktop: true, x: 0, y: 0, width: dimensions()[0], height: dimensions()[1], visible: true, enabled: true, parent: 0, title: '', procedure: 0, extra: new Map(), properties: new Map()});
  const window = id => h.getHandle(id, 'window');
  const ime=(name,count,fn)=>h.add('imm32.dll',name,count,fn);
  // IMM associates each new window with its thread's default context, even
  // though this virtual keyboard layout does not supply an IME composition UI.
  // https://learn.microsoft.com/en-us/windows/win32/intl/input-context
  const defaultContexts=new Map();
  const defaultContext=threadId=>{
    let context=defaultContexts.get(threadId);
    if(!context){context=h.handle({kind:'ime',threadId,default:true,open:false});defaultContexts.set(threadId,context);}
    return context;
  };
  const contextMatches=(context,item)=>!context||(h.getHandle(context,'ime')?.threadId===item.threadId);
  ime('ImmCreateContext',0,()=>h.handle({kind:'ime',threadId:h.threadId,default:false,open:false}));
  ime('ImmDestroyContext',1,([context])=>{
    const item=h.getHandle(context,'ime');if(!item)return error(6);
    if(item.default||item.threadId!==h.threadId)return error(5);
    if([...h.handles.values()].some(window=>window.kind==='window'&&window.ime===context))return error(170);
    h.handles.delete(context);return 1;
  });
  ime('ImmAssociateContext',2,([id,context])=>{
    const item=window(id);if(!item||item.desktop)return error(1400);
    if(!contextMatches(context,item))return error(6);
    const previous=item.ime||0;item.ime=context;return previous;
  });
  // IACE_DEFAULT ignores hIMC; IACE_CHILDREN changes only existing child
  // windows from the parent's creating thread, not the parent or owned popups.
  // https://learn.microsoft.com/en-us/windows/win32/api/imm/nf-imm-immassociatecontextex
  ime('ImmAssociateContextEx',3,([id,context,flags])=>{
    const item=window(id);if(!item||item.desktop)return error(1400);
    if(flags&~0x31)return error(87);
    if(!(flags&0x10)&&!contextMatches(context,item))return error(6);
    let targets=[item];
    if(flags&1){
      targets=[];
      for(const child of h.handles.values()){
        if(child.kind!=='window'||child===item||child.threadId!==item.threadId)continue;
        const visited=new Set();let ancestor=child;
        while(ancestor?.style&0x40000000){
          if(ancestor.parent===id){targets.push(child);break;}
          if(visited.has(ancestor.parent))break;
          visited.add(ancestor.parent);ancestor=window(ancestor.parent);
        }
      }
    }
    for(const target of targets){
      if(flags&0x20&&!target.ime)continue;
      target.ime=flags&0x10?target.defaultIme||0:context;
    }
    return 1;
  });
  ime('ImmGetContext',1,([id])=>window(id)?.ime||0);
  ime('ImmReleaseContext',2,([id,context])=>{const item=window(id);return item&&context&&item.ime===context?1:0;});
  ime('ImmGetOpenStatus',1,([context])=>{
    const item=h.getHandle(context,'ime');return item?Number(item.open):error(6);
  });
  // Store open status on the context shared by its associated windows. The
  // focused window receives WM_IME_NOTIFY / IMN_SETOPENSTATUS on a change.
  // https://learn.microsoft.com/en-us/windows/win32/api/imm/nf-imm-immsetopenstatus
  ime('ImmSetOpenStatus',2,([context,value])=>{
    const item=h.getHandle(context,'ime');if(!item)return error(6);
    if(item.threadId!==h.threadId)return error(5);
    const open=!!value;if(item.open===open)return 1;item.open=open;
    if(window(focus)?.ime===context)send(focus,0x282,8,0);
    return 1;
  });
  ime('ImmIsIME',1,()=>0); // The virtual en-US keyboard has no IME installed.
  const className = (pointer, wide = false) => pointer <= 0xffff ? atoms.get(pointer) : inputString(pointer, wide).toLowerCase();
  const enqueue = message => {
    if (h.events.length >= 4096) throw new GuestFault('Window message queue overflow');
    h.events.push({hwnd:0,wParam:0,lParam:0,time:Math.floor(h.clock()),x:0,y:0,threadId:h.handles.get(message.hwnd)?.threadId||h.threadId,...message});
    queueMicrotask(()=>h.threadServices.notify());
  };
  h.postWindowMessage=(id,message,wParam=0,lParam=0)=>{if(!h.handles.has(id))return 0;enqueue({hwnd:id,message,wParam,lParam});return 1;};
  const send = (id, message, wparam, lparam) => { const item = window(id); if (!item) return 0; return item.procedure ? h.call(item.procedure, [id, message, wparam, lparam]) : defaultProcedure(id, message, wparam, lparam); };
  const invalidate=id=>{if(!h.events.some(message=>message.hwnd===id&&message.message===15))enqueue({hwnd:id,message:15});};
  const activationHistory=[];
  const activate=id=>{
    const previous=active,oldFocus=focus;if(previous===id&&oldFocus===id)return previous;
    active=id;focus=id;
    if(id){const index=activationHistory.indexOf(id);if(index>=0)activationHistory.splice(index,1);activationHistory.push(id);}
    // WM_ACTIVATEAPP marks activation changes between applications only. All
    // guest windows belong to this process: switching between them must not
    // report the application as deactivated. Warcraft otherwise handled a
    // false deactivation of its loading window while its new main window was
    // still being created, and throttled the main menu as a background app.
    if(previous&&previous!==id){send(previous,6,0,id);if(!id)send(previous,0x1c,0,h.threadId);}
    if(oldFocus&&oldFocus!==id)send(oldFocus,8,id,0);
    if(id){if(!previous)send(id,0x1c,1,h.threadId);send(id,6,1,previous);if(oldFocus!==id)send(id,7,oldFocus,0);}
    return previous;
  };
  const destroy = id => {
    const item=window(id);if(!item||item.desktop)return error(1400);
    send(id,2,0,0);send(id,0x82,0,0);h.handles.delete(id);
    if(capture===id)capture=0;
    for(const[key,timer]of timers)if(timer.hwnd===id)timers.delete(key);
    if(active===id){
      const candidate=[...activationHistory].reverse().find(key=>{const next=h.handles.get(key);return next?.kind==='window'&&next.visible&&next.enabled&&!next.desktop;});
      activate(candidate||0);
    }
    if(focus===id)focus=0;
    return 1;
  };
  h.windowState=()=>({active,focus,capture,windows:[...h.handles].filter(([id,w])=>w.kind==='window'&&!w.desktop).map(([id,w])=>({id,title:w.title,visible:w.visible,enabled:w.enabled,threadId:w.threadId,parent:w.parent,width:w.width,height:w.height}))});
  const positionChanged=(id,flags=0,after=0)=>{
    const item=window(id);if(!item)return;const p=h.alloc(28);
    [id,after,item.x,item.y,item.width,item.height,flags].forEach((v,i)=>h.w32(p+i*4,v));
    try{send(id,0x47,0,p);}finally{h.free(p);}
  };
  const defaultProcedure = (id, message, wparam, lparam, wide = false) => {
    const item = window(id); if (!item) return 0;
    if (message === 0x81) return 1; // WM_NCCREATE accepts creation.
    if (message === 0x10) return destroy(id);
    if (message === 0x0e) return item.title.length;
    if (message === 0x0d) return writeText(lparam, item.title, wparam, wide);
    if (message === 0x0c) { item.title = inputString(lparam, wide); return 1; }
    if(message===0x47){
      const flags=h.u32(lparam+24);
      if(!(flags&2))send(id,3,0,(item.x&65535)|((item.y&65535)<<16));
      if(!(flags&1))send(id,5,item.minimized?1:item.maximized?2:0,(item.width&65535)|((item.height&65535)<<16));
    }
    return 0;
  };
  const register = (pointer, extended, wide) => {
    if (extended && h.u32(pointer) < 48) return error(87);
    const offset = extended ? 4 : 0, name = inputString(h.u32(pointer + offset + 36), wide).toLowerCase();
    if (!name) return error(87); if (classes.has(name)) return error(1410);
    const atom = nextAtom++, info = {atom, procedure: h.u32(pointer + offset + 4), style: h.u32(pointer + offset), instance: h.u32(pointer + offset + 16), icon: h.u32(pointer + offset + 20), cursor: h.u32(pointer + offset + 24), background: h.u32(pointer + offset + 28), extra: new Map()};
    classes.set(name, info); atoms.set(atom, name); return atom;
  };
  for (const [suffix, wide] of [['A', false], ['W', true]]) {
    user(`RegisterClass${suffix}`, 1, ([pointer]) => register(pointer, false, wide));
    user(`RegisterClassEx${suffix}`, 1, ([pointer]) => register(pointer, true, wide));
    user(`UnregisterClass${suffix}`, 2, ([pointer]) => { const name = className(pointer, wide), info = classes.get(name); if (!info) return error(1411); if ([...h.handles.values()].some(item => item.kind === 'window' && item.className === name)) return error(1412); classes.delete(name); atoms.delete(info.atom); return 1; });
    user(`CreateWindowEx${suffix}`, 12, args => {
      const [extended, classPointer, title, style, x, y, width, height, parent, menu, instance, parameter] = args;
      const name = className(classPointer, wide), info = classes.get(name); if (!info) return error(1407);
      if (parent && !window(parent)) return error(1400);
      const size = dimensions(), item = {kind: 'window', className: name, procedure: info.procedure, class: info,
        title: inputString(title, wide), style, extended, x: x === 0x80000000 ? 0 : x | 0, y: y === 0x80000000 ? 0 : y | 0,
        width: width === 0x80000000 ? size[0] : width | 0, height: height === 0x80000000 ? size[1] : height | 0,
        parent, menu, instance,threadId:h.threadId,ime:defaultContext(h.threadId), visible: !!(style & 0x10000000), enabled: !(style & 0x08000000), extra: new Map(), properties: new Map()};
      item.defaultIme=item.ime;
      const id = h.handle(item), creation = h.alloc(48);
      [parameter, instance, menu, parent, item.height, item.width, item.y, item.x, style, title, classPointer, extended].forEach((value, index) => h.w32(creation + index * 4, value));
      try { if (!send(id, 0x81, 0, creation) || send(id, 1, 0, creation) === INVALID) { h.handles.delete(id); return 0; } }
      catch (problem) { h.handles.delete(id); throw problem; }
      finally { h.free(creation); }
      positionChanged(id,item.visible?0x40:0);
      if(item.visible){send(id,0x18,1,0);if(!parent)activate(id);invalidate(id);}
      return id;
    });
    user(`DefWindowProc${suffix}`, 4, args => defaultProcedure(...args, wide));
    user(`CallWindowProc${suffix}`, 5, ([procedure, id, message, wparam, lparam]) => h.call(procedure, [id, message, wparam, lparam]));
    user(`SendMessage${suffix}`, 4, ([id, message, wparam, lparam]) => send(id, message, wparam, lparam));
    user(`PostMessage${suffix}`, 4, ([id, message, wparam, lparam]) => { if (id && !window(id)) return error(1400); enqueue({hwnd: id, message, wParam: wparam, lParam: lparam}); return 1; });
    user(`SetWindowText${suffix}`, 2, ([id, text]) => { const item = window(id); if (!item) return 0; item.title = inputString(text, wide); return 1; });
    user(`GetWindowText${suffix}`, 3, ([id, output, length]) => { const item = window(id); return item ? writeText(output, item.title, length, wide) : 0; });
    user(`GetWindowTextLength${suffix}`, 1, ([id]) => window(id)?.title.length || 0);
    user(`GetClassName${suffix}`, 3, ([id, output, length]) => { const item = window(id); return item ? writeText(output, item.className || 'Desktop', length, wide) : 0; });
    user(`SetWindowLong${suffix}`, 3, ([id, index, value]) => { const item = window(id); if (!item) return 0; const field = ({'-4': 'procedure', '-6': 'instance', '-8': 'parent', '-12': 'menu', '-16': 'style', '-20': 'extended'})[index | 0]; const previous = field ? item[field] : item.extra.get(index) || 0; if (field) item[field] = value; else item.extra.set(index, value); return previous; });
    user(`GetWindowLong${suffix}`, 2, ([id, index]) => { const item = window(id); if (!item) return 0; const field = ({'-4': 'procedure', '-6': 'instance', '-8': 'parent', '-12': 'menu', '-16': 'style', '-20': 'extended'})[index | 0]; return field ? item[field] : item.extra.get(index) || 0; });
    user(`SetClassLong${suffix}`, 3, ([id, index, value]) => { const item = window(id); if (!item?.class) return error(1411); const previous = item.class.extra.get(index) || 0; item.class.extra.set(index, value); return previous; });
    user(`GetClassLong${suffix}`, 2, ([id, index]) => { const item = window(id); if (!item?.class) return 0; const field = ({'-24': 'procedure', '-26': 'style', '-32': 'instance', '-14': 'icon', '-12': 'cursor', '-10': 'background'})[index | 0]; return field ? item.class[field] : item.class.extra.get(index) || 0; });
    user(`SetProp${suffix}`, 3, ([id, name, value]) => { const item = window(id); if (!item) return 0; item.properties.set(name <= 0xffff ? name : inputString(name, wide), value); return 1; });
    user(`GetProp${suffix}`, 2, ([id, name]) => window(id)?.properties.get(name <= 0xffff ? name : inputString(name, wide)) || 0);
    user(`RemoveProp${suffix}`, 2, ([id, name]) => { const item = window(id); if (!item) return 0; const key = name <= 0xffff ? name : inputString(name, wide), previous = item.properties.get(key) || 0; item.properties.delete(key); return previous; });
  }
  user('DestroyWindow', 1, ([id]) => destroy(id));
  user('GetDesktopWindow', 0, () => desktop);
  user('GetParent', 1, ([id]) => window(id)?.parent || 0);
  user('SetParent', 2, ([id, parent]) => { const item = window(id); if (!item || (parent && !window(parent))) return 0; const previous = item.parent; item.parent = parent; return previous; });
  user('IsWindow', 1, ([id]) => h.handles.get(id)?.kind === 'window' ? 1 : 0);
  user('IsWindowVisible', 1, ([id]) => window(id)?.visible ? 1 : 0);
  user('IsWindowEnabled', 1, ([id]) => window(id)?.enabled ? 1 : 0);
  user('EnableWindow', 2, ([id, enabled]) => { const item = window(id); if (!item) return 0; const previous = item.enabled; item.enabled = !!enabled; return previous ? 0 : 1; });
  user('ShowWindow', 2, ([id, command]) => {
    const item=window(id);if(!item)return 0;const previous=item.visible;item.visible=command!==0;
    item.style=item.visible?item.style|0x10000000:item.style&~0x10000000;
    item.minimized=[2,6,7,11].includes(command);item.maximized=command===3;
    if(previous!==item.visible)send(id,0x18,item.visible?1:0,0);
    if(previous!==item.visible)positionChanged(id,item.visible?0x40:0x83);
    if(item.visible){if(![4,7,8].includes(command)&&!item.parent)activate(id);invalidate(id);}
    else if(active===id)activate(0);
    return previous?1:0;
  });
  user('GetActiveWindow', 0, () => active);
  user('GetForegroundWindow', 0, () => active);
  user('SetActiveWindow', 1, ([id]) => { if (id && !window(id)) return 0;return activate(id); });
  user('SetForegroundWindow', 1, ([id]) => { if (!window(id)) return 0;activate(id);return 1; });
  user('GetFocus', 0, () => focus);
  user('SetFocus', 1, ([id]) => { if (id && !window(id)) return 0; const previous=focus;if(previous!==id){focus=id;if(previous)send(previous,8,id,0);if(id)send(id,7,previous,0);}return previous; });
  user('SetCapture', 1, ([id]) => { if (!window(id)) return 0; const previous = capture; capture = id; return previous; });
  user('ReleaseCapture', 0, () => { capture = 0; return 1; });
  user('GetWindowThreadProcessId', 2, ([id, process]) => { const item=window(id);if(!item)return 0;if(process)h.w32(process,1);return item.threadId||1; });
  user('GetClientRect', 2, ([id, output]) => { const item = window(id); if (!item) return 0; [0,0,item.width,item.height].forEach((value, i) => h.w32(output + i * 4, value)); return 1; });
  user('GetWindowRect', 2, ([id, output]) => { const item = window(id); if (!item) return 0; [item.x,item.y,item.x+item.width,item.y+item.height].forEach((value, i) => h.w32(output + i * 4, value)); return 1; });
  user('GetWindowPlacement',2,([id,output])=>{
    const item=window(id);if(!item)return error(1400);
    if(!output||h.u32(output)!==44)return error(87);
    h.zero(output,44);h.w32(output,44);h.w32(output+4,item.placementFlags||0);
    h.w32(output+8,!item.visible?0:item.minimized?2:item.maximized?3:1);
    [...(item.minPosition||[-1,-1]),...(item.maxPosition||[-1,-1]),item.x,item.y,item.x+item.width,item.y+item.height]
      .forEach((value,index)=>h.w32(output+12+index*4,value));
    return 1;
  });
  user('SetWindowPlacement',2,([id,input])=>{
    const item=window(id);if(!item)return error(1400);
    if(!input||h.u32(input)!==44)return error(87);
    const flags=h.u32(input+4),command=h.u32(input+8),[left,top,right,bottom]=Array.from({length:4},(_,i)=>h.i32(input+28+i*4));
    if(flags&~7||command>11||right<left||bottom<top)return error(87);
    item.placementFlags=flags&3;item.minPosition=[h.i32(input+12),h.i32(input+16)];item.maxPosition=[h.i32(input+20),h.i32(input+24)];
    item.x=left;item.y=top;item.width=right-left;item.height=bottom-top;positionChanged(id);
    h.handlers.get('user32.dll!ShowWindow').fn([id,command]);return 1;
  });
  for (const [name, sign] of [['ClientToScreen', 1], ['ScreenToClient', -1]]) user(name, 2, ([id, point]) => { const item = window(id); if (!item) return 0; h.w32(point, h.i32(point) + sign * item.x); h.w32(point + 4, h.i32(point + 4) + sign * item.y); return 1; });
  user('SetWindowPos',7,([id,after,x,y,width,height,flags])=>{
    const item=window(id);if(!item)return 0;
    if(!(flags&2)){item.x=x|0;item.y=y|0;}if(!(flags&1)){item.width=width|0;item.height=height|0;}
    if(flags&0x40){item.visible=true;item.style|=0x10000000;}if(flags&0x80){item.visible=false;item.style&=~0x10000000;}
    positionChanged(id,flags,after);if(!(flags&0x10)&&item.visible&&!item.parent)activate(id);return 1;
  });
  user('ShowCursor', 1, ([show]) => show ? ++cursorCount : --cursorCount);
  user('SetCursor', 1, ([id]) => { const previous = cursor; cursor = id; return previous; });
  const sharedImages=new Map();
  for(const[suffix,wide]of[['A',false],['W',true]]){
    const loadImage=([instance,name,type,width,height,flags])=>{
      if(type!==1&&type!==2)fail('LoadImage bitmap rendering');
      if(flags&0x10)fail('LoadImage from file');
      const identifier=name<=0xffff?name:inputString(name,wide),key=[instance,identifier,type,width,height,flags].join(':');
      if(flags&0x8000&&sharedImages.has(key))return sharedImages.get(key);
      const item={kind:type===1?'icon':'cursor',instance,resource:identifier,width:width||32,height:height||32,shared:!!(flags&0x8000)};
      if(instance){
        const group=h.findResource(instance,identifier,type===1?14:12);
        if(!group)return error(1814);
        if(group.size<6||h.u16(group.address+2)!==type)throw new GuestFault('Invalid icon/cursor group');
        const count=h.u16(group.address+4);
        if(!count||6+count*14>group.size)throw new GuestFault('Truncated icon/cursor group');
        const choices=Array.from({length:count},(_,i)=>{
          const p=group.address+6+i*14,w=type===1?h.u8(p)||256:h.u16(p),height=type===1?h.u8(p+1)||256:h.u16(p+2)/2;
          return {id:h.u16(p+12),width:w,height,score:Math.abs(w-item.width)+Math.abs(height-item.height)};
        }).sort((a,b)=>a.score-b.score);
        const chosen=choices[0],image=h.findResource(instance,chosen.id,type===1?3:1);
        if(!image)return error(1814);
        item.data=h.copyOut(image.address,image.size);item.sourceWidth=chosen.width;item.sourceHeight=chosen.height;
      }else if(typeof identifier!=='number'||identifier<32512||identifier>32672)return error(1814);
      const handle=h.handle(item);if(item.shared)sharedImages.set(key,handle);return handle;
    };
    user(`LoadImage${suffix}`,6,loadImage);
    user(`LoadIcon${suffix}`,2,([instance,name])=>loadImage([instance,name,1,0,0,0x8040]));
    user(`LoadCursor${suffix}`,2,([instance,name])=>loadImage([instance,name,2,0,0,0x8040]));
  }
  for(const[name,kind]of[['DestroyIcon','icon'],['DestroyCursor','cursor']])user(name,1,([id])=>{
    const item=h.getHandle(id,kind);if(!item)return 0;if(!item.shared)h.handles.delete(id);return 1;
  });
  user('GetCursorPos', 1, ([point]) => { h.w32(point, h.pointerX || 0); h.w32(point + 4, h.pointerY || 0); return 1; });
  user('SetCursorPos', 2, ([x, y]) => { h.pointerX = x | 0; h.pointerY = y | 0; return 1; });
  user('ClipCursor', 1, ([rectangle]) => { h.pointerClip = rectangle ? Array.from({length: 4}, (_, i) => h.i32(rectangle + i * 4)) : null; return 1; });
  const keyboard=()=>h.threadContext.keyboard??=new Uint8Array(256),pressedKeys=new Set(),toggles=new Set();
  const inputKeyboard=()=>{const result=new Uint8Array(256);for(const key of h.keys||[])result[key]|=0x80;for(const key of toggles)result[key]|=1;return result;};
  user('GetKeyState',1,([key])=>{const value=keyboard()[key]||0;return (value&0x80?0x8000:0)|(value&1);});
  user('GetKeyboardState',1,([pointer])=>{h.copyIn(pointer,keyboard());return 1;});
  user('SetKeyboardState',1,([pointer])=>{keyboard().set(h.copyOut(pointer,256));return 1;});
  user('GetAsyncKeyState',1,([key])=>{const down=h.keys?.has(key),pressed=pressedKeys.delete(key);return (down?0x8000:0)|(pressed?1:0);});
  user('GetSystemMetrics', 1, ([index]) => { const [width, height] = dimensions(); const values = {0:width,1:height,2:17,3:17,4:0,5:0,6:0,7:0,8:0,10:0,11:32,12:32,13:32,14:32,16:width,17:height,19:1,23:0,36:width,37:height,43:3,44:0,67:0,78:width,79:height,80:1}; if (!(index in values)) fail(`GetSystemMetrics(${index})`); return values[index]; });
  const pumpTimers = () => {
    const now=h.clock();
    for(const timer of timers.values())if(now>=timer.next){
      timer.next=now+timer.interval;
      if(!h.events.some(message=>message.threadId===timer.threadId&&message.hwnd===timer.hwnd&&message.message===0x113&&message.wParam===timer.id))
        enqueue({hwnd:timer.hwnd,message:0x113,wParam:timer.id,lParam:timer.callback,threadId:timer.threadId});
    }
  };
  const messageAt = (id, minimum, maximum,threadId=h.threadId) => { pumpTimers(); return h.events.findIndex(message => (!message.threadId||message.threadId===threadId)&&(message.message === 0x12 || ((!id || (id===INVALID?message.hwnd===0:message.hwnd===id)) && ((!minimum && !maximum) || message.message >= minimum && message.message <= maximum)))); };
  const writeMessage = (pointer, message) => [message.hwnd, message.message, message.wParam, message.lParam, message.time, message.x, message.y].forEach((value, i) => h.w32(pointer + i * 4, value || 0));
  const messageMetadata=new Map();
  const outputMessage=(pointer,message,remove=false,context=h.threadContext)=>{writeMessage(pointer,message);messageMetadata.set(pointer,message);if(remove&&message.keyboard)context.keyboard=message.keyboard.slice();};
  for (const suffix of ['A', 'W']) {
    user(`PeekMessage${suffix}`, 5, ([output, id, minimum, maximum, flags]) => { const index = messageAt(id, minimum, maximum); if (index < 0) return 0; outputMessage(output, h.events[index],!!(flags&1)); if (flags & 1) h.events.splice(index, 1); return 1; });
    user(`GetMessage${suffix}`,4,([output,id,minimum,maximum])=>{
      if(id&&id!==INVALID&&!window(id))return error(1400,INVALID);
      h.check(output,28);const threadId=h.threadId,context=h.threadContext;
      const take=()=>{const index=messageAt(id,minimum,maximum,threadId);if(index<0)return null;const message=h.events.splice(index,1)[0];outputMessage(output,message,true,context);return message.message===0x12?0:1;};
      const result=h.threadServices.until(take,INVALID,()=>INVALID);
      if(!result||typeof result.then!=='function')return result;
      const poll=setInterval(()=>h.threadServices.notify(),10);
      return result.finally(()=>clearInterval(poll));
    });
    user(`DispatchMessage${suffix}`, 1, ([pointer]) => { const id = h.u32(pointer), message = h.u32(pointer + 4), wparam = h.u32(pointer + 8), lparam = h.u32(pointer + 12); if (message === 0x113 && lparam) return h.call(lparam, [id, message, wparam, Math.floor(h.clock())]); return id ? send(id, message, wparam, lparam) : 0; });
  }
  user('TranslateMessage',1,([pointer])=>{
    const message=h.u32(pointer+4),code=h.u32(pointer+8),metadata=messageMetadata.get(pointer);
    if(message!==0x100&&message!==0x104)return 0;
    let text=metadata?.browserInput?metadata.text:null;
    if(text===null&&code>=32&&code<=126)text=String.fromCharCode(code>=65&&code<=90&&!(keyboard()[16]&0x80)?code+32:code);
    if(text)for(let i=0;i<text.length;i++)enqueue({hwnd:h.u32(pointer),message:message===0x104?0x106:0x102,wParam:text.charCodeAt(i),lParam:h.u32(pointer+12)});
    return 1;
  });
  h.injectInput=input=>{
    const id=capture||focus||active,item=h.handles.get(id);if(!item||!item.visible)return;
    h.keys??=new Set();
    if(input.type==='focus'||input.type==='blur'){
      const gained=input.type==='focus';if(!gained)h.keys.clear();
      enqueue({hwnd:id,message:0x1c,wParam:gained?1:0,keyboard:inputKeyboard()});enqueue({hwnd:id,message:6,wParam:gained?1:0});enqueue({hwnd:id,message:gained?7:8});return;
    }
    if(input.type==='keydown'||input.type==='keyup'){
      const code=input.keyCode>>>0;if(code>255)return;const down=input.type==='keydown',previous=h.keys.has(code);
      if(down)h.keys.add(code);else h.keys.delete(code);
      if(down&&!previous){pressedKeys.add(code);if([20,144,145].includes(code)){if(toggles.has(code))toggles.delete(code);else toggles.add(code);}}
      const lParam=(1|((input.scanCode||0)<<16)|(input.extended?1<<24:0)|(input.alt?1<<29:0)|(previous?1<<30:0)|(down?0:0x80000000))>>>0;
      enqueue({hwnd:id,message:(input.alt?0x104:0x100)+(down?0:1),wParam:code,lParam,browserInput:true,text:input.text||'',keyboard:inputKeyboard()});return;
    }
    if(!['pointermove','pointerdown','pointerup','wheel'].includes(input.type))return;
    // The canvas shows the whole emulated screen, and a Windows cursor never
    // leaves the screen: pixels are floor-mapped and clamped to the last row
    // and column, where Warcraft starts edge scrolling.
    let x=Math.floor(input.x*item.width),y=Math.floor(input.y*item.height);
    if(!Number.isFinite(x)||!Number.isFinite(y))return;
    x=Math.max(0,Math.min(item.width-1,x));y=Math.max(0,Math.min(item.height-1,y));
    if(h.pointerClip){x=Math.max(h.pointerClip[0]-item.x,Math.min(h.pointerClip[2]-item.x-1,x));y=Math.max(h.pointerClip[1]-item.y,Math.min(h.pointerClip[3]-item.y-1,y));}
    h.pointerX=x+item.x;h.pointerY=y+item.y;
    const mouseKey=[1,4,2,5,6][input.button];
    if(input.type==='pointerdown'&&mouseKey){h.keys.add(mouseKey);pressedKeys.add(mouseKey);}if(input.type==='pointerup'&&mouseKey)h.keys.delete(mouseKey);
    const buttons=(h.keys.has(1)?1:0)|(h.keys.has(2)?2:0)|(input.shift?4:0)|(input.control?8:0)|(h.keys.has(4)?16:0);
    let message=0x200,wParam=buttons,lParam=(x&65535)|((y&65535)<<16);
    if(input.type==='pointerdown'||input.type==='pointerup')message=([0x201,0x207,0x204][input.button]||0x20b)+(input.type==='pointerup'?1:0);
    if(input.type==='wheel'){message=0x20a;wParam|=(input.delta&65535)<<16;lParam=(h.pointerX&65535)|((h.pointerY&65535)<<16);}
    if(message===0x200&&h.events.at(-1)?.message===0x200&&h.events.at(-1)?.hwnd===id)h.events.pop();
    enqueue({hwnd:id,message,wParam,lParam,x:h.pointerX,y:h.pointerY,keyboard:inputKeyboard()});
  };
  user('PostQuitMessage', 1, ([code]) => enqueue({message: 0x12, wParam: code}));
  let nextTimer = 1;
  const timerKey=(id,timerId,threadId=h.threadId)=>id?`${id}:${timerId}`:`thread${threadId}:${timerId}`;
  user('SetTimer',4,([id,timerId,interval,callback])=>{
    const target=id?window(id):null;if(id&&!target)return 0;
    const threadId=target?.threadId||h.threadId;
    // Window timer IDs belong to the caller, including zero. Only timers
    // without an HWND receive generated IDs. Repeated calls reset the timer.
    if(!id&&!timers.has(timerKey(0,timerId)))timerId=nextTimer++;
    interval=Math.max(10,Math.min(0x7fffffff,interval));
    timers.set(timerKey(id,timerId,threadId),{hwnd:id,id:timerId,threadId,interval,callback,next:h.clock()+interval});
    return timerId||1;
  });
  user('KillTimer',2,([id,timerId])=>timers.delete(timerKey(id,timerId))?1:0);
  user('InvalidateRect', 3, ([id]) => { if (!window(id)) return 0;invalidate(id);return 1; });
  user('UpdateWindow', 1, ([id]) => { if (!window(id)) return 0; const index = h.events.findIndex(message => message.hwnd === id && message.message === 15); if (index >= 0) { h.events.splice(index,1); send(id,15,0,0); } return 1; });
  user('GetDC', 1, ([id]) => { if (id && !window(id)) return 0; return h.handle({kind:'dc',window:id || desktop,pixelFormat:0}); });
  user('ReleaseDC', 2, ([id, dc]) => { const item = h.getHandle(dc,'dc'); if (!item || item.window !== (id || desktop)) return 0; h.handles.delete(dc); return 1; });
  user('BeginPaint', 2, ([id, paint]) => { const item = window(id); if (!item) return 0; const dc = h.handle({kind:'dc',window:id,pixelFormat:0}); h.zero(paint,64); h.w32(paint,dc); h.w32(paint+16,item.width); h.w32(paint+20,item.height); return dc; });
  user('EndPaint', 2, ([id, paint]) => { const dc = h.u32(paint), item = h.getHandle(dc,'dc'); if (!item || item.window !== id) return 0; h.handles.delete(dc); return 1; });
  gdi('CreateCompatibleDC', 1, ([id]) => { if (id && !h.getHandle(id,'dc')) return 0; return h.handle({kind:'dc',window:0,pixelFormat:0}); });
  gdi('DeleteDC', 1, ([id]) => { if (!h.getHandle(id,'dc')) return 0; h.handles.delete(id); return 1; });
  const stockObjects=new Map();
  const stock=index=>{
    if(stockObjects.has(index))return stockObjects.get(index);
    let item;
    if(index>=0&&index<=5)item={kind:'brush',color:[0xffffff,0xc0c0c0,0x808080,0x404040,0,0][index],hollow:index===5};
    else if([6,7,8,19].includes(index))item={kind:'pen',color:index===6?0xffffff:0,hollow:index===8};
    else if([10,11,12,13,14,16,17].includes(index))item={kind:'font',name:'sans-serif',height:16};
    else if(index===18)item={kind:'brush',color:0xffffff};else return error(87);
    item.stock=true;const id=h.handle(item);stockObjects.set(index,id);return id;
  };
  gdi('GetStockObject',1,([index])=>stock(index));
  for(const[name,field,initial]of[['BkColor','backgroundColor',0xffffff],['TextColor','textColor',0],['TextAlign','textAlign',0],['BkMode','backgroundMode',2]]){
    gdi('Set'+name,2,([dc,value])=>{const item=h.getHandle(dc,'dc');if(!item)return INVALID;
      if(name==='BkMode'&&![1,2].includes(value))return error(87);
      const previous=item[field]??initial;item[field]=value;return previous;});
    gdi('Get'+name,1,([dc])=>h.getHandle(dc,'dc')?.[field]??initial);
  }
  gdi('CreateSolidBrush',1,([color])=>h.handle({kind:'brush',color:color&0xffffff}));
  gdi('SelectObject',2,([dc,object])=>{
    const item=h.getHandle(dc,'dc'),value=h.handles.get(object);if(!item||!value)return error(6);
    if(!['brush','pen','font'].includes(value.kind))return error(87);
    const previous=item[value.kind]||stock(value.kind==='brush'?0:value.kind==='pen'?7:13);item[value.kind]=object;return previous;
  });
  gdi('DeleteObject',1,([id])=>{const item=h.handles.get(id);if(!item||!['brush','pen','font'].includes(item.kind))return error(6);if(!item.stock)h.handles.delete(id);return 1;});
  user('FillRect',3,([dc,rectangle,brush])=>{
    const context=h.getHandle(dc,'dc'),item=h.handles.get(brush);if(!context||!item||item.kind!=='brush')return error(6);
    if(item.hollow)return 1;if(!h.graphics)fail('GDI FillRect rendering');
    const target=h.handles.get(context.window),[left,top,right,bottom]=[0,1,2,3].map(i=>h.i32(rectangle+i*4));
    const x=target?.x||0,y=target?.y||0;
    h.graphics.fillRect(x+Math.max(0,left),y+Math.max(0,top),x+Math.min(target?.width??dimensions()[0],right),y+Math.min(target?.height??dimensions()[1],bottom),item.color);
    return 1;
  });
  gdi('GetDeviceCaps', 2, ([id, index]) => { if (!h.getHandle(id,'dc')) return 0; const [width,height] = dimensions(); const values = {0:0x300,2:1,4:Math.round(width*25.4/96),6:Math.round(height*25.4/96),8:width,10:height,12:32,14:1,16:0,18:0,20:0,22:0,24:0,26:0,28:0,30:0,32:0,34:0,36:0,38:0,40:0,88:96,90:96,104:0,106:0,108:0,110:0,112:0,113:0,114:0,116:0,117:0,118:0}; if (!(index in values)) fail(`GetDeviceCaps(${index})`); return values[index]; });
  for (const [name,count] of [['BitBlt',9],['StretchBlt',11],['TextOutA',5],['TextOutW',5],['CreateDIBitmap',6]]) gdi(name,count,() => fail(`GDI ${name} rendering`));
}

function installRegistry(h, {adv, error, writeText, inputString, textBytes}) {
  const roots = new Map([[0x80000000,'classes'],[0x80000001,'user'],[0x80000002,'machine'],[0x80000003,'users'],[0x80000005,'config']]);
  const keys = new Map([...roots.values()].map(name => [name,new Map()]));
  const clean = value => value.replaceAll('/','\\').replace(/\\+/g,'\\').replace(/^\\|\\$/g,'').toLowerCase();
  const keyPath = (id, subkey = '') => { const root = roots.get(id) || h.getHandle(id,'registry')?.path; return root === undefined ? null : root + (subkey ? '\\' + clean(subkey) : ''); };
  const create = path => { const parts = path.split('\\'); for (let i = 1; i <= parts.length; i++) { const key = parts.slice(0,i).join('\\'); if (!keys.has(key)) keys.set(key,new Map()); } return keys.get(path); };
  for (const root of ['user','machine']) {
    const game = create(root + '\\software\\blizzard entertainment\\warcraft iii');
    for (const [name,value] of [['installpath',INSTALL],['installpathx',INSTALL],['program',`${INSTALL}\\Warcraft III.exe`],['programx',`${INSTALL}\\Frozen Throne.exe`]]) game.set(name,{type:1,string:value,data:textBytes(value)});
    // Files in the game folder replace archive files with the same path (a
    // localization's font with Cyrillic letters, tools/prepare_fonts.py).
    if (h.allowLocalFiles) game.set('allow local files', {type: 4, data: Uint8Array.of(1, 0, 0, 0)});
    const video = create(root + '\\software\\blizzard entertainment\\warcraft iii\\video');
    // Warcraft opens these groups once and keeps their handles. Missing
    // groups leave settings such as String/userlocal unwritable all session.
    for(const group of ['sound','gameplay','string','map','misc'])create(root+'\\software\\blizzard entertainment\\warcraft iii\\'+group);
    // Launcher graphics settings are the values Warcraft would have saved
    // from its own Video options; unset values keep game.dll defaults.
    for (const [name, value] of [['reswidth', h.resolution.width], ['resheight', h.resolution.height], ['colordepth', 32], ...Object.entries(h.graphicsSettings || {})]) {
      const data = new Uint8Array(4); new DataView(data.buffer).setUint32(0, value, true);
      video.set(name, {type: 4, data});
    }
  }
  h.registry=new GameRegistry(keys,create);
  for (const [suffix,wide] of [['A',false],['W',true]]) {
    adv(`RegOpenKeyEx${suffix}`,5,([id,name,options,access,output]) => { const path = keyPath(id,inputString(name,wide)); if (path === null) return 6; if (!keys.has(path)) return 2; h.w32(output,h.handle({kind:'registry',path})); return 0; });
    adv(`RegCreateKeyEx${suffix}`,9,([id,name,reserved,className,options,access,security,output,disposition]) => { const path = keyPath(id,inputString(name,wide)); if (path === null) return 6; const existed = keys.has(path); create(path); if(!existed)h.registry.changed(path); h.w32(output,h.handle({kind:'registry',path})); if (disposition) h.w32(disposition,existed?2:1); return 0; });
    adv(`RegQueryValueEx${suffix}`,6,([id,name,reserved,type,output,length]) => {
      const path = keyPath(id), values = keys.get(path); if (!values) return 6;
      const value = values.get(inputString(name,wide).toLowerCase()); if (!value) return 2;
      const data = value.string !== undefined ? textBytes(value.string,wide) : value.data;
      if (type) h.w32(type,value.type);
      if (output && !length) return 87;
      const capacity = length ? h.u32(length) : 0; if (length) h.w32(length,data.length);
      if (!output) return 0; if (capacity < data.length) return 234;
      h.copyIn(output,data); return 0;
    });
    adv(`RegSetValueEx${suffix}`,6,([id,name,reserved,type,data,length]) => {
      const values = keys.get(keyPath(id)); if (!values) return 6;
      const value = {type,data:h.copyOut(data,length)};
      if (type === 1 || type === 2) {
        if (wide) { if (length%2) return 87; let string=''; for(let i=0;i<length/2;i++){const code=h.u16(data+i*2);if(!code)break;string+=String.fromCharCode(code);} value.string=string; }
        else { const raw=value.data, terminator=raw.indexOf(0); value.string=new TextDecoder('windows-1252').decode(terminator<0?raw:raw.subarray(0,terminator)); }
      }
      const valueName = inputString(name,wide).toLowerCase(), path = keyPath(id); values.set(valueName,value);
      h.registry.changed(path,valueName);
      // OK in the game's Video options writes gamma; windowed Warcraft does not
      // apply it itself (see platform.mjs). The launcher keeps changed options.
      if (path === 'user\\software\\blizzard entertainment\\warcraft iii\\video' && valueName === 'gamma' && type === 4 && length === 4 && h.u32(data) <= 100) h.setGammaOption?.(h.u32(data));
      h.onRegistryWrite?.(path, valueName, value);
      return 0;
    });
    adv(`RegDeleteValue${suffix}`,2,([id,name]) => { const path=keyPath(id),values=keys.get(path); if(!values)return 6; const valueName=inputString(name,wide).toLowerCase(); if(!values.delete(valueName))return 2; h.registry.changed(path,valueName); return 0; });
    adv(`RegDeleteKey${suffix}`,2,([id,name]) => { const path=keyPath(id,inputString(name,wide)); if(!keys.has(path))return 2; if([...keys.keys()].some(key=>key.startsWith(path+'\\')))return 5; keys.delete(path);h.registry.changed(path);return 0; });
    adv(`RegEnumKeyEx${suffix}`,8,([id,index,output,length,reserved,className,classLength,lastWrite]) => {
      const path=keyPath(id); if(!keys.has(path))return 6;
      const children=[...keys.keys()].filter(key=>key.startsWith(path+'\\')&&!key.slice(path.length+1).includes('\\')).map(key=>key.slice(path.length+1)).sort();
      if(index>=children.length)return 259; const name=children[index],capacity=h.u32(length);h.w32(length,name.length);
      if(capacity<=name.length)return 234;writeText(output,name,capacity,wide);if(classLength)h.w32(classLength,0);if(lastWrite)h.zero(lastWrite,8);return 0;
    });
    adv(`RegQueryInfoKey${suffix}`,12,([id,className,classLength,reserved,subkeys,maxSubkey,maxClass,valuesCount,maxValueName,maxValueData,security,lastWrite]) => {
      const path=keyPath(id),values=keys.get(path);if(!values)return 6;
      const children=[...keys.keys()].filter(key=>key.startsWith(path+'\\')&&!key.slice(path.length+1).includes('\\')).map(key=>key.slice(path.length+1));
      const writes=[[classLength,0],[subkeys,children.length],[maxSubkey,Math.max(0,...children.map(name=>name.length))],[maxClass,0],[valuesCount,values.size],[maxValueName,Math.max(0,...[...values.keys()].map(name=>name.length))],[maxValueData,Math.max(0,...[...values.values()].map(value=>value.string!==undefined?textBytes(value.string,wide).length:value.data.length))],[security,0]];
      for(const [pointer,value]of writes)if(pointer)h.w32(pointer,value);if(lastWrite)h.zero(lastWrite,8);return 0;
    });
    adv(`GetUserName${suffix}`,2,([output,length])=>{const value='Player',capacity=h.u32(length);h.w32(length,value.length+1);if(capacity<=value.length)return error(122);writeText(output,value,capacity,wide);return 1;});
  }
  adv('RegCloseKey',1,([id])=>{if(roots.has(id))return 0;if(!h.getHandle(id,'registry'))return 6;h.handles.delete(id);return 0;});
  adv('RegFlushKey',1,([id])=>keys.has(keyPath(id))?0:6);
}
