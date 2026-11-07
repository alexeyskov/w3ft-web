// PCM mixing plus browser decoding for supported file containers (MP3/WAV).
import {spatialDescription,spatialNodes,setListener} from './audio-spatial.mjs';
export class AudioHostError extends Error {
  constructor(message){super(`PCM audio: ${message}`);this.name='AudioHostError';}
}
function validateVolume(value){if(!Number.isFinite(value)||value<0||value>1)throw new AudioHostError('volume must be in [0, 1]');return value;}

export function decodePCM({data,format,channels,sampleRate}) {
  if(!(data instanceof Uint8Array))throw new AudioHostError('PCM data must be Uint8Array');
  if(![1,2].includes(channels))throw new AudioHostError('only mono and stereo PCM are supported');
  if(!Number.isInteger(sampleRate)||sampleRate<3000||sampleRate>192000)throw new AudioHostError('sample rate must be an integer from 3000 to 192000 Hz');
  const width={u8:1,s16le:2,f32le:4}[format];
  if(!width)throw new AudioHostError(`unsupported PCM format ${format}`);
  const frameSize=channels*width;
  if(!data.length||data.length%frameSize)throw new AudioHostError('PCM length must contain complete nonempty sample frames');
  const frames=data.length/frameSize;
  const samples=Array.from({length:channels},()=>new Float32Array(frames));
  const view=new DataView(data.buffer,data.byteOffset,data.byteLength);
  for(let frame=0;frame<frames;frame++)for(let channel=0;channel<channels;channel++){
    const offset=(frame*channels+channel)*width;
    const value=format==='u8'?(view.getUint8(offset)-128)/128:format==='s16le'?view.getInt16(offset,true)/32768:view.getFloat32(offset,true);
    if(!Number.isFinite(value)||value < -1||value > 1)throw new AudioHostError('float PCM samples must be finite and in [-1, 1]');
    samples[channel][frame]=value;
  }
  return {samples,frames,channels,sampleRate,duration:frames/sampleRate};
}

