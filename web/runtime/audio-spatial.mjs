// Software spatial output. Coordinates here use Web Audio's right-handed
// system; the Miles adapter converts its left-handed positions and velocities.
const vector=(value,fallback)=>{
  const result=value===undefined?fallback:Array.from(value);
  if(result.length!==3||!result.every(Number.isFinite))throw new Error('Spatial audio requires finite three-component vectors');return result;
};
const number=(value,fallback,min,max)=>{
  value=value??fallback;if(!Number.isFinite(value)||value<min||value>max)throw new Error('Spatial audio parameter is outside its valid range');return value;
};
export function spatialDescription(value={}){
  const result={position:vector(value.position,[0,0,0]),orientation:vector(value.orientation,[0,0,-1]),
    refDistance:number(value.refDistance,1,0,1e12),maxDistance:number(value.maxDistance,10000,0,1e12),
    rolloff:number(value.rolloff,1,0,1),distanceGain:number(value.distanceGain,1,0,1),coneInner:number(value.coneInner,360,0,360),coneOuter:number(value.coneOuter,360,0,360),
    coneGain:number(value.coneGain,1,0,1),obstruction:number(value.obstruction,0,0,1),occlusion:number(value.occlusion,0,0,1),
    wet:number(value.wet,0,0,1),decay:number(value.decay,1.5,.05,20)};
  if(result.maxDistance<result.refDistance||result.coneOuter<result.coneInner)throw new Error('Spatial audio distance or cone limits are reversed');return result;
}
// AudioParams where the browser has them (positionX…, forwardX…, upX…).
// Firefox's AudioListener has none of them, older Safari's PannerNode neither;
// every browser keeps the older setters, setPosition and setOrientation.
const hasParameters=(target,...prefixes)=>prefixes.every(prefix=>[...'XYZ'].every(axis=>target[prefix+axis]));
function parameters(target,prefix,values,time){for(let i=0;i<3;i++)target[prefix+'XYZ'[i]].setValueAtTime(values[i],time);}
export function setListener(context,value={}){
  const position=vector(value.position,[0,0,0]),forward=vector(value.forward,[0,0,-1]),up=vector(value.up,[0,1,0]);
  if(!Math.hypot(...forward)||!Math.hypot(...up))throw new Error('Listener orientation must be nonzero');
  const listener=context.listener,time=context.currentTime;
  if(hasParameters(listener,'position'))parameters(listener,'position',position,time);else listener.setPosition(...position);
  if(hasParameters(listener,'forward','up')){parameters(listener,'forward',forward,time);parameters(listener,'up',up,time);}
  else listener.setOrientation(...forward,...up);
}
function impulse(context,seconds){
  // A bounded, deterministic stereo room response. This is the software
  // provider's acoustic model, not an emulation of an EAX hardware preset.
  const length=Math.ceil(context.sampleRate*seconds),buffer=context.createBuffer(2,length,context.sampleRate);
  let state=0x6d2b79f5;
  for(let channel=0;channel<2;channel++){
    const data=buffer.getChannelData(channel);for(let i=0;i<length;i++){
      state=(Math.imul(state,1664525)+1013904223)>>>0;
      data[i]=(state/2147483648-1)*Math.exp(-6.91*i/length);
    }
  }
  return buffer;
}
export function spatialNodes(context,input,value,output=context.destination){
  const panner=context.createPanner(),filter=context.createBiquadFilter(),attenuation=context.createGain(),send=context.createGain(),reverb=context.createConvolver();
  panner.panningModel='equalpower';panner.distanceModel='linear';filter.type='lowpass';filter.Q.value=Math.SQRT1_2;
  input.connect(filter);filter.connect(attenuation);attenuation.connect(panner);panner.connect(output);
  panner.connect(send);send.connect(reverb);reverb.connect(output);
  let decay=null,tail=null,closed=false;
  const disconnect=()=>{
    if(closed)return;closed=true;
    if(tail){tail.onended=null;tail.stop();tail.disconnect();tail=null;}
    filter.disconnect();attenuation.disconnect();panner.disconnect();send.disconnect();reverb.disconnect();
  };
  const finish=()=>{
    if(closed||tail)return;
    if(!decay){disconnect();return;}
    // Schedule cleanup in audio time, so offline rendering also retains the
    // convolver's response after the dry sample ends. Explicit stop cancels it.
    tail=context.createBufferSource();tail.buffer=context.createBuffer(1,1,context.sampleRate);tail.loop=true;
    tail.connect(output);tail.onended=disconnect;tail.start();tail.stop(context.currentTime+decay);
  };
  const update=description=>{
    const s=spatialDescription(description),time=context.currentTime;
    if(hasParameters(panner,'position'))parameters(panner,'position',s.position,time);else panner.setPosition(...s.position);
    if(hasParameters(panner,'orientation'))parameters(panner,'orientation',s.orientation,time);else panner.setOrientation(...s.orientation);
    panner.refDistance=s.refDistance;panner.maxDistance=Math.max(s.refDistance+1e-6,s.maxDistance);panner.rolloffFactor=s.rolloff;
    panner.coneInnerAngle=s.coneInner;panner.coneOuterAngle=s.coneOuter;panner.coneOuterGain=s.coneGain;
    attenuation.gain.setValueAtTime((1-s.obstruction)*s.distanceGain,time);filter.frequency.setValueAtTime(Math.min(context.sampleRate*.49,22000)*Math.pow(1/22,s.occlusion),time);
    send.gain.setValueAtTime(s.wet,time);if(s.wet&&decay!==s.decay){reverb.buffer=impulse(context,s.decay);decay=s.decay;}
  };
  try{update(value);}catch(error){disconnect();throw error;}
  return{update,disconnect,finish};
}
