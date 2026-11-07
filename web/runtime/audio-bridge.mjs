import {AudioHostError} from './audio.mjs';

// Guest HLE is synchronous. A worker waits for each main-thread WebAudio
// operation to complete, so its return value never predicts playback success.
// Only the worker calls Atomics.wait; the browser main thread remains runnable.
const HEADER=16,ERROR_BYTES=4096,CONTROL_BYTES=HEADER+ERROR_BYTES;
const STATES=Object.freeze({playing:1,paused:2,ended:3,stopped:4});
const STATE_NAMES=Object.fromEntries(Object.entries(STATES).map(([name,value])=>[value,name]));
const fail=message=>{throw new AudioHostError(message);};
const validId=id=>Number.isSafeInteger(id)&&id>0;

export class WorkerAudio {
  constructor({post=(message,transfer)=>globalThis.postMessage(message,transfer),
               wait=(view,expected,timeout)=>Atomics.wait(view,0,expected,timeout),
               timeout=5000,trace=()=>[]}={}) {
    if(typeof SharedArrayBuffer!=='function')fail('audio bridge requires SharedArrayBuffer');
    if(!Number.isFinite(timeout)||timeout<=0)fail('invalid audio RPC timeout');
    this.post=post;this.wait=wait;this.timeout=timeout;this.trace=trace;
    this.control=new SharedArrayBuffer(CONTROL_BYTES);this.sequence=0;
    this.nextBuffer=1;this.nextVoice=1;this.buffers=new Set();this.voices=new Set();this.failed=false;
  }
  _request(method,fields={},transfer=[]) {
    if(this.failed)fail('audio bridge is unavailable after a timeout');
    const status=new Int32Array(this.control,0,1),view=new DataView(this.control),sequence=++this.sequence;
    Atomics.store(status,0,0);view.setUint32(4,0,true);view.setFloat64(8,0,true);
    const guestTrace=this.trace();
    this.post({type:'audio',method,sequence,control:this.control,guestTrace,...fields},transfer);
    // The dispatcher may finish synchronously in tests or before wait begins.
    while(Atomics.load(status,0)===0){
      const result=this.wait(status,0,this.timeout);
      if(result==='timed-out'&&Atomics.compareExchange(status,0,0,-2)===0){
        this.failed=true;const error=new AudioHostError(`main-thread ${method} timed out`);
        error.details={operation:method,sequence,guestTrace};throw error;
      }
    }
    if(Atomics.load(status,0)!==1){
      const length=Math.min(ERROR_BYTES,view.getUint32(4,true));
      // Browser TextDecoder rejects a view backed by SharedArrayBuffer.
      const message=new TextDecoder().decode(new Uint8Array(this.control,HEADER,length).slice());
      const error=new AudioHostError(`${method}: ${message||'main-thread request failed'}`);
      error.details={operation:method,sequence,guestTrace};throw error;
    }
    return view.getFloat64(8,true);
  }
  createBuffer(description){
    if(!(description?.data instanceof Uint8Array))fail('PCM data must be Uint8Array');
    const id=this.nextBuffer++,data=description.data.slice();
    this._request('createBuffer',{id,description:{...description,data}},[data.buffer]);
    this.buffers.add(id);return id;
  }
  createEncodedBuffer(bytes){
    if(!(bytes instanceof Uint8Array))fail('encoded data must be Uint8Array');
    const id=this.nextBuffer++,data=bytes.slice();this._request('createEncodedBuffer',{id,data},[data.buffer]);this.buffers.add(id);return id;
  }
  bufferInfo(id,field){return this._request('bufferInfo',{id,field});}
  play(bufferId,options={}){const id=this.nextVoice++;this._request('play',{id,bufferId,options:{...options}});this.voices.add(id);return id;}
  playPCM(description,options){const id=this.createBuffer(description);try{return this.play(id,options);}catch(error){try{this.deleteBuffer(id);}catch{}throw error;}}
  getPosition(id){return this._request('getPosition',{id});}
  getState(id){const code=this._request('getState',{id});return STATE_NAMES[code]||fail(`unknown remote voice state ${code}`);}
  pause(id){return this._request('pause',{id});}
  resume(id){this._request('resume',{id});}
  stop(id){this._request('stop',{id});}
  setVolume(id,volume){this._request('setVolume',{id,volume});}
  setPan(id,pan){this._request('setPan',{id,pan});}
  setPlaybackRate(id,rate){this._request('setPlaybackRate',{id,rate});}
  setSpatial(id,spatial){this._request('setSpatial',{id,spatial});}
  setListener(listener){this._request('setListener',{listener});}
  deleteBuffer(id){this._request('deleteBuffer',{id});this.buffers.delete(id);}
  releaseVoice(id){this._request('releaseVoice',{id});this.voices.delete(id);}
}