export class PCMPlayer {
  constructor({context,contextFactory,muted=false}={}) {
    this.context=context||null;
    this.contextFactory=contextFactory||(()=>{
      const Constructor=globalThis.AudioContext||globalThis.webkitAudioContext;
      if(!Constructor)throw new AudioHostError('Web Audio is unavailable');
      return new Constructor();
    });
    this.ownsContext=!context;this.buffers=new Map();this.voices=new Map();
    this.nextBuffer=1;this.nextVoice=1;this.destroyed=false;
    this.muted=!!muted;this.output=null;
  }
  _context(){
    if(this.destroyed)throw new AudioHostError('player was destroyed');if(!this.context)this.context=this.contextFactory();if(this.context.state==='closed')throw new AudioHostError('AudioContext is closed');
    if(!this.output){this.output=this.context.createGain();this.output.gain.value=this.muted?0:1;this.output.connect(this.context.destination);}
    return this.context;
  }
  setMuted(muted){this.muted=!!muted;if(this.output)this.output.gain.setValueAtTime(this.muted?0:1,this.context.currentTime);}
  async unlock(){const context=this._context();await context.resume();if(context.state!=='running')throw new AudioHostError('AudioContext remains suspended; a user gesture is required');}
  createBuffer(description){
    const pcm=decodePCM(description),context=this._context();
    const buffer=context.createBuffer(pcm.channels,pcm.frames,pcm.sampleRate);
    for(let channel=0;channel<pcm.channels;channel++)buffer.getChannelData(channel).set(pcm.samples[channel]);
    const id=this.nextBuffer++;this.buffers.set(id,buffer);return id;
  }
  async createEncodedBuffer(data){
    if(!(data instanceof Uint8Array)||!data.length||data.length>128*1024*1024)throw new AudioHostError('invalid encoded audio size');
    const buffer=await this._context().decodeAudioData(data.slice().buffer);
    if(this.destroyed)throw new AudioHostError('player was destroyed during decoding');
    if(!buffer.length||!Number.isFinite(buffer.duration)||buffer.duration<=0)throw new AudioHostError('decoder returned empty audio');
    const id=this.nextBuffer++;this.buffers.set(id,buffer);return id;
  }
  bufferInfo(id,field){
    const buffer=this.buffers.get(id);if(!buffer)throw new AudioHostError(`unknown buffer ${id}`);
    if(!['duration','length','numberOfChannels','sampleRate'].includes(field))throw new AudioHostError('invalid buffer metadata field');
    return buffer[field];
  }
  deleteBuffer(id){if(!this.buffers.has(id))throw new AudioHostError(`unknown buffer ${id}`);for(const [voiceId,voice] of this.voices)if(voice.bufferId===id)this.stop(voiceId);this.buffers.delete(id);}
  _voice(id){const voice=this.voices.get(id);if(!voice)throw new AudioHostError(`unknown voice ${id}`);return voice;}
  _start(voice){
    const context=this._context();
    if(context.state!=='running'&&typeof context.startRendering!=='function')throw new AudioHostError('AudioContext must be unlocked before playback');
    const source=context.createBufferSource();source.buffer=voice.buffer;source.loop=voice.loop;
    if(source.playbackRate)source.playbackRate.value=voice.playbackRate;
    const gain=context.createGain();gain.gain.value=voice.volume;source.connect(gain);
    const panner=voice.spatial?null:context.createStereoPanner?.(),spatial=voice.spatial?spatialNodes(context,gain,voice.spatial,this.output):null;
    if(panner){panner.pan.value=voice.pan;gain.connect(panner);panner.connect(this.output);}else if(!spatial){
      if(voice.pan)throw new AudioHostError('stereo panner is unavailable');gain.connect(this.output);
    }
    voice.source=source;voice.gain=gain;voice.panner=panner;voice.spatialNodes=spatial;voice.startedAt=context.currentTime;voice.state='playing';
    source.onended=()=>{if(voice.source!==source)return;voice.offset=voice.buffer.duration;voice.state='ended';voice.source=null;source.disconnect();gain.disconnect();panner?.disconnect();spatial?.finish();voice.gain=null;voice.panner=null;};
    try{source.start(0,voice.offset);}catch(error){source.onended=null;source.disconnect();gain.disconnect();panner?.disconnect();spatial?.disconnect();voice.source=null;voice.gain=null;voice.panner=null;voice.spatialNodes=null;voice.state='paused';throw new AudioHostError(`could not start source: ${error.message}`);}
  }
  play(bufferId,{loop=false,volume=1,offset=0,pan=0,playbackRate=1,spatial=null}={}) {
    const buffer=this.buffers.get(bufferId);if(!buffer)throw new AudioHostError(`unknown buffer ${bufferId}`);
    validateVolume(volume);if(typeof loop!=='boolean')throw new AudioHostError('loop must be boolean');
    if(!Number.isFinite(pan)||pan< -1||pan>1)throw new AudioHostError('pan must be in [-1, 1]');
    if(!Number.isFinite(playbackRate)||playbackRate<=0)throw new AudioHostError('playback rate must be positive');
    if(!Number.isFinite(offset)||offset<0||offset>=buffer.duration)throw new AudioHostError('playback offset is outside the buffer');
    const id=this.nextVoice++,voice={bufferId,buffer,loop,volume,offset,pan,playbackRate,spatial:spatial?spatialDescription(spatial):null,state:'paused',source:null,gain:null,startedAt:0};
    this._start(voice);this.voices.set(id,voice);return id;
  }
  playPCM(description,options){const buffer=this.createBuffer(description);try{return this.play(buffer,options);}catch(error){this.buffers.delete(buffer);throw error;}}
  getPosition(id){const voice=this._voice(id);let position=voice.offset;if(voice.state==='playing')position+=(this._context().currentTime-voice.startedAt)*voice.playbackRate;return voice.loop?position%voice.buffer.duration:Math.min(voice.buffer.duration,position);}
  getState(id){const voice=this._voice(id);if(voice.state==='playing'&&!voice.loop&&this.getPosition(id)>=voice.buffer.duration)return 'ended';return voice.state;}
  _detach(voice){if(voice.source){voice.source.onended=null;voice.source.stop();voice.source.disconnect();voice.source=null;}if(voice.gain){voice.gain.disconnect();voice.gain=null;}if(voice.panner){voice.panner.disconnect();voice.panner=null;}voice.spatialNodes?.disconnect();voice.spatialNodes=null;}
  pause(id){const voice=this._voice(id);if(voice.state!=='playing')throw new AudioHostError('only a playing voice can be paused');voice.offset=this.getPosition(id);this._detach(voice);voice.state=voice.offset>=voice.buffer.duration?'ended':'paused';return voice.offset;}
  resume(id){const voice=this._voice(id);if(voice.state!=='paused')throw new AudioHostError('only a paused voice can resume');this._start(voice);}
  stop(id){const voice=this._voice(id);this._detach(voice);voice.offset=0;voice.state='stopped';}
  releaseVoice(id){this.stop(id);this.voices.delete(id);}
  setVolume(id,volume){const voice=this._voice(id);voice.volume=validateVolume(volume);if(voice.gain)voice.gain.gain.setValueAtTime(volume,this._context().currentTime);}
  setPan(id,pan){
    if(!Number.isFinite(pan)||pan< -1||pan>1)throw new AudioHostError('pan must be in [-1, 1]');
    const voice=this._voice(id);if(voice.source&&!voice.panner&&pan)throw new AudioHostError('stereo panner is unavailable');
    voice.pan=pan;if(voice.panner)voice.panner.pan.setValueAtTime(pan,this._context().currentTime);
  }
  setPlaybackRate(id,rate){
    if(!Number.isFinite(rate)||rate<=0)throw new AudioHostError('playback rate must be positive');
    const voice=this._voice(id);voice.offset=this.getPosition(id);voice.startedAt=this._context().currentTime;voice.playbackRate=rate;
    if(voice.source)voice.source.playbackRate.value=rate;
  }
  setSpatial(id,value){const voice=this._voice(id);if(!voice.spatial)throw new AudioHostError('voice is not spatial');const next=spatialDescription(value);voice.spatialNodes?.update(next);voice.spatial=next;}
  setListener(value){setListener(this._context(),value);}
  async destroy(){if(this.destroyed)return;for(const id of this.voices.keys())this.stop(id);this.voices.clear();this.buffers.clear();this.output?.disconnect();this.output=null;this.destroyed=true;if(this.context&&this.ownsContext&&this.context.state!=='closed')await this.context.close();}
}
