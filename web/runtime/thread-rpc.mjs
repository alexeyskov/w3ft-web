// Synchronous guest imports run in workers; the broker may await host work.
// State publication is atomic so a timed-out call cannot become successful.
const HEADER_BYTES = 16;
export const GUEST_REPLY_ERROR_BYTES = 64 * 1024;
export const GUEST_REPLY_BYTES = HEADER_BYTES + GUEST_REPLY_ERROR_BYTES;
const PENDING = 0, RUNNING = 1, DONE = 2, ERROR = 3, CANCELLED = -1;
const CALLBACK=4,CALLBACK_DONE=5,CALLBACK_ERROR=6;
const encoder = new TextEncoder(), decoder = new TextDecoder();
// The first 8 bytes hold state + generation as ONE atomic word. A separate
// generation check followed by a 32-bit state CAS has an ABA race when the
// worker recycles its buffer between those operations. State remains the low
// 32-bit word for Atomics.wait; error length lives at byte 8.
const tagged = (sequence,state) => BigInt.asIntN(64,(BigInt(sequence)<<32n)|BigInt(state>>>0));
const generation = value => Number(BigInt.asUintN(64,value)>>32n);
const phase = value => Number(value&0xffffffffn)|0;

const fault = (message, details = {}) => Object.assign(new Error(message), {name: 'GuestFault', details});
const uint32 = value => Number.isInteger(value) && value >= 0 && value <= 0xffffffff;

// Keep exception identity and exit codes even when details cannot fit the wire.
// Normal JSON-safe details survive unchanged; pathological details are explicit.
export function serializeGuestError(error) {
  const result = {
    name: typeof error?.name === 'string' ? error.name.slice(0, 512) : 'Error',
    message: String(error?.message ?? error).slice(0, 8192),
  };
  if (Number.isInteger(error?.code)) result.code = error.code;
  try {
    if (error?.details !== undefined) result.details = error.details;
    const data = JSON.stringify(result);
    if (encoder.encode(data).byteLength > GUEST_REPLY_ERROR_BYTES) throw new Error('Exception details exceed 64 KiB');
    return JSON.parse(data);
  } catch (serializationError) {
    result.details = {serializationError: String(serializationError.message), truncated: true};
    return result;
  }
}

function deserializeError(replySAB) {
  const length = new DataView(replySAB).getUint32(8, true);
  if (length < 2 || length > GUEST_REPLY_ERROR_BYTES) throw fault('Malformed guest-call error reply', {length});
  let data;
  try {
    // TextDecoder in Chromium rejects SAB-backed views, so copy first.
    data = JSON.parse(decoder.decode(new Uint8Array(replySAB, HEADER_BYTES, length).slice()));
  } catch { throw fault('Malformed guest-call exception JSON'); }
  if (typeof data?.name !== 'string' || typeof data.message !== 'string') throw fault('Malformed guest-call exception fields');
  const error = Object.assign(new Error(data.message), {name: data.name});
  if ('details' in data) error.details = data.details;
  if (Number.isInteger(data.code)) error.code = data.code;
  return error;
}

export class GuestCallProxy {
  // doorbell: shared counter of messages waiting for the broker. The broker
  // checks it between queued GL records and yields to synchronous imports.
  constructor({post = message => globalThis.postMessage(message), timeout = 300000, doorbell = null} = {}) {
    this.doorbell = doorbell instanceof SharedArrayBuffer ? new Int32Array(doorbell, 0, 1) : null;
    if (typeof post !== 'function' || !Number.isFinite(timeout) || timeout <= 0) throw fault('Invalid guest-call RPC configuration');
    this.post = post;
    this.timeout = timeout;
    this.failed = false;
    this.replySAB = new SharedArrayBuffer(GUEST_REPLY_BYTES);
    this.sequence = 0;this.depth=0;this.replies=[this.replySAB];this.callback=null;
  }

