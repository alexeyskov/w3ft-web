import {GuestFault} from './host.mjs';

// Commands cross from the synchronous guest broker to the browser media
// element. Completion means the requested media operation actually finished.
export class WorkerVideo {
  constructor({post=message=>postMessage(message),movies=new Map(),timeout=20000}={}){
    this.post=post;this.movies=movies;this.timeout=timeout;this.listeners=new Map();this.nextId=1;
  }
  request(id,method,fields={}){
    const control=new SharedArrayBuffer(16384),status=new Int32Array(control,0,2);
    this.post({type:'video',id,method,control,...fields});
    while(Atomics.load(status,0)===0){
      if(Atomics.wait(status,0,0,this.timeout)==='timed-out'&&Atomics.compareExchange(status,0,0,-2)===0)
        throw new GuestFault(`Video ${method} timed out`,{id});
    }
    const length=Atomics.load(status,1);
    if(length<0||length>16376)throw new GuestFault('Invalid video response');
    const result=JSON.parse(new TextDecoder().decode(new Uint8Array(control,8,length).slice()));
    if(Atomics.load(status,0)!==1)throw new GuestFault(`Video ${method}: ${result.error}`,{id});
    return result;
  }
  create(listener){const id=this.nextId++;this.listeners.set(id,listener);return id;}
  load(id,path){
    const key=path.replaceAll('\\','/').replace(/^C:\/Warcraft III\/?/i,'').replace(/^\.\//,'').toLowerCase(),movie=this.movies.get(key);
    if(!movie)throw new GuestFault('Browser cinematic is missing; run tools/prepare_media.py',{path});
    const result=this.request(id,'load',{url:movie.downloadUrl}),[numerator,denominator]=movie.frameRate.split('/').map(Number);
    return {...result,frameRate:numerator/denominator};
  }
  dispatch(message){this.listeners.get(message.id)?.(message.event,message.error);}
  release(id){this.request(id,'destroy');this.listeners.delete(id);}
}

export class VideoDispatcher {
  // sources: asset path → URL of a copy on this device (client.mjs prepareGame).
  constructor({canvas,onEvent=()=>{},muted=false,sources=new Map()}={}){
    this.canvas=canvas;this.onEvent=onEvent;this.muted=!!muted;this.sources=sources instanceof Map?sources:new Map();this.players=new Map();this.destroyed=false;
    this.relayout=()=>{for(const entry of this.players.values())this.layout(entry);};
    globalThis.addEventListener?.('resize',this.relayout);
    globalThis.document?.addEventListener('fullscreenchange',this.relayout);
    if(canvas&&globalThis.ResizeObserver){this.resizeObserver=new ResizeObserver(this.relayout);this.resizeObserver.observe(canvas);}
  }
  async execute({id,method,...message}){
    if(this.destroyed)throw Error('video dispatcher stopped');
    if(!Number.isInteger(id)||id<1)throw Error('invalid video handle');
    if(method==='load'){
      this.remove(id);
      const url=new URL(message.url,location.href);if(url.origin!==location.origin||!url.pathname.startsWith('/api/assets/'))throw Error('video must be a game asset');
      const video=document.createElement('video');video.preload='auto';video.playsInline=true;video.controls=false;video.muted=this.muted;
      const entry={video,abort:new AbortController(),visible:false,rect:null,viewport:null};this.players.set(id,entry);
      Object.assign(video.style,{position:'fixed',objectFit:'contain',pointerEvents:'none',background:'black',zIndex:'20',display:'none'});
      (this.canvas?.parentElement||document.body).append(video);this.layout(entry);
      video.addEventListener('ended',()=>this.onEvent({type:'video-event',id,event:'ended'}));
      video.addEventListener('error',()=>this.onEvent({type:'video-event',id,event:'error',error:video.error?.message||'Media decode error'}));
      await new Promise((resolve,reject)=>{
        const finish=error=>{clearTimeout(timer);video.removeEventListener('loadedmetadata',ready);video.removeEventListener('error',failed);entry.abort.signal.removeEventListener('abort',aborted);error?reject(error):resolve();};
        const ready=()=>finish(),failed=()=>finish(Error(video.error?.message||'Unsupported video media')),aborted=()=>finish(Error('Video load cancelled'));
        const timer=setTimeout(()=>finish(Error('Video metadata timeout')),15000);
        video.addEventListener('loadedmetadata',ready);video.addEventListener('error',failed);entry.abort.signal.addEventListener('abort',aborted);
        video.src=this.sources.get(url.pathname)||url.href;video.load();
      });
      return {width:video.videoWidth,height:video.videoHeight,duration:video.duration};
    }
    if(method==='destroy'){this.remove(id);return {};}
    const entry=this.players.get(id);if(!entry)throw Error('video is not loaded');const video=entry.video;
    if(method==='play'){if(message.autoShow!==false)entry.visible=true;this.layout(entry);await video.play();}
    else if(method==='pause')video.pause();
    else if(method==='stop')video.pause(); // DirectShow Stop preserves the seek position.
    else if(method==='seek')video.currentTime=message.position;
    else if(method==='rate')video.playbackRate=message.rate;
    else if(method==='volume')video.volume=message.volume;
    else if(method==='configure'){if(message.visible!==undefined)entry.visible=message.visible;if(message.rect)entry.rect=message.rect;if(message.viewport)entry.viewport=message.viewport;this.layout(entry);}
    else if(method!=='status')throw Error(`Unsupported video operation ${method}`);
    return {position:video.currentTime,duration:video.duration,ended:video.ended,paused:video.paused,rate:video.playbackRate,width:video.videoWidth,height:video.videoHeight};
  }
  layout(entry){
    const box=this.canvas?.getBoundingClientRect()||{left:0,top:0,width:innerWidth,height:innerHeight},view=entry.viewport||[box.width,box.height],rect=entry.rect||[0,0,...view];
    Object.assign(entry.video.style,{left:box.left+rect[0]/view[0]*box.width+'px',top:box.top+rect[1]/view[1]*box.height+'px',width:rect[2]/view[0]*box.width+'px',height:rect[3]/view[1]*box.height+'px',display:entry.visible?'block':'none'});
  }
  async handle(message){
    if(!(message.control instanceof SharedArrayBuffer)||message.control.byteLength!==16384)return;
    const state=new Int32Array(message.control,0,2);if(Atomics.load(state,0)!==0)return;
    let result,status=1;
    try{result=await this.execute(message);}catch(error){result={error:error.message};status=-1;}
    if(Atomics.load(state,0)!==0)return;
    const bytes=new TextEncoder().encode(JSON.stringify(result));new Uint8Array(message.control,8,bytes.length).set(bytes);
    Atomics.store(state,1,bytes.length);Atomics.store(state,0,status);Atomics.notify(state,0);
  }
  remove(id){const entry=this.players.get(id);if(!entry)return;entry.abort.abort();entry.video.pause();entry.video.removeAttribute('src');entry.video.load();entry.video.remove();this.players.delete(id);}
  destroy(){
    this.destroyed=true;for(const id of this.players.keys())this.remove(id);
    this.resizeObserver?.disconnect();globalThis.removeEventListener?.('resize',this.relayout);
    globalThis.document?.removeEventListener('fullscreenchange',this.relayout);
  }
}
