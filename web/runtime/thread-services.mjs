import {GuestFault} from './host.mjs';

const INFINITE=0xffffffff, TIMEOUT=258;
// CRITICAL_SECTION words (Int32 index from its base). The structure itself is
// the lock, so a guest worker acquires and releases it without a broker round
// trip: OwningThread is the atomic lock word (thread ID, 0 when free) and
// LockSemaphore counts blocked waiters.
const CS_LOCK_COUNT=1, CS_RECURSION=2, CS_OWNER=3, CS_WAITERS=4, CS_SPIN=5;

// One serialized host broker owns synchronization state for every guest CPU.
// A pending API yields a Promise; no worker is pretended to run synchronously.
export class ThreadServices {
  constructor(host) {
    this.h=host;this.waiters=[];this.conditions=[];this.sleeps=new Set();this.criticalWaiters=new Set();this.critical=new Map();this.threads=new Map();
    host.notifyThreadState=item=>this.threadChanged(item);
    host.cancelThreadWaits=reason=>this.cancel(reason);
    host.threadServices=this;
  }
  context(){return this.h.threadContext||{id:this.h.threadId||1,lastError:this.h.lastError,tls:this.h.tls};}
  scheduler(operation){if(!this.h.scheduler)throw new GuestFault(`${operation} requires a guest thread scheduler`);return this.h.scheduler;}
  error(context,code,result=0){context.lastError=code;return result;}
  thread(handle){
    if(handle!==0xfffffffe)return this.h.getHandle(handle,'thread');
    const context=this.context();
    if(!this.threads.has(context.id))this.threads.set(context.id,{kind:'thread',id:context.id,cpu:this.h.currentCPU,state:'running',exitCode:259,suspendCount:0});
    return this.threads.get(context.id);
  }
  create(entry,arg,flags,stackSize,idPointer=0){
    const scheduler=this.scheduler('CreateThread');
    if(flags&~4)throw new GuestFault('Unsupported CreateThread flags',{flags});
    if(idPointer)this.h.check(idPointer,4);
    const item=scheduler.create(entry,arg,flags,stackSize);
    if(!item||item.kind!=='thread'||!Number.isInteger(item.id)||!['running','suspended'].includes(item.state))throw new GuestFault('Thread scheduler returned an invalid thread object');
    item.suspendCount??=(flags&4?1:0);item.exitCode??=259;item.priority??=0;
    this.threads.set(item.id,item);
    if(idPointer)this.h.w32(idPointer,item.id);
    return this.h.handle(item);
  }
  resume(handle){const item=this.thread(handle);if(!item)return INFINITE;const scheduler=this.scheduler('ResumeThread');const previous=scheduler.resume(item);this.notify();return previous;}
  exit(code){const id=this.context().id;return this.scheduler('ExitThread').exit(code,id);}
  timer(milliseconds,callback){
    if(milliseconds===INFINITE)return()=>{};
    const deadline=Date.now()+milliseconds;let timer;
    const tick=()=>{const remaining=deadline-Date.now();if(remaining<=0)callback();else timer=setTimeout(tick,Math.min(remaining,0x7fffffff));};
    timer=setTimeout(tick,Math.min(milliseconds,0x7fffffff));return()=>clearTimeout(timer);
  }
  sleep(milliseconds){
    if(!milliseconds)return 0;this.scheduler('Sleep');
    return new Promise((resolve,reject)=>{
      const sleeper={reject:problem=>{sleeper.cancelTimer();this.sleeps.delete(sleeper);reject(problem);}};
      sleeper.cancelTimer=this.timer(milliseconds,()=>{this.sleeps.delete(sleeper);resolve(0);});this.sleeps.add(sleeper);
    });
  }
  ready(item,id){
    if(item.kind==='event')return item.signal;
    if(item.kind==='mutex')return !item.owner||item.owner===id;
    if(item.kind==='semaphore')return item.count>0;
    if(item.kind==='thread')return item.state==='exited';
    if(item.kind==='file')return item.ioSignal!==false;
    return false;
  }
  acquire(item,id){
    let abandoned=false;
    if(item.kind==='event'&&!item.manual)item.signal=false;
    if(item.kind==='semaphore')item.count--;
    if(item.kind==='mutex'){abandoned=!!item.abandoned;item.abandoned=false;item.owner=id;item.recursion++;}
    return abandoned;
  }
  attempt(waiter){
    const {objects,all,context}=waiter,id=context.id;
    if(all){
      if(!objects.every(item=>this.ready(item,id)))return null;
      let abandoned=false;for(const item of objects)abandoned=this.acquire(item,id)||abandoned;
      return abandoned?0x80:0;
    }
    const index=objects.findIndex(item=>this.ready(item,id));
    if(index<0)return null;return (this.acquire(objects[index],id)?0x80:0)+index;
  }
  wait(ids,all,milliseconds){
    const context=this.context();
    if(!ids.length||ids.length>64||new Set(ids).size!==ids.length)return this.error(context,87,INFINITE);
    const objects=ids.map(id=>this.h.getHandle(id));
    if(objects.some(item=>!item||!['event','mutex','semaphore','thread','file'].includes(item.kind)))return this.error(context,6,INFINITE);
    const waiter={objects,all,context};
    const result=this.attempt(waiter);if(result!==null)return result;if(!milliseconds)return TIMEOUT;
    this.scheduler('Blocking WaitForSingle/MultipleObjects');
    return new Promise((resolve,reject)=>{
      waiter.resolve=value=>{const index=this.waiters.indexOf(waiter);if(index<0)return;this.waiters.splice(index,1);waiter.cancelTimer();resolve(value);};
      waiter.reject=problem=>{const index=this.waiters.indexOf(waiter);if(index<0)return;this.waiters.splice(index,1);waiter.cancelTimer();reject(problem);};
      waiter.cancelTimer=this.timer(milliseconds,()=>waiter.resolve(TIMEOUT));this.waiters.push(waiter);
    });
  }
  // A callback returning null means "not ready"; any other value completes.
  // Both callbacks close over the initiating context, never global currentCPU.
  until(check,milliseconds,onTimeout){
    const initial=check();if(initial!==null)return initial;if(!milliseconds)return onTimeout();
    this.scheduler('Blocking guest operation');
    return new Promise((resolve,reject)=>{
      const waiter={check};
      waiter.resolve=value=>{const index=this.conditions.indexOf(waiter);if(index<0)return;this.conditions.splice(index,1);waiter.cancelTimer();resolve(value);};
      waiter.reject=problem=>{const index=this.conditions.indexOf(waiter);if(index<0)return;this.conditions.splice(index,1);waiter.cancelTimer();reject(problem);};
      waiter.cancelTimer=this.timer(milliseconds,()=>{try{waiter.resolve(onTimeout());}catch(problem){waiter.reject(problem);}});this.conditions.push(waiter);
    });
  }
  notify(){
    for(const waiter of [...this.waiters]){const result=this.attempt(waiter);if(result!==null)waiter.resolve(result);}
    for(const waiter of [...this.conditions]){try{const result=waiter.check();if(result!==null)waiter.resolve(result);}catch(problem){waiter.reject(problem);}}
  }
  cancel(reason){
    const problem=reason instanceof Error?reason:new GuestFault('Guest thread scheduler stopped');
    for(const waiter of [...this.waiters,...this.conditions])waiter.reject(problem);
    for(const sleeper of [...this.sleeps])sleeper.reject(problem);
    for(const waiter of this.criticalWaiters){waiter.problem=problem;waiter.reject(problem);}
    for(const item of this.critical.values())for(const waiter of item.queue.splice(0))waiter.reject(problem);
  }
  threadChanged(item){
    if(item.state==='exited')this.threads.delete(item.id);else this.threads.set(item.id,item);
    if(item.state==='exited'){
      const objects=new Set([...this.h.handles.values(),...this.waiters.flatMap(waiter=>waiter.objects)]);
      for(const object of objects)if(object.kind==='mutex'&&object.owner===item.id){object.owner=0;object.recursion=0;object.abandoned=true;}
    }
    this.notify();
  }
  // Atomics need aligned words. Warcraft also places some sections at 2-byte
  // aligned addresses (packed structures); those stay broker objects below.
  alignedCritical(pointer){return !((this.h.check(pointer,24))&3);}
  criticalWords(pointer){const at=this.h.check(pointer,24);return [this.h._i32,at>>>2];}
  initializeCritical(pointer,spin=0){
    if(!this.alignedCritical(pointer))return this._initializeMapped(pointer,spin);
    const [words,base]=this.criticalWords(pointer);
    for(let i=0;i<6;i++)Atomics.store(words,base+i,0);
    Atomics.store(words,base+CS_LOCK_COUNT,-1);Atomics.store(words,base+CS_SPIN,spin|0);
  }
  _acquired(words,base,recursion){
    Atomics.store(words,base+CS_RECURSION,recursion);
    Atomics.store(words,base+CS_LOCK_COUNT,recursion-1+Atomics.load(words,base+CS_WAITERS));
  }
  enterCritical(pointer,tryOnly=false){
    if(!this.alignedCritical(pointer))return this._enterMapped(pointer,tryOnly);
    const id=this.context().id;let [words,base]=this.criticalWords(pointer);
    const owner=Atomics.compareExchange(words,base+CS_OWNER,0,id);
    if(owner===0||owner===id){this._acquired(words,base,owner?Atomics.load(words,base+CS_RECURSION)+1:1);return tryOnly?1:undefined;}
    if(tryOnly)return 0;
    if(this.h.blockingWaits){
      // A guest worker blocks like the Win32 thread it runs.
      Atomics.add(words,base+CS_WAITERS,1);
      try{
        for(;;){
          const current=Atomics.load(words,base+CS_OWNER);
          if(current===0&&Atomics.compareExchange(words,base+CS_OWNER,0,id)===0)break;
          Atomics.wait(words,base+CS_OWNER,current,1000);
        }
      }finally{Atomics.sub(words,base+CS_WAITERS,1);}
      this._acquired(words,base,1);return undefined;
    }
    this.scheduler('Contended critical section');
    return this._enterAsync(pointer,id);
  }
  async _enterAsync(pointer,id){
    let [words,base]=this.criticalWords(pointer);
    const waiter={},cancelled=new Promise((_,reject)=>{waiter.reject=reject;});cancelled.catch(()=>{});
    this.criticalWaiters.add(waiter);Atomics.add(words,base+CS_WAITERS,1);
    try{
      for(;;){
        if(waiter.problem)throw waiter.problem;
        [words,base]=this.criticalWords(pointer);
        const current=Atomics.load(words,base+CS_OWNER);
        if(current===0&&Atomics.compareExchange(words,base+CS_OWNER,0,id)===0)break;
        const wait=Atomics.waitAsync(words,base+CS_OWNER,current,1000);
        if(wait.async)await Promise.race([wait.value,cancelled]);
      }
    }finally{this.criticalWaiters.delete(waiter);Atomics.sub(words,base+CS_WAITERS,1);}
    this._acquired(words,base,1);
  }
  leaveCritical(pointer){
    if(!this.alignedCritical(pointer))return this._leaveMapped(pointer);
    const id=this.context().id,[words,base]=this.criticalWords(pointer),recursion=Atomics.load(words,base+CS_RECURSION);
    if(Atomics.load(words,base+CS_OWNER)!==id||recursion<1)throw new GuestFault('Critical section is not owned by the calling thread');
    Atomics.store(words,base+CS_RECURSION,recursion-1);
    const waiting=Atomics.load(words,base+CS_WAITERS);Atomics.store(words,base+CS_LOCK_COUNT,recursion-2+waiting);
    if(recursion===1){Atomics.store(words,base+CS_OWNER,0);if(Atomics.load(words,base+CS_WAITERS))Atomics.notify(words,base+CS_OWNER);}
  }
  deleteCritical(pointer){
    if(!this.alignedCritical(pointer))return this._deleteMapped(pointer);
    const [words,base]=this.criticalWords(pointer);
    if(Atomics.load(words,base+CS_OWNER)||Atomics.load(words,base+CS_WAITERS))throw new GuestFault('Deleting an owned or contended critical section');
  }
  // Unaligned sections: broker-owned state mirrored into the structure. Only
  // the broker runs these; worker imports forward them (worker-fast.mjs).
  _criticalFields(pointer,item){this.h.w32(pointer+4,item.recursion+item.queue.length-1);this.h.w32(pointer+8,item.recursion);this.h.w32(pointer+12,item.owner);}
  _initializeMapped(pointer,spin){
    if(this.critical.get(pointer)?.owner)throw new GuestFault('Reinitializing an owned critical section');
    this.h.zero(pointer,24);const item={owner:0,recursion:0,queue:[],spin};this.critical.set(pointer,item);this.h.w32(pointer+20,spin);this._criticalFields(pointer,item);
  }
  _enterMapped(pointer,tryOnly){
    const item=this.critical.get(pointer),context=this.context();if(!item)throw new GuestFault('Uninitialized critical section');
    if(!item.owner||item.owner===context.id){item.owner=context.id;item.recursion++;this._criticalFields(pointer,item);return tryOnly?1:undefined;}
    if(tryOnly)return 0;this.scheduler('Contended critical section');
    return new Promise((resolve,reject)=>{item.queue.push({context,resolve,reject});this._criticalFields(pointer,item);});
  }
  _leaveMapped(pointer){
    const item=this.critical.get(pointer),context=this.context();
    if(!item||item.owner!==context.id||!item.recursion)throw new GuestFault('Critical section is not owned by the calling thread');
    item.recursion--;
    if(!item.recursion){item.owner=0;const next=item.queue.shift();if(next){item.owner=next.context.id;item.recursion=1;next.resolve(0);}}
    this._criticalFields(pointer,item);
  }
  _deleteMapped(pointer){const item=this.critical.get(pointer);if(item?.owner||item?.queue.length)throw new GuestFault('Deleting an owned or contended critical section');this.critical.delete(pointer);}
}
