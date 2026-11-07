// Win32 TLS indices are process-wide; values and last-error belong to a thread.
// The broker and that thread's Worker use the same storage, including while a
// broker import is suspended. No RPC result or last-error value is cached.
export const TLS_CAPACITY=1088;
const STATE_WORDS=1+TLS_CAPACITY*2;
function words(buffer,length){
  if(!(buffer instanceof SharedArrayBuffer)||buffer.byteLength!==length*4)throw new TypeError('Invalid shared Win32 thread state');
  return new Uint32Array(buffer);
}
const valid=index=>Number.isInteger(index)&&index>=0&&index<TLS_CAPACITY;

export class TlsSlots {
  constructor(buffer=new SharedArrayBuffer(TLS_CAPACITY*4)){this.words=words(buffer,TLS_CAPACITY);}
  get buffer(){return this.words.buffer;}
  has(index){return valid(index)&&Atomics.load(this.words,index)!==0;}
  available(){for(let i=0;i<TLS_CAPACITY;i++)if(!this.has(i))return i;return -1;}
  add(index){if(!valid(index))throw new RangeError('Invalid TLS index');Atomics.store(this.words,index,1);}
  delete(index){return valid(index)&&Atomics.exchange(this.words,index,0)!==0;}
}

class ThreadTls {
  constructor(state){this.words=state;}
  has(index){return valid(index)&&Atomics.load(this.words,1+index*2)!==0;}
  get(index){return this.has(index)?Atomics.load(this.words,2+index*2):undefined;}
  set(index,value){
    if(!valid(index))throw new RangeError('Invalid TLS index');
    Atomics.store(this.words,2+index*2,value>>>0);Atomics.store(this.words,1+index*2,1);return this;
  }
  delete(index){
    if(!valid(index))return false;
    const previous=Atomics.exchange(this.words,1+index*2,0);Atomics.store(this.words,2+index*2,0);return !!previous;
  }
}

export function threadContext(id,buffer=new SharedArrayBuffer(STATE_WORDS*4)){
  const state=words(buffer,STATE_WORDS);
  return {id,buffer,tls:new ThreadTls(state),
    get lastError(){return Atomics.load(state,0);},
    set lastError(value){Atomics.store(state,0,value>>>0);}};
}
