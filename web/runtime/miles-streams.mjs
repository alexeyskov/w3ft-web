// Miles file callbacks remain guest code: they resolve MPQ paths and read the
// actual compressed bytes. The browser decodes and schedules the audio buffer.
export function installMilesStreams(h,{state,add,audio,driver,fail,integer,panValue}){
  const streams=new Set();
  const stream=id=>h.getHandle(id,'miles-stream')||fail('Miles stream','invalid handle');
  async function readFile(filename,cpu){
    const [open,close,seek,read]=state.fileCallbacks,out=h.alloc(4),scratch=h.alloc(65536);
    let file,opened=false;
    const kernel=(name,args)=>h.handlers.get('kernel32.dll!'+name).fn(args);
    const callback=(address,args)=>h.callAsync?h.callAsync(address,args,cpu):h.call(address,args);
    try{
      let length;
      if(open||close||seek||read){
        if(![open,close,seek,read].every(Boolean))fail('Miles file callbacks','all four callbacks are required');
        if(!await callback(open,[filename,out])){state.error='Unable to open audio file: '+h.cstr(filename);return null;}
        file=h.u32(out);opened=true;length=(await callback(seek,[file,0,2]))>>>0;
        if(((await callback(seek,[file,0,0]))>>>0)!==0)fail('Miles file callbacks','cannot seek to the start of audio');
      }else{
        file=kernel('CreateFileA',[filename,0x80000000,3,0,3,0,0]);
        if(file===0xffffffff){state.error='Unable to open audio file: '+h.cstr(filename);return null;}
        opened=true;length=kernel('GetFileSize',[file,0]);
      }
      integer('audio file bytes',length,1,128*1024*1024);
      const data=new Uint8Array(length);
      for(let offset=0;offset<length;){
        const count=Math.min(65536,length-offset);let received;
        if(read)received=(await callback(read,[file,scratch,count]))>>>0;
        else{if(!kernel('ReadFile',[file,scratch,count,out,0]))fail('Miles file','read failed');received=h.u32(out);}
        if(!received||received>count)fail('Miles file','truncated or invalid read');
        data.set(h.copyOut(scratch,received),offset);offset+=received;
      }
      return data;
    }finally{
      try{if(opened){if(close)await callback(close,[file]);else kernel('CloseHandle',[file]);}}
      finally{h.free(out);h.free(scratch);}
    }
  }
  const position=s=>s.voice===null?s.offset:audio().getPosition(s.voice);
  const status=(id,s)=>{
    if(s.status===4&&s.voice!==null&&audio().getState(s.voice)==='ended'){
      s.status=2;s.offset=s.duration;
      if(s.callback&&!s.notified){s.notified=true;state.deliverCallback(s.callback,[id]);}
    }
    return s.status;
  };
  const releaseVoice=s=>{if(s.voice!==null){audio().releaseVoice(s.voice);s.voice=null;}};
  const play=(s,offset=0)=>{
    releaseVoice(s);s.offset=offset;s.notified=false;
    if(offset>=s.duration){s.status=2;return;}
    s.voice=audio().play(s.buffer,{offset,loop:s.loopCount===0,volume:s.volume/127*driver(s.driver).volume,pan:panValue(s.pan),playbackRate:s.rate/s.sourceRate});s.status=4;
    playing(s,offset);
  };
  // End-of-stream callbacks are delivered by the Miles service thread.
  const playing=(s,offset)=>{s.endsAt=performance.now()+Math.max(0,s.duration-offset)*1000*s.sourceRate/s.rate;state.watchPlayback();};
  state.streamWatch=()=>[...streams].map(id=>h.handles.get(id));
  state.checkStreams=now=>{for(const id of [...streams]){const s=h.handles.get(id);if(s?.callback&&!s.notified&&s.status===4&&s.loopCount!==0&&now>=s.endsAt)status(id,s);}};
  const close=id=>{const s=stream(id);releaseVoice(s);audio().deleteBuffer(s.buffer);streams.delete(id);h.handles.delete(id);};
  state.closeStreams=dig=>{for(const id of [...streams])if(dig===undefined||stream(id).driver===dig)close(id);};
  state.updateStreamVolume=dig=>{for(const id of streams){const s=stream(id);if(s.driver===dig&&s.voice!==null)audio().setVolume(s.voice,s.volume/127*driver(dig).volume);}};
  add('AIL_open_stream',3,async([dig,filename,memory])=>{
    driver(dig);audio();if(memory&0x80000000)fail('AIL_open_stream','invalid stream buffer size');
    const data=await readFile(filename,h.currentCPU);if(!data)return 0;
    const buffer=audio().createEncodedBuffer(data);
    try{
      const duration=audio().bufferInfo(buffer,'duration'),sourceRate=audio().bufferInfo(buffer,'sampleRate'),channels=audio().bufferInfo(buffer,'numberOfChannels');
      const id=h.handle({kind:'miles-stream',driver:dig,buffer,voice:null,duration,sourceRate,channels,rate:sourceRate,
        byteLength:data.length,volume:127,pan:64,loopCount:1,status:2,offset:0,callback:0,notified:false,autoService:1,userData:new Uint32Array(8)});
      streams.add(id);return id;
    }catch(error){audio().deleteBuffer(buffer);throw error;}
  });
  add('AIL_close_stream',1,([id])=>close(id));
  add('AIL_start_stream',1,([id])=>play(stream(id)));
  add('AIL_pause_stream',2,([id,pause])=>{
    const s=stream(id);integer('stream pause',pause,0,1);const current=status(id,s);
    if(pause){if(current===4){s.offset=position(s);audio().pause(s.voice);s.status=8;}}
    else if(current!==4){if(s.voice!==null&&current===8){audio().resume(s.voice);s.status=4;playing(s,s.offset);}else play(s,s.offset>=s.duration?0:s.offset);}
  });
  add('AIL_stream_status',1,([id])=>status(id,stream(id)));
  add('AIL_set_stream_volume',2,([id,volume])=>{integer('stream volume',volume,0,127);const s=stream(id);s.volume=volume;if(s.voice!==null)audio().setVolume(s.voice,volume/127*driver(s.driver).volume);});
  add('AIL_stream_volume',1,([id])=>stream(id).volume);
  add('AIL_set_stream_pan',2,([id,pan])=>{integer('stream pan',pan,0,127);const s=stream(id);s.pan=pan;if(s.voice!==null)audio().setPan(s.voice,panValue(pan));});
  add('AIL_stream_pan',1,([id])=>stream(id).pan);
  add('AIL_set_stream_loop_count',2,([id,count])=>{
    if(count!==0&&count!==1)fail('AIL_set_stream_loop_count','finite repeated loops are not implemented');
    const s=stream(id),offset=position(s),playing=status(id,s)===4;s.loopCount=count;if(playing)play(s,offset);
  });
  add('AIL_stream_loop_count',1,([id])=>stream(id).loopCount);
  add('AIL_set_stream_playback_rate',2,([id,rate])=>{integer('stream playback rate',rate,3000,192000);const s=stream(id);s.rate=rate;if(s.voice!==null){audio().setPlaybackRate(s.voice,rate/s.sourceRate);if(s.status===4)playing(s,position(s));}});
  add('AIL_stream_playback_rate',1,([id])=>stream(id).rate);
  add('AIL_stream_ms_position',3,([id,total,current])=>{const s=stream(id);if(total)h.w32(total,Math.floor(s.duration*1000));if(current)h.w32(current,Math.floor(position(s)*1000));});
  add('AIL_set_stream_ms_position',2,([id,ms])=>{
    const s=stream(id),offset=Math.min(ms/1000,s.duration),playing=status(id,s)===4;
    if(playing)play(s,offset);else{releaseVoice(s);s.offset=offset;s.status=8;}
  });
  add('AIL_stream_info',5,([id,rate,type,length,memory])=>{
    const s=stream(id);if(rate)h.w32(rate,Math.round(s.byteLength/s.duration));if(type)h.w32(type,s.channels===2?3:1);
    if(length)h.w32(length,s.byteLength);if(memory)h.w32(memory,Math.ceil(s.duration*s.sourceRate)*s.channels*4);
  });
  add('AIL_auto_service_stream',2,([id,enabled])=>{integer('stream auto service',enabled,0,1);const s=stream(id),old=s.autoService;s.autoService=enabled;return old;});
  add('AIL_service_stream',2,([id])=>{status(id,stream(id));return 0;}); // Entire file is already decoded and buffered.
  add('AIL_register_stream_callback',2,([id,callback])=>{const s=stream(id),old=s.callback;s.callback=callback;if(callback&&s.status===4)state.watchPlayback();return old;});
  add('AIL_set_stream_user_data',3,([id,index,value])=>{integer('stream user data index',index,0,7);stream(id).userData[index]=value;});
  add('AIL_stream_user_data',2,([id,index])=>{integer('stream user data index',index,0,7);return stream(id).userData[index];});
}