  call(id, cpu, commands) {
    const depth=this.depth++;
    try{return this._call(id,cpu,depth,commands);}finally{this.depth--;}
  }
  _call(id,cpu,depth,commands){
    if (this.failed) throw fault('Guest-call RPC is unavailable after a timeout or transport failure');
    if (!uint32(id) || !uint32(cpu) || !cpu || cpu % 4) throw fault('Invalid guest-call thunk or CPU pointer', {id, cpu});
    if(this.sequence===0xffffffff){this.failed=true;throw fault('Guest-call RPC generation exhausted');}
    if(depth>=64)throw fault('Guest callback RPC nesting limit');
    const replySAB = this.replies[depth]??=new SharedArrayBuffer(GUEST_REPLY_BYTES), sequence = ++this.sequence;
    const state = new Int32Array(replySAB, 0, 1);
    const tag = new BigInt64Array(replySAB,0,1);
    new DataView(replySAB).setUint32(8,0,true);
    Atomics.store(tag,0,tagged(sequence,PENDING));
    let deadline = performance.now() + this.timeout, lastPulse=0;
    const pulse=new Uint32Array(replySAB,8,1);
    try { if (this.doorbell) Atomics.add(this.doorbell, 0, 1); this.post({type: 'guest-call', id, cpu, sequence, replySAB,...(commands?{commands}:{})}); }
    catch (error) {
      this.failed = true;
      Atomics.store(tag,0,tagged(sequence,CANCELLED));
      throw fault('Failed to send guest-call RPC', {id, cpu, cause: String(error?.message ?? error)});
    }
    for (;;) {
      const snapshot = Atomics.load(tag,0), current = phase(snapshot);
      if(generation(snapshot)!==sequence){this.failed=true;throw fault('Guest-call RPC reply generation changed',{id,cpu,sequence});}
      if (current === DONE) return undefined; // The broker writes guest EAX/ESP/EIP.
      if (current === ERROR) throw deserializeError(replySAB);
      // While RUNNING, byte 8 is a broker liveness counter. ERROR and callback
      // error phases reuse it as the payload length only after publication.
      const progress=Atomics.load(pulse,0);
      if(progress!==lastPulse){lastPulse=progress;deadline=performance.now()+this.timeout;}
      if(current===CALLBACK){
        const view=new DataView(replySAB);let failure=null,result=0;
        try{
          const address=view.getUint32(16,true),count=view.getUint32(20,true);
          if(!address||count>1024||typeof this.callback!=='function')throw fault('Invalid guest callback request',{address,count});
          const args=Array.from({length:count},(_,i)=>view.getUint32(24+i*4,true));
          result=this.callback(address,args,cpu)>>>0;
        }catch(error){failure=serializeGuestError(error);}
        if(failure){const data=encoder.encode(JSON.stringify(failure));new Uint8Array(replySAB,HEADER_BYTES,data.length).set(data);view.setUint32(8,data.length,true);}
        else view.setUint32(12,result,true);
        if(Atomics.compareExchange(tag,0,snapshot,tagged(sequence,failure?CALLBACK_ERROR:CALLBACK_DONE))!==snapshot)throw fault('Guest callback request was cancelled',{cpu,sequence});
        if(this.doorbell)Atomics.add(this.doorbell,0,1);
        this.post({type:'guest-callback-result',cpu,sequence});deadline=performance.now()+this.timeout;continue;
      }
      if (![PENDING,RUNNING,CALLBACK_DONE,CALLBACK_ERROR].includes(current)) throw fault('Guest-call RPC was cancelled', {id, cpu, state: current});
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        if (Atomics.compareExchange(tag,0,snapshot,tagged(sequence,CANCELLED)) !== snapshot) continue;
        this.failed = true;
        Atomics.notify(state, 0);
        throw fault('Guest-call RPC timed out', {id, cpu, timeout: this.timeout, mayHaveExecuted: current === RUNNING});
      }
      try { Atomics.wait(state, 0, current, remaining); }
      catch (error) {
        this.failed = true;
        Atomics.store(tag,0,tagged(sequence,CANCELLED));
        throw fault('Guest-call RPC requires a worker that can Atomics.wait', {id, cpu, cause: error.message});
      }
    }
  }
}

// Only the owning broker calls this, on its event loop. It cannot publish a
// result concurrently with its own pulse. A worker may cancel the request,
// but a cancelled proxy never reuses its reply buffer for another generation.
export function pulseGuestCall({replySAB,sequence}){
  const tag=new BigInt64Array(replySAB,0,1);
  if(Atomics.load(tag,0)!==tagged(sequence,RUNNING))return false;
  Atomics.add(new Uint32Array(replySAB,8,1),0,1);
  Atomics.notify(new Int32Array(replySAB,0,1),0);return true;
}