export class AudioDispatcher {
  constructor(player){this.player=player;this.buffers=new Map();this.voices=new Map();this.destroyed=false;}
  _id(map,id,kind){if(!validId(id)||!map.has(id))fail(`unknown remote ${kind} ${id}`);return map.get(id);}
  _execute(message){
    if(this.destroyed)fail('audio dispatcher was destroyed');
    const {method,id}=message;
    if(method==='setListener'){this.player.setListener(message.listener);return 0;}
    if(!validId(id))fail('invalid remote audio handle');
    if(method==='createBuffer'){
      if(this.buffers.has(id))fail(`duplicate remote buffer ${id}`);
      const native=this.player.createBuffer(message.description);this.buffers.set(id,native);return 0;
    }
    if(method==='createEncodedBuffer'){
      if(this.buffers.has(id))fail(`duplicate remote buffer ${id}`);
      return this.player.createEncodedBuffer(message.data).then(native=>{
        if(this.destroyed||Atomics.load(new Int32Array(message.control,0,1),0)!==0){this.player.deleteBuffer(native);return 0;}
        this.buffers.set(id,native);return 0;
      });
    }
    if(method==='bufferInfo')return this.player.bufferInfo(this._id(this.buffers,id,'buffer'),message.field);
    if(method==='play'){
      if(this.voices.has(id))fail(`duplicate remote voice ${id}`);
      const buffer=this._id(this.buffers,message.bufferId,'buffer');
      this.voices.set(id,this.player.play(buffer,message.options));return 0;
    }
    if(method==='deleteBuffer'){const native=this._id(this.buffers,id,'buffer');this.player.deleteBuffer(native);this.buffers.delete(id);return 0;}
    const native=this._id(this.voices,id,'voice');
    switch(method){
      case 'getPosition':return this.player.getPosition(native);
      case 'getState':{const state=this.player.getState(native);if(!(state in STATES))fail(`unsupported player state ${state}`);return STATES[state];}
      case 'pause':return this.player.pause(native);
      case 'resume':this.player.resume(native);return 0;
      case 'stop':this.player.stop(native);return 0;
      case 'setVolume':this.player.setVolume(native,message.volume);return 0;
      case 'setPan':this.player.setPan(native,message.pan);return 0;
      case 'setPlaybackRate':this.player.setPlaybackRate(native,message.rate);return 0;
      case 'setSpatial':this.player.setSpatial(native,message.spatial);return 0;
      case 'releaseVoice':this.player.releaseVoice(native);this.voices.delete(id);return 0;
      default:fail(`unsupported audio RPC method ${method}`);
    }
  }
  handle(message){
    if(!(message?.control instanceof SharedArrayBuffer)||message.control.byteLength!==CONTROL_BYTES)fail('invalid audio RPC control buffer');
    const status=new Int32Array(message.control,0,1),view=new DataView(message.control);
    // A timed-out worker cancels queued requests before they touch WebAudio.
    if(Atomics.load(status,0)!==0)return {ok:false,cancelled:true};
    const success=result=>{
      if(Atomics.load(status,0)!==0)return {ok:false,cancelled:true};
      if(!Number.isFinite(result))fail('audio RPC returned a nonnumeric result');
      view.setFloat64(8,result,true);Atomics.store(status,0,1);Atomics.notify(status,0);
      return {ok:true};
    };
    const failure=error=>{
      if(Atomics.load(status,0)!==0)return {ok:false,cancelled:true};
      const data=new TextEncoder().encode(error.message).subarray(0,ERROR_BYTES);
      new Uint8Array(message.control,HEADER,ERROR_BYTES).set(data);view.setUint32(4,data.length,true);
      Atomics.store(status,0,-1);Atomics.notify(status,0);
      return {ok:false,error:error.message,operation:message.method,sequence:message.sequence};
    };
    try{const result=this._execute(message);return result&&typeof result.then==='function'?result.then(success).catch(failure):success(result);}catch(error){return failure(error);}
  }
  async destroy(){if(this.destroyed)return;this.destroyed=true;try{await this.player.destroy();}finally{this.buffers.clear();this.voices.clear();}}
}
