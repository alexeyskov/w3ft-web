import {PCMPlayer} from './audio.mjs';
import {AudioDispatcher} from './audio-bridge.mjs';
import {VideoDispatcher} from './video-bridge.mjs';
import {SaveWriter} from './persistence.mjs';
import {gameResolution,gameGraphics} from './launch-settings.mjs';
import {cacheEntries,cacheKey,cacheStatus,cacheSupported,clearCache} from './game-cache.mjs';
import {TouchGestures} from './touch-input.mjs';
import {peerGonePacket} from './winsock.mjs';
import {screenshotFile} from './screenshot.mjs';
import {runtimeBuildId} from './runtime-build.mjs';
import {RETRY_DELAYS} from './range-request.mjs';
export {runtimeBuildId};

// Game data on this device (game-cache.mjs) for the launcher page: the
// Selected edition, server maps and prepared campaign movies; no duplicate
// original movie files and no startup intro downloads.
// The lists are asked again after a dropped connection or a busy server, with
// the pauses of the game's block reads: on a poor link one failed request
// ended the whole download ("Failed to fetch").
async function fetchListing(url,signal){
  for(let attempt=0;;attempt++){
    let response=null,error=null;
    try{response=await fetch(url,{signal});}catch(caught){error=caught;}
    const retry=error?error.name!=='AbortError':response.status===408||response.status===429||response.status>=500;
    if(!retry||attempt>=RETRY_DELAYS.length){if(error)throw error;return response;}
    await new Promise(resolve=>setTimeout(resolve,RETRY_DELAYS[attempt]));
    if(signal?.aborted)throw signal.reason??new DOMException('Aborted','AbortError');
  }
}
async function gameDataEntries(language,signal) {
  const [response,maps]=await Promise.all([
    fetchListing(language?`/api/assets?language=${encodeURIComponent(language)}`:'/api/assets',signal),
    fetchListing('/api/maps',signal).then(r=>r.ok?r.json():{maps:[]})]);
  if(!response.ok)throw new Error(`HTTP ${response.status}`);
  return cacheEntries((await response.json()).files,maps.maps||[]);
}
export async function gameDataStatus({language}={}){return cacheStatus(await gameDataEntries(language));}
export async function deleteGameData(){await clearCache();}
export function preloadGameData({language,onProgress=()=>{},onStatus=()=>{}}={}){
  const worker=new Worker(new URL('./game-cache-worker.mjs',import.meta.url),{type:'module'});
  let settle;const done=new Promise((resolve,reject)=>{settle={resolve,reject};});
  const fail=(message,code)=>{worker.terminate();const error=new Error(message||code);error.code=code;settle.reject(error);};
  worker.onmessage=({data})=>{
    if(data.type==='progress')onProgress(data);
    else if(data.type==='status')onStatus(data.message);
    else if(data.type==='done'||data.type==='cancelled'){
      onStatus(`Game data preload: ${JSON.stringify(data.metrics||{})}`);
      worker.terminate();settle.resolve(data);
    }else if(data.type==='error'){
      onStatus(`Game data preload: ${JSON.stringify(data.metrics||{})}`);fail(data.message,data.code);
    }
  };
  worker.onerror=event=>fail(event.message||'Preload worker failed','network');
  // Stopping while the lists are still being asked for is a cancellation too.
  const listing=new AbortController();
  gameDataEntries(language,listing.signal).then(entries=>{
    navigator.storage?.persist?.().catch(()=>{}); // ask the browser not to evict it
    worker.postMessage({type:'preload',entries});
  },error=>{
    if(listing.signal.aborted){worker.terminate();settle.resolve({type:'cancelled'});}
    else fail(error.message,'network');
  });
  return {done,cancel:()=>{listing.abort();worker.postMessage({type:'cancel'});}};
}

