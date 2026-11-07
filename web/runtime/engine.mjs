import {WarcraftHost, GuestExit, GuestFault} from './host.mjs';

export async function createRuntime({wasm, images, profile, log = () => {}, ...options}) {
  if (!profile?.modules?.length) throw new GuestFault('Build profile is required to verify game binaries');
  const expected = new Map(profile.modules.map(m => [m.image.toLowerCase(), m.sha256 || m.image_sha256]));
  for (const image of images) {
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', image.bytes)), b=>b.toString(16).padStart(2,'0')).join('');
    if (expected.get(image.name.toLowerCase()) !== digest) throw new GuestFault(`Binary does not match the static build: ${image.name}`);
    expected.delete(image.name.toLowerCase());
  }
  if (expected.size) throw new GuestFault(`Missing modules: ${[...expected.keys()].join(', ')}`);
  const memory = options.memory || new WebAssembly.Memory({initial: 1024, maximum: 65536, shared: true});
  const host = new WarcraftHost({...options, memory, log});
  const result = await WebAssembly.instantiate(wasm, host.imports());
  const instance = result.instance || result;
  host.instance = instance; host.exports = instance.exports;
  instance.exports._initialize?.();
  if (!instance.exports.wc3_init(0x78000000)) throw new GuestFault(host.nativeString(instance.exports.wc3_error_pointer()));
  host.attach(instance);
  const modules = [];
  for (const image of images) {
    const size = image.bytes.byteLength, p = instance.exports.malloc(size) >>> 0;
    if (!p) throw new GuestFault('Cannot allocate module input', {name: image.name, size});
    host.bytes.set(image.bytes, p);
    let base;
    try { base = host.withNativeString(image.name, name => instance.exports.wc3_load(name, p, size) >>> 0); }
    finally { instance.exports.free(p); }
    if (!base) throw new GuestFault(`PE load ${image.name}: ${host.nativeString(instance.exports.wc3_error_pointer())}`);
    host.moduleNames.set(base, image.name);
    modules.push({name: image.name, base, size});
    log(`Mapped ${image.name} at 0x${base.toString(16)}`);
  }
  if (!instance.exports.wc3_link()) throw new GuestFault(`IAT link: ${host.nativeString(instance.exports.wc3_error_pointer())}`);
  log(`Linked ${modules.length} modules, ${instance.exports.wc3_function_count()} lifted entry points`);
  let stage = 'linked';
  const prepareEntry=(name='war3.exe',budget=10000000)=>{
    const module=modules.find(m=>m.name.toLowerCase()===name.toLowerCase());
    if(!module)throw new GuestFault(`Module missing: ${name}`);
    stage='guest-entrypoint';instance.exports.wc3_set_budget(budget);
    const entry=instance.exports.wc3_entrypoint(module.base)>>>0;
    log(`Executing guest entrypoint 0x${entry.toString(16)}`);
    return {entry,cpu:instance.exports.wc3_cpu_pointer()>>>0};
  };
  return {
    host, instance, modules, compiledModule:result.module||(wasm instanceof WebAssembly.Module?wasm:null),
    prepareEntry,
    markReturned(){stage='guest-returned';},
    initialize(name = 'war3.exe') {
      stage = 'dll-initialization';
      const base=host.module(name);
      if (!base || !host.guestOperation(()=>instance.exports.wc3_initialize_startup(base))) throw new GuestFault(`DLL initialization: ${host.nativeString(instance.exports.wc3_error_pointer())}`);
      stage = 'dlls-initialized';
      log('Startup DLL_PROCESS_ATTACH completed');
    },
    run(name = 'war3.exe', budget = 10000000) {
      const {entry}=prepareEntry(name,budget);
      const code = host.call(entry);
      stage = 'guest-returned';
      return code;
    },
    report(error = null) {
      // ExitProcess is a control-flow exception used to unwind the guest, not
      // a failed session when the application reports success.
      const exited=error?.name==='GuestExit'&&Number.isInteger(error.code);
      const cpu=host.lastFaultCPU||(instance.exports.wc3_cpu_pointer()>>>0);
      const count=(instance.exports.wc3_context_trace_count?instance.exports.wc3_context_trace_count(cpu):instance.exports.wc3_trace_count())>>>0;
      const pointer=(instance.exports.wc3_context_trace_pointer?instance.exports.wc3_context_trace_pointer(cpu):instance.exports.wc3_trace_pointer())>>>0;
      const trace = Array.from({length: Math.min(count,128)}, (_, i) => {
        const slot = (Math.max(0,count-128)+i)%128;
        return '0x'+host.view.getUint32(pointer+slot*4,true).toString(16).padStart(8,'0');
      });
      const registers=host.lastFaultRegisters||Object.fromEntries(['eax','ecx','edx','ebx','esp','ebp','esi','edi','eip'].map((name,i)=>[name,'0x'+host.view.getUint32(cpu+i*4,true).toString(16).padStart(8,'0')]));
      return {schemaVersion: 1, stage:exited?'guest-exited':stage, modules, wasmExecuted: true,
        guestReturned: stage === 'guest-returned', gameplayVerified: false, profileVerified: true,
        ...(exited?{exitCode:error.code>>>0}:{}),
        error: error&&!(exited&&error.code===0) ? {type:error.name,message:error.message,details:error.details||null} : null,
        trace, registers, ...host.report()};
    },
  };
}

export {GuestExit, GuestFault};
