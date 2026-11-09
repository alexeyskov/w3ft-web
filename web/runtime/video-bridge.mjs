import {GuestFault} from './host.mjs';

// Commands cross from the synchronous guest broker to the browser media
// element. Playback can be accepted while waiting for a user gesture: the
// synchronous guest must not block (and time out) while the page asks for it.
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
  constructor({canvas,onEvent=()=>{},log=()=>{},language=globalThis.document?.documentElement.lang||'en',muted=false,sources=new Map()}={}){
    this.canvas=canvas;this.onEvent=onEvent;this.log=log;this.language=language;this.muted=!!muted;this.sources=sources instanceof Map?sources:new Map();this.players=new Map();this.destroyed=false;
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
      const entry={id,video,abort:new AbortController(),visible:false,rect:null,viewport:null,loading:true,playToken:0,blocked:false,completed:false,prompt:null};this.players.set(id,entry);
      Object.assign(video.style,{position:'fixed',objectFit:'contain',pointerEvents:'none',background:'black',zIndex:'20',display:'none'});
      (this.canvas?.parentElement||document.body).append(video);this.layout(entry);
      video.addEventListener('ended',()=>this.complete(entry));
      // Failures while loading are retried below; the game hears of playback errors only.
      video.addEventListener('error',()=>{if(!entry.loading&&this.players.get(id)===entry&&!this.destroyed)this.onEvent({type:'video-event',id,event:'error',error:video.error?.message||'Media decode error'});});
      // A dropped connection fails the media element like a broken file: up to
      // three tries, the last from the server, before the game is told.
      for(let attempt=1;;attempt++){
        try{
          await new Promise((resolve,reject)=>{
            const finish=error=>{clearTimeout(timer);video.removeEventListener('loadedmetadata',ready);video.removeEventListener('error',failed);entry.abort.signal.removeEventListener('abort',aborted);error?reject(error):resolve();};
            const ready=()=>finish(),failed=()=>finish(Error(video.error?.message||'Unsupported video media')),aborted=()=>finish(Object.assign(Error('Video load cancelled'),{cancelled:true}));
            const timer=setTimeout(()=>finish(Error('Video metadata timeout')),15000);
            video.addEventListener('loadedmetadata',ready);video.addEventListener('error',failed);entry.abort.signal.addEventListener('abort',aborted);
            video.src=attempt<3&&this.sources.get(url.pathname)||url.href;video.load();
          });
          entry.loading=false;break;
        }catch(error){
          if(error.cancelled||attempt>=3||this.players.get(id)!==entry)throw error;
          await new Promise(resolve=>setTimeout(resolve,500*attempt));
        }
      }
      return {width:video.videoWidth,height:video.videoHeight,duration:video.duration};
    }
    if(method==='destroy'){this.remove(id);return {};}
    const entry=this.players.get(id);if(!entry)throw Error('video is not loaded');const video=entry.video;
    if(method==='play'){if(message.autoShow!==false)entry.visible=true;this.layout(entry);await this.play(entry);}
    else if(method==='pause'||method==='stop'){++entry.playToken;this.clearPrompt(entry);video.pause();} // DirectShow Stop preserves the seek position.
    else if(method==='seek'){entry.completed=false;video.currentTime=message.position;}
    else if(method==='rate')video.playbackRate=message.rate;
    else if(method==='volume')video.volume=message.volume;
    else if(method==='configure'){if(message.visible!==undefined)entry.visible=message.visible;if(message.rect)entry.rect=message.rect;if(message.viewport)entry.viewport=message.viewport;this.layout(entry);}
    else if(method!=='status')throw Error(`Unsupported video operation ${method}`);
    return {position:video.currentTime,duration:video.duration,ended:entry.completed||video.ended,paused:video.paused,blocked:entry.blocked,rate:video.playbackRate,width:video.videoWidth,height:video.videoHeight};
  }
  async play(entry){
    const token=++entry.playToken;entry.completed=false;
    const active=()=>!this.destroyed&&this.players.get(entry.id)===entry&&entry.playToken===token;
    try{await entry.video.play();}
    catch(error){
      if(!active())return; // Stop/release can reject an outstanding play().
      if(error.name!=='NotAllowedError')throw error;
      entry.blocked=true;this.showPrompt(entry);return;
    }
    if(!active())return;
    const resumed=entry.blocked;this.clearPrompt(entry,true);
    if(resumed)this.log('Cinematic playback started after a user gesture');
  }
  complete(entry){
    if(this.players.get(entry.id)!==entry||entry.completed)return;
    entry.completed=true;this.clearPrompt(entry,true);
    this.onEvent({type:'video-event',id:entry.id,event:'ended'});
  }
  clearPrompt(entry,restoreFocus=false){
    // Transfer focus while the old controls still belong to the game surface;
    // removing them first would make Warcraft see an application focus loss.
    if(entry.prompt&&restoreFocus)this.canvas?.focus({preventScroll:true});
    entry.prompt?.remove();entry.prompt=null;entry.blocked=false;
  }
  ownsControl(target){
    if(!target?.nodeType)return false;
    for(const entry of this.players.values())if(entry.prompt?.contains(target))return true;
    return false;
  }
  showPrompt(entry){
    if(entry.prompt){this.layout(entry);return;}
    const ru=/^ru\b/i.test(this.language),prompt=document.createElement('div'),text=document.createElement('p'),buttons=document.createElement('div');
    prompt.className='cinematic-prompt';prompt.setAttribute('role','group');
    prompt.setAttribute('aria-label',ru?'Воспроизведение ролика':'Cinematic playback');
    Object.assign(prompt.style,{position:'fixed',zIndex:'21',boxSizing:'border-box',placeContent:'center',gap:'16px',padding:'20px',textAlign:'center',background:'rgba(8,16,24,.95)',color:'#def5ff',font:'16px/1.4 system-ui,sans-serif',cursor:'auto',touchAction:'manipulation'});
    text.textContent=ru?'Нажмите, чтобы запустить ролик.':'Tap to play the cinematic.';text.style.margin='0';
    Object.assign(buttons.style,{display:'flex',flexWrap:'wrap',justifyContent:'center',gap:'12px'});
    const button=(action,label)=>{
      const item=document.createElement('button');item.type='button';item.dataset.action=action;item.textContent=label;
      Object.assign(item.style,{font:'600 16px system-ui,sans-serif',padding:'12px 18px',color:'#98dcfb',background:'#122b3a',border:'2px solid #8fd8f9',borderRadius:'8px',cursor:'pointer'});
      buttons.append(item);return item;
    };
    const play=button('play',ru?'Смотреть ролик':'Play cinematic'),skip=button('skip',ru?'Пропустить':'Skip');
    // The actual play() must run in this click handler, before any await or
    // worker round trip, to satisfy iOS's media activation policy.
    play.addEventListener('click',()=>{
      play.disabled=true;
      void this.play(entry).catch(error=>{
        if(this.players.get(entry.id)!==entry)return;
        this.clearPrompt(entry,true);this.onEvent({type:'video-event',id:entry.id,event:'error',error:error.message});
      }).finally(()=>{play.disabled=false;});
    });
    skip.addEventListener('click',()=>{
      ++entry.playToken;entry.video.pause();entry.visible=false;
      this.log('Cinematic skipped by the player');this.complete(entry);this.layout(entry);
    });
    // A touch/click on these controls must not also reach Warcraft and skip
    // the cinematic. The buttons keep their native keyboard/touch behavior.
    for(const type of ['pointerdown','pointerup','pointermove','pointercancel','mousedown','mouseup','click','touchstart','touchend','keydown','keyup','wheel'])prompt.addEventListener(type,event=>event.stopPropagation());
    // WebKit blurs to the document body on button mousedown, with
    // relatedTarget=null. Prevent that default, but leave pointerdown alone:
    // cancelling pointerdown also suppresses the tap's click in iOS WebKit.
    prompt.addEventListener('mousedown',event=>event.preventDefault());
    prompt.append(text,buttons);entry.prompt=prompt;
    (this.canvas?.parentElement||document.body).append(prompt);
    if(document.pointerLockElement===this.canvas)document.exitPointerLock();
    this.layout(entry);
    if(document.activeElement===this.canvas)play.focus({preventScroll:true});
    this.log('Cinematic autoplay blocked; waiting for Play cinematic or Skip');
  }
  layout(entry){
    const box=this.canvas?.getBoundingClientRect()||{left:0,top:0,width:innerWidth,height:innerHeight},view=entry.viewport||[box.width,box.height],rect=entry.rect||[0,0,...view];
    const bounds={left:box.left+rect[0]/view[0]*box.width+'px',top:box.top+rect[1]/view[1]*box.height+'px',width:rect[2]/view[0]*box.width+'px',height:rect[3]/view[1]*box.height+'px'};
    Object.assign(entry.video.style,bounds,{display:entry.visible?'block':'none'});
    if(entry.prompt)Object.assign(entry.prompt.style,bounds,{display:entry.visible?'grid':'none'});
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
  remove(id){const entry=this.players.get(id);if(!entry)return;++entry.playToken;this.clearPrompt(entry);entry.abort.abort();entry.video.pause();entry.video.removeAttribute('src');entry.video.load();entry.video.remove();this.players.delete(id);}
  destroy(){
    this.destroyed=true;for(const id of this.players.keys())this.remove(id);
    this.resizeObserver?.disconnect();globalThis.removeEventListener?.('resize',this.relayout);
    globalThis.document?.removeEventListener('fullscreenchange',this.relayout);
  }
}