// Critical startup resources first, before automatic background work begins.
// boot-<language>.json lists executable files and the archive blocks needed
// by the main menu. Intros are skipped by default. skipIntro:false retains
// the old explicit cinematic diagnostic when the recorded set includes one.
// WASM uses the HTTP cache; game files use OPFS. Failures fall back to demand
// reads, are logged, and do not prevent starting the game.
export function prepareGame({wasmUrl='/runtime/wc3.wasm',wasmSize=0,language,skipIntro=true,onProgress=()=>{},onStatus=()=>{}}={}){
  const started=performance.now(),milliseconds=value=>Math.round(value);
  onStatus(`Runtime build: ${runtimeBuildId}; preload language=${language||'base'}`);
  const abort=new AbortController(),parts={wasm:{done:0,total:0,known:false},data:{done:0,total:0,known:false}};
  let worker=null,cancelled=false,settleWorker=null;
  // The total only once both parts know their size: a growing total would
  // move the bar backwards.
  const report=()=>onProgress(parts.wasm.known&&parts.data.known?{done:parts.wasm.done+parts.data.done,total:parts.wasm.total+parts.data.total}:{done:0,total:0});
  const known=part=>{if(!part.known){part.known=true;report();}};
  const json=response=>{if(!response.ok)throw new Error(`HTTP ${response.status}`);return response.json();};
  const wasm=(async()=>{
    const began=performance.now();
    // Already in the HTTP cache at the server's version (ETag): nothing to fetch.
    const cached=await fetch(wasmUrl,{cache:'only-if-cached',mode:'same-origin',signal:abort.signal}).catch(()=>null);
    if(cached?.ok){
      cached.body?.cancel().catch(()=>{});
      const current=await fetch(wasmUrl,{method:'HEAD',cache:'no-store',signal:abort.signal}).catch(()=>null);
      const version=current?.ok?current.headers.get('ETag'):null;
      if(version&&version===cached.headers.get('ETag')){
        onStatus(`WebAssembly preload: ${JSON.stringify({cache:'validated',elapsedMs:milliseconds(performance.now()-began),bytes:0})}`);
        known(parts.wasm);return;
      }
    }
    const requestStarted=performance.now();
    const response=await fetch(wasmUrl,{signal:abort.signal});
    const headersAt=performance.now();
    if(!response.ok)throw new Error(`HTTP ${response.status}`);
    // A gzip download: the stream yields the uncompressed module, so progress
    // scales it to the compressed size the network carries.
    const sent=Number(response.headers.get('Content-Length'))||0,size=wasmSize>0?wasmSize:response.headers.get('Content-Encoding')?0:sent;
    parts.wasm.total=sent||size;parts.wasm.known=true;report();
    const reader=response.body.getReader();let received=0;
    for(;;){const {done,value}=await reader.read();if(done)break;received+=value.length;if(size)parts.wasm.done=Math.min(parts.wasm.total,Math.round(received/size*parts.wasm.total));report();}
    parts.wasm.done=parts.wasm.total;report();
    onStatus(`WebAssembly preload: ${JSON.stringify({cache:'downloaded',elapsedMs:milliseconds(performance.now()-began),firstByteMs:milliseconds(headersAt-requestStarted),bodyMs:milliseconds(performance.now()-headersAt),transferBytes:sent||received,decodedBytes:received})}`);
  })();
  const data=(async()=>{
    if(!cacheSupported()){known(parts.data);return [];}
    const signal=abort.signal;
    const metadataStarted=performance.now();
    const [assets,boot,build]=await Promise.all([
      fetch(language?`/api/assets?language=${encodeURIComponent(language)}`:'/api/assets',{signal}).then(json),
      fetch(new URL(`./boot-${language||'base'}.json`,import.meta.url),{signal}).then(response=>response.ok?response.json():null).catch(()=>null),
      fetch(new URL('./build.json',import.meta.url),{signal}).then(json)]);
    const files=new Map(assets.files.map(file=>[file.path.toLowerCase(),file])),items=[],media=[];
    const add=(path,blocks)=>{
      const file=files.get(String(path).toLowerCase());if(!file?.version)return null;
      const item={key:cacheKey('a',file.id,file.version),size:file.size,url:file.downloadUrl,label:file.path,...blocks?{blocks}:{}};items.push(item);return {file,item};
    };
    if(boot?.schemaVersion===1){
      for(const entry of boot.files||[]){
        const current=files.get(String(entry.path).toLowerCase());
        if(current?.size!==entry.size || (entry.version&&entry.version!==current.version))continue;
        add(entry.path,entry.whole?null:(entry.blocks||[]).flatMap(([first,last])=>Array.from({length:Math.max(0,last-first+1)},(_,i)=>first+i)));
      }
      if(!skipIntro)for(const path of boot.media||[]){const added=add(path,null);if(added)media.push(added);}
    }else for(const module of build.modules||[])add(module.image,null);
    onStatus(`Preload metadata: ${JSON.stringify({elapsedMs:milliseconds(performance.now()-metadataStarted),bootSet:boot?.schemaVersion===1,items:items.length})}`);
    if(!items.length){known(parts.data);return [];}
    await new Promise((resolve,reject)=>{
      worker=new Worker(new URL('./game-cache-worker.mjs',import.meta.url),{type:'module'});
      settleWorker=resolve;
      worker.onmessage=({data:message})=>{
        if(message.type==='progress'){parts.data.done=message.done;parts.data.total=message.total;parts.data.known=true;report();}
        else if(message.type==='status')onStatus(message.message);
        else if(message.type==='done'||message.type==='cancelled'){
          onStatus(`Preload game data: ${JSON.stringify(message.metrics||{})}`);resolve();
        }else if(message.type==='error'){
          onStatus(`Preload game data: ${JSON.stringify(message.metrics||{})}`);
          reject(Object.assign(new Error(message.message||message.code),{code:message.code}));
        }
      };
      worker.onerror=event=>reject(new Error(event.message||'Game data worker failed'));
      worker.postMessage({type:'prepare',items,concurrency:6});
    }).finally(()=>{worker.terminate();worker=null;});
    return media;
  })();
  // A part that failed counts as finished: the launch goes on without it.
  wasm.catch(()=>known(parts.wasm));data.catch(()=>known(parts.data));
  const done=Promise.allSettled([wasm,data]).then(async([module,game])=>{
    if(module.status==='rejected'&&!cancelled)onStatus(`WebAssembly preload: ${module.reason.message}`);
    if(game.status==='rejected'&&!cancelled)onStatus(`Game data preload: ${game.reason.message}`);
    const sources=new Map();
    for(const {file,item} of game.status==='fulfilled'&&!cancelled?game.value:[]){
      try{
        // Only a completely stored cinematic replaces the download.
        if((await cacheStatus([item])).cached!==item.size)continue;
        const stored=await (await (await (await navigator.storage.getDirectory()).getDirectoryHandle('game-data')).getFileHandle(item.key)).getFile();
        if(stored.size===file.size)sources.set(new URL(file.downloadUrl,location.href).pathname,URL.createObjectURL(stored));
      }catch(error){onStatus(`Cinematic ${file.path}: ${error.message}`);}
    }
    onStatus(`Preload complete: ${JSON.stringify({elapsedMs:milliseconds(performance.now()-started),cancelled,cinematicsOnDevice:sources.size})}`);
    return {cancelled,media:sources,release:()=>{for(const url of sources.values())URL.revokeObjectURL(url);sources.clear();}};
  });
  return {done,cancel:()=>{if(cancelled)return;cancelled=true;abort.abort();if(worker)worker.postMessage({type:'cancel'});else settleWorker?.();}};
}

