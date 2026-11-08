import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {PCMPlayer} from '../web/runtime/audio.mjs';
import {WorkerAudio,AudioDispatcher} from '../web/runtime/audio-bridge.mjs';

class AudioContext {
  constructor(){this.state='running';this.currentTime=0;this.destination={};}
  createBuffer(channels,length,sampleRate){const data=Array.from({length:channels},()=>new Float32Array(length));return{duration:length/sampleRate,getChannelData:i=>data[i]};}
  createBufferSource(){return{connect(){},disconnect(){},start(){},stop(){}};}
  createGain(){return{gain:{value:1,setValueAtTime(v){this.value=v;}},connect(){},disconnect(){}};}
}

test('audio RPC waits for main PCMPlayer and preserves loop/pause/stop state across threads',async()=>{
  const context=new AudioContext(),player=new PCMPlayer({context}),dispatcher=new AudioDispatcher(player);
  const moduleUrl=new URL('../web/runtime/audio-bridge.mjs',import.meta.url).href;
  const script=`
    const {parentPort,workerData}=require('node:worker_threads');
    (async()=>{
      const {WorkerAudio}=await import(workerData.moduleUrl);
      const audio=new WorkerAudio({post:(m,t)=>parentPort.postMessage(m,t),trace:()=>[{name:'mss32.dll!_AIL_sample_status@4',returnAddress:1234}]});
      const original=new Uint8Array(8000).fill(128);
      const buffer=audio.createBuffer({data:original,format:'u8',channels:1,sampleRate:8000});
      const voice=audio.play(buffer,{loop:true,offset:.25});
      const first=audio.getPosition(voice),paused=audio.pause(voice),pauseState=audio.getState(voice);
      audio.resume(voice);const second=audio.getPosition(voice);audio.stop(voice);
      const stoppedPosition=audio.getPosition(voice),stoppedState=audio.getState(voice);
      audio.deleteBuffer(buffer);const afterDelete=audio.getState(voice);audio.releaseVoice(voice);
      let missing,invalid;
      try{audio.getState(voice);}catch(error){missing={message:error.message,details:error.details};}
      try{audio.createBuffer({data:new Uint8Array(3),format:'s16le',channels:2,sampleRate:8000});}catch(error){invalid={message:error.message,details:error.details};}
      parentPort.postMessage({type:'result',first,paused,pauseState,second,stoppedPosition,stoppedState,afterDelete,missing,invalid,originalLength:original.byteLength});
    })().catch(error=>parentPort.postMessage({type:'failure',message:error.stack}));
  `;
  const worker=new Worker(script,{eval:true,workerData:{moduleUrl}});let positionQueries=0;
  const result=await new Promise((resolve,reject)=>{
    worker.on('error',reject);
    worker.on('message',message=>{
      if(message.type==='audio'){
        if(message.method==='getPosition'){positionQueries++;if(positionQueries===1)context.currentTime=2.5;else if(positionQueries===2)context.currentTime=5.5;}
        if(message.method==='resume')context.currentTime=5;
        dispatcher.handle(message);
      }else if(message.type==='failure')reject(new Error(message.message));
      else if(message.type==='result')resolve(message);
    });
  });
  await worker.terminate();
  assert.equal(result.first,.75);assert.equal(result.paused,.75);assert.equal(result.pauseState,'paused');assert.equal(result.second,.25);
  assert.equal(result.stoppedPosition,0);assert.equal(result.stoppedState,'stopped');assert.equal(result.afterDelete,'stopped');assert.equal(result.originalLength,8000);
  assert.match(result.missing.message,/unknown remote voice/);assert.equal(result.missing.details.operation,'getState');assert.equal(result.missing.details.guestTrace[0].returnAddress,1234);
  assert.match(result.invalid.message,/complete nonempty sample frames/);assert.equal(result.invalid.details.operation,'createBuffer');
  assert.equal(dispatcher.voices.size,0);assert.equal(dispatcher.buffers.size,0);assert.equal(player.voices.size,0);assert.equal(player.buffers.size,0);
  await dispatcher.destroy();
});

test('timed out RPC cancels a queued command and reports guest call context',()=>{
  let message;const proxy=new WorkerAudio({post:value=>message=value,wait:()=> 'timed-out',timeout:1,trace:()=>[{name:'audio-call'}]});
  assert.throws(()=>proxy.createBuffer({data:new Uint8Array([128]),format:'u8',channels:1,sampleRate:8000}),error=>{
    assert.match(error.message,/timed out/);assert.equal(error.details.operation,'createBuffer');assert.equal(error.details.guestTrace[0].name,'audio-call');return true;
  });
  const dispatcher=new AudioDispatcher({createBuffer(){assert.fail('cancelled request must not allocate audio');}});
  assert.deepEqual(dispatcher.handle(message),{ok:false,cancelled:true});
  assert.throws(()=>proxy.getPosition(1),/unavailable after a timeout/);
});

test('main-thread WebAudio failure is acknowledged before a voice is returned',()=>{
  const context=new AudioContext();context.state='suspended';const player=new PCMPlayer({context}),dispatcher=new AudioDispatcher(player);
  const proxy=new WorkerAudio({post:message=>dispatcher.handle(message)});
  const buffer=proxy.createBuffer({data:new Uint8Array([128]),format:'u8',channels:1,sampleRate:8000});
  assert.throws(()=>proxy.play(buffer),error=>{assert.match(error.message,/unlocked/);assert.equal(error.details.operation,'play');return true;});
  assert.equal(proxy.voices.size,0);assert.equal(dispatcher.voices.size,0);proxy.deleteBuffer(buffer);
});

test('a long decode does not stop the worker: other audio requests are answered meanwhile',async()=>{
  const context=new AudioContext();let finish;
  context.decodeAudioData=()=>new Promise(resolve=>{finish=()=>resolve({length:44100,duration:1,numberOfChannels:2,sampleRate:44100});});
  const player=new PCMPlayer({context}),dispatcher=new AudioDispatcher(player);
  const audio=new WorkerAudio({post:message=>dispatcher.handle(message)});
  const decoding=audio.createEncodedBufferAsync(new Uint8Array([1,2,3]));
  const effect=audio.createBuffer({data:new Uint8Array(8000).fill(128),format:'u8',channels:1,sampleRate:8000});
  assert.ok(effect>0,'a sound effect while the track decodes');
  finish();
  const track=await decoding;
  assert.equal(audio.bufferInfo(track,'duration'),1);assert.equal(audio.bufferInfo(track,'numberOfChannels'),2);
  context.decodeAudioData=()=>Promise.reject(new Error('Unable to decode audio data'));
  await assert.rejects(audio.createEncodedBufferAsync(new Uint8Array([9])),/createEncodedBuffer: Unable to decode audio data$/);
  assert.equal(audio.failed,false,'one failed decode leaves the bridge working');
  await dispatcher.destroy();
});
