// Software implementation of the MSS 6.x spatial ABI. The compatibility name
// is in Warcraft's provider table; rendering uses our Web Audio PannerNodes,
// not the original Miles DLL, EAX hardware, or an external audio process.
export function installMilesSpatial(h,{state,add,audio,sample,sampleDefaults,releasePlayback,fail,integer,f32}){
  let providerId=0,namePointer=0;
  const available=()=>typeof h.audio?.setSpatial==='function'&&typeof h.audio?.setListener==='function';
  const error=message=>{state.error=message;return -1;};
  const provider=id=>h.getHandle(id,'miles-provider')||fail('Miles 3D provider','invalid handle');
  const opened=id=>{const p=provider(id);if(!p.open)fail('Miles 3D provider','provider is closed');return p;};
  const defaults=()=>({position:[0,0,0],forward:[0,0,1],up:[0,1,0],velocity:[0,0,0],userData:new Uint32Array(8)});
  const object=id=>{
    const value=h.handles.get(id);
    if(value?.kind==='miles-listener')return value;
    if(value?.kind==='miles-sample'&&value.spatial)return value.spatial;
    return fail('Miles 3D object','invalid handle');
  };
  const spatialSample=id=>{const s=sample(id);if(!s.spatial)fail('Miles 3D sample','not a spatial handle');return s;};
  const finite=value=>{value=f32(value);if(!Number.isFinite(value))fail('Miles 3D','non-finite float argument');return value;};
  const vector=(x,y,z)=>[finite(x),finite(y),finite(z)];
  const transform=(v,scale=1)=>[v[0]*scale,v[1]*scale,-v[2]*scale];
  const listener=p=>p.listener?h.getHandle(p.listener,'miles-listener'):null;
  const doppler=(o,p)=>{
    const l=listener(p);if(!l||!p.doppler)return 1;
    const delta=o.position.map((v,i)=>v-l.position[i]),length=Math.hypot(...delta);
    if(!length)return 1;
    // Miles velocities are distance units per millisecond; AudioBufferSource
    // playbackRate supplies Doppler because modern PannerNode has no velocity.
    const radial=v=>v.reduce((sum,x,i)=>sum+x*delta[i]/length,0)*1000*p.distance*p.doppler;
    const speed=343.3,clamp=v=>Math.max(-.95*speed,Math.min(.95*speed,v));
    return Math.max(.125,Math.min(8,(speed+clamp(radial(l.velocity)))/(speed+clamp(radial(o.velocity)))));
  };
  const description=o=>{const p=opened(o.provider),l=listener(p);
    // Mssfast.m3d 0x226028d0 stores both distances without rejecting their
    // order. Its mixer at 0x22601d40 caps distance at max, floors min at
    // 0.0001, then applies 6 dB per doubling. Reversed limits give full gain.
    // Web Audio's exponential model does not cap at maxDistance, so compute
    // this gain here and leave PannerNode responsible for direction/cones.
    const distance=Math.min(Math.hypot(...o.position.map((v,i)=>v-(l?.position[i]||0))),o.maxDistance);
    const reference=Math.max(.0001,o.minDistance),refDistance=reference*p.distance;
    const distanceGain=distance<=reference?1:Math.pow(10,-.3*Math.log2(distance/reference)*p.rolloff);
    return {
    position:transform(o.position,p.distance),orientation:transform(o.forward),
    refDistance,maxDistance:Math.max(refDistance,o.maxDistance*p.distance),rolloff:0,distanceGain,
    coneInner:o.coneInner,coneOuter:o.coneOuter,coneGain:o.coneVolume/127,
    obstruction:o.obstruction,occlusion:o.occlusion,wet:o.effects,decay:p.decay,
  };};
  state.spatialOptions=s=>s.spatial?{spatial:description(s.spatial),playbackRate:doppler(s.spatial,opened(s.spatial.provider))}:{};
  const refreshSample=s=>{if(s.voice!==null){audio().setSpatial(s.voice,description(s.spatial));audio().setPlaybackRate(s.voice,doppler(s.spatial,opened(s.spatial.provider)));}};
  const refresh=id=>{
    const p=opened(id),l=listener(p);
    if(l)audio().setListener({position:transform(l.position,p.distance),forward:transform(l.forward),up:transform(l.up)});
    for(const sid of p.samples)refreshSample(spatialSample(sid));
  };
  const changed=id=>{const o=object(id);if(o.kind==='miles-listener')refresh(o.provider);else refreshSample(spatialSample(id));};
  const release=id=>{const s=spatialSample(id);provider(s.spatial.provider).samples.delete(id);releasePlayback(s);state.samples.delete(id);h.handles.delete(id);};
  const close=id=>{
    const p=provider(id);for(const sid of [...p.samples])release(sid);
    if(p.listener)h.handles.delete(p.listener);p.listener=0;
    if(p.driver){state.drivers.delete(p.driver);h.handles.delete(p.driver);}p.driver=0;p.open=false;
  };
  state.closeSpatial=()=>{if(providerId)close(providerId);};
  add('AIL_enumerate_3D_providers',3,([cursor,out,name])=>{
    if(!available()){state.error='Spatial audio output is unavailable';return 0;}
    if(h.u32(cursor))return 0;
    if(!providerId)providerId=h.handle({kind:'miles-provider',open:false,driver:0,listener:0,samples:new Set()});
    if(!namePointer)namePointer=h.string('Miles Fast 2D Positional Audio');
    // RIB's enumeration cursor is the last provider handle, not an ordinal.
    h.w32(cursor,providerId);h.w32(out,providerId);h.w32(name,namePointer);return 1;
  });
  add('AIL_open_3D_provider',1,([id])=>{
    const p=provider(id);if(!state.started||!available())return error('Spatial audio is not started');
    if(p.open)return error('Spatial provider is already open');
    p.driver=h.handle({kind:'miles-driver',rate:44100,bits:16,channels:2,volume:1});state.drivers.add(p.driver);
    Object.assign(p,{open:true,distance:1,doppler:1,rolloff:1,room:0,decay:1.5,speakers:0});return 0;
  });
  add('AIL_close_3D_provider',1,([id])=>close(id));
  add('AIL_open_3D_listener',1,([id])=>{
    const p=opened(id);if(!p.listener)p.listener=h.handle({kind:'miles-listener',provider:id,...defaults()});
    refresh(id);return p.listener;
  });
  add('AIL_close_3D_listener',1,([id])=>{const l=object(id);if(l.kind!=='miles-listener')fail('Miles listener','invalid handle');provider(l.provider).listener=0;h.handles.delete(id);});
  add('AIL_allocate_3D_sample_handle',1,([id])=>{
    const p=opened(id);if(p.samples.size>=256){state.error='Spatial sample limit reached';return 0;}
    const spatial={provider:id,...defaults(),minDistance:1,maxDistance:10000,coneInner:360,coneOuter:360,coneVolume:127,obstruction:0,occlusion:0,effects:0};
    const sid=h.handle({...sampleDefaults(p.driver),spatial});p.samples.add(sid);state.samples.add(sid);return sid;
  });
  add('AIL_release_3D_sample_handle',1,([id])=>release(id));
  add('AIL_set_3D_sample_info',2,([id,info])=>{
    const s=spatialSample(id);h.check(info,36);
    const [format,data,length,rate,bits,channels]=Array.from({length:6},(_,i)=>h.u32(info+i*4));
    if(format!==1||![8,16].includes(bits)||![1,2].includes(channels)||rate<3000||rate>192000||!length||length>256*1024*1024||length%(channels*bits/8)){
      state.error='Invalid or unsupported 3D PCM sample format';return 0;
    }
    h.check(data,length);releasePlayback(s);Object.assign(s,{data,length,rate,bits,channels,offset:0,status:2,eosDelivered:false});return 1;
  });
  for(const [name,target,count] of [
    ['start_3D_sample','start_sample',1],['stop_3D_sample','stop_sample',1],['resume_3D_sample','resume_sample',1],['end_3D_sample','end_sample',1],
    ['3D_sample_status','sample_status',1],['set_3D_sample_volume','set_sample_volume',2],['3D_sample_volume','sample_volume',1],
    ['set_3D_sample_loop_count','set_sample_loop_count',2],['3D_sample_loop_count','sample_loop_count',1],
    ['set_3D_sample_playback_rate','set_sample_playback_rate',2],['3D_sample_playback_rate','sample_playback_rate',1],
    ['set_3D_sample_offset','set_sample_position',2],['3D_sample_offset','sample_position',1],['register_3D_EOS_callback','register_EOS_callback',2],
  ])add('AIL_'+name,count,args=>{spatialSample(args[0]);return h.handlers.get('mss32.dll!AIL_'+target).fn(args);});
  add('AIL_3D_sample_length',1,([id])=>spatialSample(id).length);
  add('AIL_set_3D_position',4,([id,x,y,z])=>{object(id).position=vector(x,y,z);changed(id);});
  add('AIL_set_3D_orientation',7,([id,x,y,z,ux,uy,uz])=>{
    const forward=vector(x,y,z),up=vector(ux,uy,uz);if(!Math.hypot(...forward)||!Math.hypot(...up))fail('Miles 3D orientation','zero direction');
    Object.assign(object(id),{forward,up});changed(id);
  });
  add('AIL_set_3D_velocity',5,([id,x,y,z,magnitude])=>{const scale=finite(magnitude);object(id).velocity=vector(x,y,z).map(v=>v*scale);changed(id);});
  add('AIL_set_3D_velocity_vector',4,([id,x,y,z])=>{object(id).velocity=vector(x,y,z);changed(id);});
  for(const [name,field,min,max] of [['distance','distance',1e-12,1e12],['doppler','doppler',0,10],['rolloff','rolloff',0,1]])
    add(`AIL_set_3D_${name}_factor`,2,([id,value])=>{value=finite(value);if(value<min||value>max)fail('Miles 3D factor','outside supported range');opened(id)[field]=value;refresh(id);});
  add('AIL_set_3D_sample_distances',3,([id,max,min])=>{
    max=finite(max);min=finite(min);
    Object.assign(spatialSample(id).spatial,{minDistance:min,maxDistance:max});changed(id);
  });
  add('AIL_3D_sample_distances',3,([id,max,min])=>{
    const s=spatialSample(id).spatial;
    if(max)h.view.setFloat32(h.check(max,4),s.maxDistance,true);
    if(min)h.view.setFloat32(h.check(min,4),s.minDistance,true);
  });
  add('AIL_set_3D_sample_cone',4,([id,inner,outer,volume])=>{
    inner=finite(inner);outer=finite(outer);integer('Miles cone volume',volume,0,127);
    if(inner<0||outer<inner||outer>360)fail('Miles 3D cone','invalid angles');
    Object.assign(spatialSample(id).spatial,{coneInner:inner,coneOuter:outer,coneVolume:volume});changed(id);
  });
  for(const [name,field] of [['obstruction','obstruction'],['occlusion','occlusion'],['effects_level','effects']])
    add('AIL_set_3D_sample_'+name,2,([id,value])=>{value=finite(value);if(value<0||value>1)fail('Miles 3D '+name,'outside [0,1]');spatialSample(id).spatial[field]=value;changed(id);});
  add('AIL_set_3D_user_data',3,([id,index,value])=>{integer('Miles user data index',index,0,7);object(id).userData[index]=value;});
  add('AIL_3D_user_data',2,([id,index])=>{integer('Miles user data index',index,0,7);return object(id).userData[index];});
  // Room types select bounded software reverberation times, without claiming
  // the EAX-specific frequency/delay preferences of a hardware provider.
  const decay=[1.5,.17,.4,1.49,.5,2.31,4.32,3.92,2.91,7.24,10.05,3.21,1.49,2.7,1.49,1.49,1.49,1.49,1.49,1.49,1.65,2.81,1.49,8.39,17.23,7.56];
  add('AIL_set_3D_room_type',2,([id,type])=>{integer('Miles room type',type,0,25);const p=opened(id);p.room=type;p.decay=decay[type];refresh(id);});
  add('AIL_3D_room_type',1,([id])=>opened(id).room);
  add('AIL_set_3D_speaker_type',2,([id,type])=>{if(type!==0&&type!==1)fail('Miles speakers','software provider supports stereo speakers or headphones');opened(id).speakers=type;});
  add('AIL_3D_provider_attribute',3,([id,name,out])=>{
    const p=provider(id),key=h.cstr(name);
    const values={'Maximum supported samples':256,'Provider version':0x100,'Provider name':namePointer};
    if(!(key in values))return error('Unsupported software provider attribute: '+key);
    h.w32(out,values[key]);return 1;
  });
  add('AIL_set_3D_provider_preference',3,([id,name,value])=>{opened(id);return error('Unsupported software provider preference: '+h.cstr(name));});
  add('AIL_3D_sample_attribute',3,([id,name,out])=>{spatialSample(id);return error('Unsupported software sample attribute: '+h.cstr(name));});
  add('AIL_set_3D_sample_preference',3,([id,name,value])=>{spatialSample(id);return error('Unsupported software sample preference: '+h.cstr(name));});
}