// An actual translated-code boot diagnostic. Campaign/multiplayer remain
// disabled in the runtime manifest until their acceptance tests pass.
export async function runDiagnostics({canvas,audioContext,media,wasmUrl='/runtime/wc3.wasm',saves,transport=null,map=null,onStatus=()=>{},onReport=()=>{},onFrame=()=>{},onSnapshot,onScreenshot,onCacheProgress=()=>{},backgroundCache=true,skipIntro=true,captureGraphics=false,graphicsDebugChecks=false,batchGraphics=true,nativeGraphics=false,legacyClampToEdge=true,nativeTextureShader=true,streamingBuffers=false,strictFinish=false,vsync=true,maxFps=0,profileRpc=false,audioEnabled=true,resolution,graphicsSettings,onGraphicsSetting=()=>{},language,timeout=30000,dispatchBudget=10000000}={}) {
  if(!Number.isInteger(dispatchBudget)||dispatchBudget<0||dispatchBudget>0xffffffff)throw new Error('Diagnostic dispatch budget must be uint32 (zero disables the limit)');
  if(!Number.isInteger(timeout)||timeout<0||timeout>0x7fffffff)throw new Error('Invalid session timeout (zero disables the limit)');
  resolution=gameResolution(resolution);graphicsSettings=gameGraphics(graphicsSettings);
  if(language!==undefined&&!/^[a-z]{2}$/.test(language))throw new Error('Game language must be a two-letter code');
  if(!Number.isInteger(maxFps)||maxFps<0||maxFps>1000)throw new Error('Frame-rate cap must be 0 (display refresh) or 1–1000');
  if(media!==undefined&&!(media instanceof Map))throw new Error('Media sources must be a Map of asset paths to URLs');
  // An AudioContext created during the Play click (the launcher's): sound may
  // start after long downloads, when that click no longer counts as activation.
  const player=new PCMPlayer({muted:!audioEnabled,...audioContext?{context:audioContext}:{}}),audio=new AudioDispatcher(player);
  const saveWriter=new SaveWriter(saves,error=>onStatus(`Сохранения: ${error.message}`));
  // Muting the final mix keeps Miles playback clocks and cinematic triggers
  // running. Removing the audio device makes guest code poll forever.
  try { await player.unlock(); }
  catch(error) { await audio.destroy(); throw error; }
  const video=new VideoDispatcher({canvas,muted:!audioEnabled,sources:new Map(media),language,log:onStatus,onEvent:message=>worker?.postMessage(message)});
  const cachedMedia=new Map();
  let worker;
  try { worker=new Worker(new URL('./worker.mjs',import.meta.url),{type:'module'}); }
  catch(error) { video.destroy();await audio.destroy(); throw error; }
  let finished=false,shutdownTimer,cleanupPromise,resolveStopped,touch=null;const listeners=[];
  const stoppedPromise=new Promise(resolve=>{resolveStopped=resolve;});
  const listen=(target,name,handler,options)=>{target?.addEventListener(name,handler,options);listeners.push(()=>target?.removeEventListener(name,handler,options));};
  const input=message=>{if(!finished)worker.postMessage({type:'input',input:message});};
  if(canvas){
    canvas.tabIndex=0;
    for(const type of ['keydown','keyup'])listen(canvas,type,event=>{
      event.preventDefault();const text=event.ctrlKey||event.altKey?'':event.key.length===1?event.key:({Enter:'\r',Tab:'\t',Backspace:'\b',Escape:'\x1b'}[event.key]||'');
      input({type,keyCode:event.keyCode,text,alt:event.altKey,extended:['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Insert','Delete','Home','End','PageUp','PageDown'].includes(event.code)});
    });
    // Fullscreen gives the whole screen to the game, as on Windows. The pointer
    // is locked to the canvas, so the game cursor is the only one: it moves by
    // relative motion and stops at the canvas edges, which makes edge scrolling
    // work without a dead zone in the letterbox bars. Unlocked fullscreen input
    // from the bars is clamped to the canvas; in a window only the canvas counts.
    const stage=canvas.parentElement||canvas,clamp=value=>Math.min(1,Math.max(0,value));
    const fullscreen=()=>!!document.fullscreenElement?.contains(canvas),locked=()=>document.pointerLockElement===canvas;
    // Pointer Lock serves a mouse; a phone or tablet without one never asks for it.
    const finePointer=()=>globalThis.matchMedia?.('(any-pointer: fine)').matches!==false;
    const lock=()=>{if(finished||!fullscreen()||locked()||!finePointer())return;try{canvas.requestPointerLock?.()?.catch?.(()=>{});}catch{}};
    let lastX=.5,lastY=.5;
    // Fingers go through touch-input.mjs: taps and gestures become the mouse
    // and arrow-key input Warcraft reads. Mouse and pen input below do not.
    touch=new TouchGestures({vibrate:()=>navigator.vibrate?.(15),send:message=>{
      if(message.type==='keydown'||message.type==='keyup'){input({type:message.type,keyCode:message.keyCode,text:'',alt:false,extended:!!message.extended});return;}
      const bounds=canvas.getBoundingClientRect();
      lastX=clamp((message.x-bounds.left)/bounds.width);lastY=clamp((message.y-bounds.top)/bounds.height);
      input({type:message.type,x:lastX,y:lastY,button:message.button,delta:message.delta,shift:false,control:false});
    }});
    const finger=(type,event)=>{
      if(type==='pointerdown'){if(event.target!==canvas)return;canvas.focus();touch.down(event.pointerId,event.clientX,event.clientY);}
      else if(type==='pointermove')touch.move(event.pointerId,event.clientX,event.clientY);
      else if(type==='pointerup')touch.up(event.pointerId,event.clientX,event.clientY);
      event.preventDefault();
    };
    for(const type of ['pointermove','pointerdown','pointerup','wheel'])listen(stage,type,event=>{
      if(event.pointerType==='touch'){finger(type,event);return;}
      const full=fullscreen(),relative=locked();
      if(!full&&!relative&&event.target!==canvas)return;
      event.preventDefault();
      const bounds=canvas.getBoundingClientRect(),moved=relative&&type==='pointermove';
      let x=relative?lastX+(moved?event.movementX/bounds.width:0):(event.clientX-bounds.left)/bounds.width;
      let y=relative?lastY+(moved?event.movementY/bounds.height:0):(event.clientY-bounds.top)/bounds.height;
      if(full||relative){x=clamp(x);y=clamp(y);}
      if(type==='pointerdown'){canvas.focus();if(full)lock();else canvas.setPointerCapture?.(event.pointerId);}
      lastX=x;lastY=y;
      input({type,x,y,button:event.button,delta:-Math.sign(event.deltaY||0)*120,shift:event.shiftKey,control:event.ctrlKey});
    },{passive:false});
    listen(stage,'pointercancel',event=>{if(event.pointerType==='touch')touch.cancel(event.pointerId);});
    listen(stage,'contextmenu',event=>event.preventDefault());
    listen(document,'fullscreenchange',()=>{if(fullscreen())lock();else if(locked())document.exitPointerLock();});
    // Moving between the canvas and cinematic controls stays inside the same
    // emulated application. A canvas blur here makes Warcraft skip its movie.
    const gameFocus=target=>target===canvas||video.ownsControl(target);
    listen(stage,'focusin',event=>{if(gameFocus(event.target)&&!gameFocus(event.relatedTarget))input({type:'focus'});});
    listen(stage,'focusout',event=>{if(gameFocus(event.target)&&!gameFocus(event.relatedTarget))input({type:'blur'});});
    canvas.focus();
    // Play requests fullscreen before the runtime loads; its change event may
    // already have fired.
    lock();
  }
  const packet=e=>worker.postMessage({type:'packet',packet:{source:e.detail.source,data:e.detail.data.slice()}});
  const peers=e=>worker.postMessage({type:'peers',peers:e.detail});
  const disconnect=()=>worker.postMessage({type:'disconnect'});
  transport?.addEventListener('packet',packet);transport?.addEventListener('peers',peers);transport?.addEventListener('disconnect',disconnect);
  // Other players drop their streams with this page's game when it ends, and
  // any left from an earlier game on this lobby connection when one starts.
  const gone=()=>{try{transport?.send(0,peerGonePacket());}catch{}};
  gone();
  const cleanup=()=>cleanupPromise??=(async()=>{
    finished=true;clearTimeout(timer);clearTimeout(shutdownTimer);for(const remove of listeners)remove();touch?.reset();video.destroy();worker.terminate();
    for(const url of cachedMedia.values())URL.revokeObjectURL(url);cachedMedia.clear();
    gone();
    // Leaving fullscreen from script keeps Pointer Lock; the page needs its cursor back.
    if(canvas&&document.pointerLockElement===canvas)document.exitPointerLock();
    transport?.removeEventListener('packet',packet);transport?.removeEventListener('peers',peers);transport?.removeEventListener('disconnect',disconnect);
    try{await audio.destroy();}finally{resolveStopped();}
  })();
  const fail=async error=>{
    if(finished)return;finished=true;clearTimeout(timer);clearTimeout(shutdownTimer);worker.terminate();
    const report={wasmExecuted:null,gameplayVerified:false,error:{message:error.message}};
    try{
      // Snapshots already accepted from the guest remain valid after a crash.
      // Do not allow a relaunch to read the profile until their writes settle.
      try{await saveWriter.pending;}catch(error){report.persistenceError=error.message;}
      if(saveWriter.error)report.persistenceError=saveWriter.error.message;
      onReport(report);
    }finally{await cleanup();}
  };
  const stop=()=>{
    if(!finished&&!shutdownTimer){
      worker.postMessage({type:'stop'});
      shutdownTimer=setTimeout(()=>{void fail(new Error('Игра не ответила на остановку; worker остановлен'))},5000);
    }
    return stoppedPromise;
  };
  const timer=timeout?setTimeout(()=>{void stop();},timeout):null;
  worker.onerror=event=>{if(finished)return;onStatus(event.message);void fail(new Error(event.message));};
  // Print Screen: the game's screenshot, as a PNG for the page to save.
  const screenshot=async message=>{
    if(typeof onScreenshot!=='function')return;
    try{onScreenshot(await screenshotFile(message));}
    catch(error){onStatus(`Screenshot ${message.path}: ${error.message}`);}
  };
  worker.onmessage=async event=>{
    if(finished)return;
    const message=event.data;
    try{
      if(message.type==='status')onStatus(message.message);
      else if(message.type==='cache-progress')onCacheProgress(message.progress);
      else if(message.type==='cached-media'){
        const path=new URL(message.url,location.href).pathname,previous=cachedMedia.get(path);
        if(previous)URL.revokeObjectURL(previous);
        const url=URL.createObjectURL(message.file);cachedMedia.set(path,url);video.sources.set(path,url);
      }
      else if(message.type==='frame')onFrame(message.frame);
      else if(message.type==='graphics-setting')onGraphicsSetting(message.name,message.value);
      else if(message.type==='snapshot')onSnapshot?.(message.snapshot);
      else if(message.type==='screenshot')void screenshot(message);
      else if(message.type==='save-changes')await saveWriter.enqueue(message.changes);
      else if(message.type==='packet'){
        if(message.destination===255){try{transport?.send(255,message.data);}catch{ /* Optional telemetry. */ }}
        else transport?.send(message.destination,message.data);
      }
      else if(message.type==='audio'){
        const result=await audio.handle(message);
        if(result.error)onStatus(`Audio ${result.operation}: ${result.error}`);
      }else if(message.type==='video')await video.handle(message);
      else if(message.type==='finished'){
        finished=true;clearTimeout(shutdownTimer);clearTimeout(timer);
        try{
          await saveWriter.enqueue({files:message.savedFiles||[],deleted:message.deletedFiles||[],full:true});
          if(saveWriter.error)message.report.persistenceError=saveWriter.error.message;
          onReport(message.report);
        }finally{await cleanup();}
      }
    }catch(error){await fail(error);}
  };
  try{
    const savedFiles=await saves?.list()||[];
    const offscreen=canvas?.transferControlToOffscreen();
    worker.postMessage({type:'start',options:{wasmUrl,canvas:offscreen,map,backgroundCache,skipIntro,captureGraphics,graphicsDebugChecks,batchGraphics,nativeGraphics,legacyClampToEdge,nativeTextureShader,streamingBuffers,strictFinish,vsync,maxFps,profileRpc,resolution,graphicsSettings,language,monitor:typeof onSnapshot==='function',persist:!!saves,timeout,budget:dispatchBudget,audio:true,peerId:transport?.peerId,peerIds:transport?.peerIds,savedFiles}},offscreen?[offscreen]:[]);
  }catch(error){await cleanup();throw error;}
  // On-screen keys (touch screens): the same messages a keyboard sends.
  const key=(type,{keyCode,text='',extended=false}={})=>{
    if(type!=='keydown'&&type!=='keyup')throw new TypeError('Key event type must be keydown or keyup');
    if(!Number.isInteger(keyCode)||keyCode<0||keyCode>255)throw new TypeError('Virtual-key code must be 0–255');
    input({type,keyCode,text:type==='keydown'?String(text).slice(0,8):'',alt:false,extended:!!extended});
  };
  return {stop,finish:stop,key};
}

export async function createGame() {
  throw new Error('createGame() is not available; use runDiagnostics. Campaign and multiplayer acceptance tests have not passed.');
}
