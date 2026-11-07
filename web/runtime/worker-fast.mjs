import {GuestFault} from './host.mjs';

// Only operations whose complete state is in guest memory or the current CPU
// may execute beside that CPU. TLS and last-error have explicit shared backing
// with the broker; allocation of TLS indices still happens there. Critical
// sections are atomics on guest memory. Handles, allocation, broker callbacks,
// file I/O and graphics stay in the broker.
const crt=new Set([
  'memcpy','memmove','memset','memcmp','strlen','strcmp','_stricmp','strncmp','_strnicmp',
  'strcpy','strncpy','strcpy_s','strcat','strchr','strrchr','strstr','_mbsstr','strpbrk','_strupr','_strlwr',
  'isdigit','isupper','isalnum','isprint','iswspace','_ismbcspace','_ismbblead','toupper',
  'atoi','atol','strtol','strtoul','_itoa','sprintf','vsprintf','_snprintf','_vsnprintf','sscanf','vsscanf',
  '_CIsqrt','_CIlog10','_CIexp','_CIatan','_CItan','_CIacos','_CIasin','_CIsin','_CIcos','_CIpow','_CIatan2','_CIfmod',
  'floor','ceil','sqrt','atof','_clearfp','_control87','_controlfp','_controlfp_s',
  // Calls the guest comparator on this worker's own CPU and instance.
  'qsort',
]);
const kernel=new Set(['InterlockedIncrement','InterlockedDecrement','InterlockedExchange','InterlockedExchangeAdd','InterlockedCompareExchange',
  'GetCurrentThreadId','GetCurrentThread','GetCurrentProcess','GetCurrentProcessId','GetTickCount','QueryPerformanceCounter','QueryPerformanceFrequency',
  'GetLastError','SetLastError','TlsGetValue','TlsSetValue',
  // The lock state is the guest CRITICAL_SECTION itself (thread-services.mjs).
  'InitializeCriticalSection','InitializeCriticalSectionAndSpinCount','EnterCriticalSection','TryEnterCriticalSection','LeaveCriticalSection','DeleteCriticalSection']);

export function localImportDispatcher(host,{descriptors,counters},cpu){
  if(!Array.isArray(descriptors)||!(counters instanceof SharedArrayBuffer)||counters.byteLength!==descriptors.length*4)
    throw new GuestFault('Invalid local import counters');
  const counts=new Uint32Array(counters),allowed=new Set();
  host.thunks=descriptors.map((descriptor,id)=>{
    if(!descriptor)return null;
    const {dll,name,argc,convention}=descriptor,key=dll.toLowerCase(),handler=host.handlers.get(key+'!'+name);
    if(!(key==='msvcr80.dll'&&crt.has(name)||key==='kernel32.dll'&&kernel.has(name)))return null;
    if(!handler||handler.argc!==argc||handler.convention!==convention)throw new GuestFault('Local import ABI mismatch',{dll,name});
    allowed.add(id);return handler;
  });
  // Unaligned critical sections are broker objects: forward those calls.
  const sections=new Set();
  host.thunks.forEach((handler,id)=>{if(handler&&/CriticalSection/.test(handler.name))sections.add(id);});
  return (id,context)=>{
    if(!allowed.has(id))return false;
    if(context!==cpu)throw new GuestFault('Local import CPU does not belong to its worker');
    if(sections.has(id)&&(host.u32(host.view.getUint32(cpu+16,true)+4)+host.base)&3)return false;
    Atomics.add(counts,id,1);
    try{host.invoke(id,context);}
    catch(error){error.details={...error.details,localImport:true,history:host.history.slice(-16)};throw error;}
    return true;
  };
}
