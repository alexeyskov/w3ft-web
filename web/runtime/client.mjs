import {PCMPlayer} from './audio.mjs';
import {AudioDispatcher} from './audio-bridge.mjs';
import {VideoDispatcher} from './video-bridge.mjs';
import {SaveWriter} from './persistence.mjs';
import {gameResolution,gameGraphics} from './launch-settings.mjs';
import {cacheEntries,cacheStatus,clearCache} from './game-cache.mjs';

// Game data on this device (game-cache.mjs) for the launcher page: the
// archives and binaries of one language. Maps (56 MB) are stored as the game
// reads them; the launcher does not load the map catalog.
async function gameDataEntries(language) {
  const response=await fetch(language?`/api/assets?language=${encodeURIComponent(language)}`:'/api/assets');
  if(!response.ok)throw new Error(`HTTP ${response.status}`);
  return cacheEntries((await response.json()).files);
}
export async function gameDataStatus({language}={}){return cacheStatus(await gameDataEntries(language));}
export async function deleteGameData(){await clearCache();}
export function preloadGameData({language,onProgress=()=>{}}={}){
  const worker=new Worker(new URL('./game-cache-worker.mjs',import.meta.url),{type:'module'});
  let settle;const done=new Promise((resolve,reject)=>{settle={resolve,reject};});
  const fail=(message,code)=>{worker.terminate();const error=new Error(message||code);error.code=code;settle.reject(error);};
  worker.onmessage=({data})=>{
    if(data.type==='progress')onProgress(data);
    else if(data.type==='done'||data.type==='cancelled'){worker.terminate();settle.resolve(data);}
    else if(data.type==='error')fail(data.message,data.code);
  };
  worker.onerror=event=>fail(event.message||'Preload worker failed','network');
  gameDataEntries(language).then(entries=>{
    navigator.storage?.persist?.().catch(()=>{}); // ask the browser not to evict it
    worker.postMessage({type:'preload',entries});
  },error=>fail(error.message,'network'));
  return {done,cancel:()=>worker.postMessage({type:'cancel'})};
}

// An actual translated-code boot diagnostic. Campaign/multiplayer remain
// disabled in the runtime manifest until their acceptance tests pass.
export async function runDiagnostics({canvas,wasmUrl='/runtime/wc3.wasm',saves,transport=null,map=null,onStatus=()=>{},onReport=()=>{},onFrame=()=>{},onSnapshot,captureGraphics=false,graphicsDebugChecks=false,batchGraphics=true,legacyClampToEdge=true,nativeTextureShader=true,strictFinish=false,vsync=true,maxFps=0,profileRpc=false,audioEnabled=true,resolution,graphicsSettings,onGraphicsSetting=()=>{},language,timeout=30000,dispatchBudget=10000000}={}) {
  if(!Number.isInteger(dispatchBudget)||dispatchBudget<0||dispatchBudget>0xffffffff)throw new Error('Diagnostic dispatch budget must be uint32 (zero disables the limit)');
  if(!Number.isInteger(timeout)||timeout<0||timeout>0x7fffffff)throw new Error('Invalid session timeout (zero disables the limit)');
  resolution=gameResolution(resolution);graphicsSettings=gameGraphics(graphicsSettings);
  if(language!==undefined&&!/^[a-z]{2}$/.test(language))throw new Error('Game language must be a two-letter code');
  if(!Number.isInteger(maxFps)||maxFps<0||maxFps>1000)throw new Error('Frame-rate cap must be 0 (display refresh) or 1–1000');
  const player=new PCMPlayer({muted:!audioEnabled}),audio=new AudioDispatcher(player);
  const saveWriter=new SaveWriter(saves,error=>onStatus(`Сохранения: ${error.message}`));
  // Muting the final mix keeps Miles playback clocks and cinematic triggers
  // running. Removing the audio device makes guest code poll forever.
  try { await player.unlock(); }
  catch(error) { await audio.destroy(); throw error; }
  const video=new VideoDispatcher({canvas,muted:!audioEnabled,onEvent:message=>worker?.postMessage(message)});
  let worker;
  try { worker=new Worker(new URL('./worker.mjs',import.meta.url),{type:'module'}); }
  catch(error) { video.destroy();await audio.destroy(); throw error; }
  let finished=false,shutdownTimer,cleanupPromise,resolveStopped;const listeners=[];
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
    const lock=()=>{if(finished||!fullscreen()||locked())return;try{canvas.requestPointerLock?.()?.catch?.(()=>{});}catch{}};
    let lastX=.5,lastY=.5;
    for(const type of ['pointermove','pointerdown','pointerup','wheel'])listen(stage,type,event=>{
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
    listen(stage,'contextmenu',event=>event.preventDefault());
    listen(document,'fullscreenchange',()=>{if(fullscreen())lock();else if(locked())document.exitPointerLock();});
    for(const type of ['focus','blur'])listen(canvas,type,()=>input({type}));
    canvas.focus();
    // Play requests fullscreen before the runtime loads; its change event may
    // already have fired.
    lock();
  }
  const packet=e=>worker.postMessage({type:'packet',packet:{source:e.detail.source,data:e.detail.data.slice()}});
  const peers=e=>worker.postMessage({type:'peers',peers:e.detail});
  const disconnect=()=>worker.postMessage({type:'disconnect'});
  transport?.addEventListener('packet',packet);transport?.addEventListener('peers',peers);transport?.addEventListener('disconnect',disconnect);
  const cleanup=()=>cleanupPromise??=(async()=>{
    finished=true;clearTimeout(timer);clearTimeout(shutdownTimer);for(const remove of listeners)remove();video.destroy();worker.terminate();
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
  worker.onmessage=async event=>{
    if(finished)return;
    const message=event.data;
    try{
      if(message.type==='status')onStatus(message.message);
      else if(message.type==='frame')onFrame(message.frame);
      else if(message.type==='graphics-setting')onGraphicsSetting(message.name,message.value);
      else if(message.type==='snapshot')onSnapshot?.(message.snapshot);
      else if(message.type==='save-changes')await saveWriter.enqueue(message.changes);
      else if(message.type==='packet')transport?.send(message.destination,message.data);
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
    worker.postMessage({type:'start',options:{wasmUrl,canvas:offscreen,map,captureGraphics,graphicsDebugChecks,batchGraphics,legacyClampToEdge,nativeTextureShader,strictFinish,vsync,maxFps,profileRpc,resolution,graphicsSettings,language,monitor:typeof onSnapshot==='function',persist:!!saves,timeout,budget:dispatchBudget,audio:true,peerId:transport?.peerId,peerIds:transport?.peerIds,savedFiles}},offscreen?[offscreen]:[]);
  }catch(error){await cleanup();throw error;}
  return {stop,finish:stop};
}

export async function createGame() {
  throw new Error('createGame() is not available; use runDiagnostics. Campaign and multiplayer acceptance tests have not passed.');
}