// The awaiting broker asks the *same* worker to run a nested guest callback.
// Reentrant imports use another reply buffer, while the outer native/guest
// stacks remain suspended. Blocking callback imports can thus yield normally.
export class GuestCallbackBroker {
  constructor(){this.pending=new Map();}
  call(message,address,args){
    if(!uint32(address)||!address||!Array.isArray(args)||args.length>1024)throw fault('Invalid callback arguments');
    const {cpu,sequence,replySAB}=message,key=`${cpu}:${sequence}`;
    if(this.pending.has(key))throw fault('Concurrent callbacks on one suspended guest call',{cpu,sequence});
    const view=new DataView(replySAB),tag=new BigInt64Array(replySAB,0,1),running=tagged(sequence,RUNNING);
    if(Atomics.load(tag,0)!==running)throw fault('Guest callback requires a suspended running import',{cpu,sequence});
    view.setUint32(16,address,true);view.setUint32(20,args.length,true);args.forEach((v,i)=>view.setUint32(24+i*4,v>>>0,true));
    return new Promise((resolve,reject)=>{
      this.pending.set(key,{replySAB,resolve,reject});
      if(Atomics.compareExchange(tag,0,running,tagged(sequence,CALLBACK))!==running){this.pending.delete(key);reject(fault('Guest callback was cancelled'));return;}
      Atomics.notify(new Int32Array(replySAB,0,1),0);
    });
  }
  complete(message){
    const key=`${message.cpu}:${message.sequence}`,item=this.pending.get(key);if(!item)throw fault('Unknown guest callback reply');
    const {replySAB,resolve,reject}=item,tag=new BigInt64Array(replySAB,0,1),snapshot=Atomics.load(tag,0),state=phase(snapshot);
    this.pending.delete(key);
    if(generation(snapshot)!==message.sequence||![CALLBACK_DONE,CALLBACK_ERROR].includes(state)){reject(fault('Guest callback reply was cancelled'));return;}
    let error,result;try{if(state===CALLBACK_ERROR)error=deserializeError(replySAB);else result=new DataView(replySAB).getUint32(12,true);}catch(caught){error=caught;}
    if(Atomics.compareExchange(tag,0,snapshot,tagged(message.sequence,RUNNING))!==snapshot){reject(fault('Guest callback reply was cancelled'));return;}
    Atomics.notify(new Int32Array(replySAB,0,1),0);
    if(error)reject(error);else resolve(result);
  }
  cancel(error){for(const item of this.pending.values())item.reject(error);this.pending.clear();}
}

export async function serveGuestCall(message, invoker) {
  if (message?.type !== 'guest-call') return {handled: false};
  const {replySAB, id, cpu, sequence} = message;
  if (!(replySAB instanceof SharedArrayBuffer) || replySAB.byteLength !== GUEST_REPLY_BYTES) throw fault('Invalid guest-call reply buffer');
  if(!uint32(sequence)||!sequence)throw fault('Invalid guest-call generation');
  const state = new Int32Array(replySAB, 0, 1);
  const tag = new BigInt64Array(replySAB,0,1);
  const pending = tagged(sequence,PENDING), running = tagged(sequence,RUNNING);
  const previous = Atomics.compareExchange(tag,0,pending,running);
  if (previous !== pending) return {handled: true, ok: false, cancelled: phase(previous) === CANCELLED, stale: generation(previous)!==sequence, duplicate: generation(previous)===sequence&&phase(previous)!==CANCELLED};
  let failure = null;
  try {
    if (!uint32(id) || !uint32(cpu) || !cpu || cpu % 4 || typeof invoker !== 'function') throw fault('Invalid guest-call request', {id, cpu});
    await invoker(id, cpu);
  } catch (error) { failure = serializeGuestError(error); }
  // The invoker may already have changed host state when a timeout occurs.
  // Cancellation suppresses the late reply; it cannot roll those changes back.
  if (Atomics.load(tag,0) !== running) return {handled: true, ok: false, cancelled: true, error: failure};
  if (failure) {
    const data = encoder.encode(JSON.stringify(failure));
    new Uint8Array(replySAB, HEADER_BYTES, data.length).set(data);
    new DataView(replySAB).setUint32(8, data.length, true);
  }
  const published = Atomics.compareExchange(tag,0,running,tagged(sequence,failure?ERROR:DONE))===running;
  if (published) Atomics.notify(state, 0);
  return {handled: true, ok: published && !failure, cancelled: !published, ...(failure ? {error: failure} : {})};
}
