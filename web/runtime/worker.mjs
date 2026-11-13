import {createRuntime} from './engine.mjs';
import {FixedFunctionGL} from './graphics.mjs';
import {VirtualWinsock} from './winsock.mjs';
import {LANMatchReporter} from './lan-match.mjs';
import {WorkerAudio} from './audio-bridge.mjs';
import {createOfflineNetwork} from './network-local.mjs';
import {GuestThreadScheduler} from './thread-scheduler.mjs';
import {WorkerVideo} from './video-bridge.mjs';
import {saveSnapshot,takeScreenshots,isScreenshot,restoreRegistry} from './persistence.mjs';
import {webkitCollectorNudge} from './webkit-gc.mjs';
import {sourceFiles,describeNetwork} from './game-files.mjs';
import {GRAPHICS_SETTINGS} from './launch-settings.mjs';
import {GameDataCache,cacheKey,cacheEntries,cacheableAsset} from './game-cache.mjs';
import {DownloadScheduler} from './download-scheduler.mjs';

let engine = null, scheduler = null, stopped = false, monitor,saveTimer,nudgeTimer,stopTimer,quitTimer,keyReleaseTimer;
const log = message => postMessage({type:'status',message:String(message)});
class WorkerTransport extends EventTarget {
  constructor(peerId) { super(); this.peerId=peerId; }
  send(destination,data) { const copy=data.slice();postMessage({type:'packet',destination,data:copy},[copy.buffer]); }
}
let transport,video,network,lanMatch,pendingPeers=null,disconnected=false,disk=null,gameFiles=null,downloads=null;

// The catalog's copy of a map's first bytes (base64), never longer than the map.
function mapHeader(text,size){
  try{const bytes=Uint8Array.from(atob(text),c=>c.charCodeAt(0));return bytes.length<=size?bytes:null;}catch{return null;}
}
// Compiled while it downloads: the 180 MB module never sits in a JavaScript
// buffer, which boot() kept for the whole game. That buffer plus the
// compiler's copy was the startup peak (WebKit: 944 MB, streaming 597 MB).
// Without application/wasm (another server) it compiles from the bytes.
// JavaScriptCore (Safari, every browser on iPhone and iPad) keeps no compiled
// module between visits, so counting the stream costs nothing there; the log
// then shows how far a phone got when it closed the page for memory.
const javaScriptCore=/AppleWebKit\//.test(navigator.userAgent)&&!/Chrome\/|Chromium\/|Edg\//.test(navigator.userAgent);
async function compileWasm(url){
  const response=await fetch(url);
  if(!response.ok)throw Error('WASM download failed');
  if(typeof WebAssembly.compileStreaming!=='function'||!/^application\/wasm\b/i.test(response.headers.get('Content-Type')||''))return WebAssembly.compile(await response.arrayBuffer());
  if(!javaScriptCore||!response.body||typeof TransformStream!=='function')return WebAssembly.compileStreaming(response);
  let received=0,next=32;
  const counted=response.body.pipeThrough(new TransformStream({transform(chunk,controller){
    received+=chunk.byteLength;if(received>=next*1048576){log(`WASM: ${next} MB received and compiled`);next+=32;}controller.enqueue(chunk);
  }}));
  return WebAssembly.compileStreaming(new Response(counted,{headers:{'Content-Type':'application/wasm'}}));
}

const sendScreenshots=engine=>{for(const {path,data} of takeScreenshots(engine.host))postMessage({type:'screenshot',path,data},[data.buffer]);};

async function boot(options) {
  let error=null;
  try {
    log('Загрузка WASM и проверка профиля бинарников…');
    const compileStarted=performance.now();
    const [wasm,profile,manifest,catalog,downloadPlan]=await Promise.all([
      compileWasm(options.wasmUrl).then(module=>{log(`WASM ${String(options.wasmUrl).split('/').pop()} compiled in ${((performance.now()-compileStarted)/1000).toFixed(1)} s`);return module;}),
      fetch(new URL('./build.json',import.meta.url)).then(r=>r.json()),
      // Game language: the server puts that localization's archives and
      // cinematics in place of the base installation's (same patch).
      fetch(options.language?`/api/assets?language=${encodeURIComponent(options.language)}`:'/api/assets').then(r=>{if(!r.ok)throw Error(`Game files for language ${options.language} are unavailable`);return r.json();}),
      fetch('/api/maps').then(r=>{if(!r.ok)throw Error('Map catalog download failed');return r.json();}),
      fetch(new URL(`./download-plan-${options.language||'base'}.json`,import.meta.url)).then(r=>r.ok?r.json():null).catch(()=>null),
    ]);
    if(stopped)return;
    const mountedMaps=new Map((catalog.maps||[]).map(map=>[map.id,map]));
    if(options.map)mountedMaps.set(options.map.id,options.map);
    // Archives, binaries and maps are game data kept on this device per
    // version (game-cache.mjs); cached cinematics reach <video> as disk-backed Files.
    const entries=manifest.files.map(file=>cacheableAsset(file)?{...file,cacheKey:cacheKey('a',file.id,file.version)}:file);
    // The catalog is the game's own Maps (and Campaigns) folder, as in an
    // installed copy: the map list opens directly on the catalog's folders.
    // Saves made while maps lived under Maps/Web record that path; a hidden
    // alias lets them load without showing a Web folder in the map list.
    for(const map of mountedMaps.values()){
      const folder=map.path.toLowerCase().endsWith('.w3n')?'Campaigns':'Maps',file={size:map.size,downloadUrl:map.downloadUrl,...map.sha256?{cacheKey:cacheKey('m',map.id,map.sha256)}:{},...typeof map.header==='string'?{header:mapHeader(map.header,map.size)}:{}};
      entries.push({path:`${folder}/${map.path}`,...file},{path:`${folder}/Web/${map.path}`,...file,hidden:true});
    }
    log(`Mounted ${mountedMaps.size} server maps`);
    if(options.gameDataCache!==false){
      const cached=cacheEntries(manifest.files,[...mountedMaps.values()]);
      disk=await GameDataCache.open(cached,{log});
      if(disk&&options.backgroundCache!==false)downloads=new DownloadScheduler(cached,disk,{plan:downloadPlan,log,
        onProgress:progress=>postMessage({type:'cache-progress',progress}),
        onFileReady:(entry,file)=>postMessage({type:'cached-media',url:entry.url,file})});
    }
    const lookup=new Map(entries.map(e=>[e.path.toLowerCase(),e]));
    const mediaFile=lookup.get('webmedia/media.json'),movies=new Map();
    if(mediaFile){
      const media=await fetch(mediaFile.downloadUrl).then(r=>r.json());
      for(const[path,description]of Object.entries(media.movies||{})){
        const file=lookup.get(description.path.toLowerCase());if(file)movies.set(path.toLowerCase(),{...description,downloadUrl:file.downloadUrl});
      }
    }
    video=new WorkerVideo({movies,skipIntro:options.skipIntro!==false,log,
      holdDownloads:movie=>downloads?.demand(lookup.get(movie.path.toLowerCase())||{})});
    const images=await Promise.all(profile.modules.map(async m=>{
      const e=lookup.get(m.image.toLowerCase());if(!e)throw Error(`Missing ${m.image}`);
      const stored=e.cacheKey&&disk?.readAll(e.cacheKey);if(stored)return {name:m.image,bytes:stored};
      const response=await fetch(e.downloadUrl);if(!response.ok)throw Error(`Module load HTTP ${response.status}`);
      const bytes=new Uint8Array(await response.arrayBuffer());if(e.cacheKey&&disk)await disk.writeAll(e.cacheKey,bytes);
      return {name:m.image,bytes};
    }));
    if(stopped)return;
    if(options.peerId)transport=new WorkerTransport(options.peerId);
    network=transport?new VirtualWinsock(transport):createOfflineNetwork();
    if(transport)lanMatch=new LANMatchReporter(network);
    if(transport){
      const peers=pendingPeers||options.peerIds;
      if(peers)transport.dispatchEvent(new CustomEvent('peers',{detail:peers}));
      if(disconnected)transport.dispatchEvent(new Event('disconnect'));
    }
    if(options.canvas&&options.resolution){options.canvas.width=options.resolution.width;options.canvas.height=options.resolution.height;}
    const graphics=options.canvas?new FixedFunctionGL(options.canvas,{debugChecks:!!options.graphicsDebugChecks,legacyClampToEdge:options.legacyClampToEdge!==false,nativeTextureShader:options.nativeTextureShader!==false,streamingBuffers:!!options.streamingBuffers}):null;
    gameFiles=sourceFiles(entries,disk,{log,downloads});
    engine=await createRuntime({wasm,profile,images,...gameFiles,log,graphics,video,
      audio:new WorkerAudio({trace:()=>engine?.host.history.slice(-16)||[]}),network,resolution:options.resolution,graphicsSettings:options.graphicsSettings,
      allowLocalFiles:entries.some(e=>/^fonts\//i.test(e.path)),commandLine:options.commandLine||'war3.exe -opengl -window'});
    if(stopped)return;
    // Video options chosen in the game's own menu go back to the launcher.
    engine.host.onRegistryWrite=(path,name,value)=>{
      if(path!=='user\\software\\blizzard entertainment\\warcraft iii\\video'||!Object.hasOwn(GRAPHICS_SETTINGS,name)||value.type!==4||value.data.length!==4)return;
      const setting=new DataView(value.data.buffer,value.data.byteOffset,4).getUint32(0,true),[min,max]=GRAPHICS_SETTINGS[name];
      if(setting>=min&&setting<=max)postMessage({type:'graphics-setting',name,value:setting});
    };
    engine.host.presentFrame=frame=>{
      lanMatch?.frame(engine.host,frame);
      // The guest has reached its menu. Startup file reads stay uncontested;
      // all later reads can preempt the opportunistic downloader.
      if(frame.frames>2){video.skipIntro=false;downloads?.start();}
      const r=engine.host.graphics;
      frame.execution={rpcCalls:scheduler?.rpcCount||0,graphicsCommands:engine.host.graphicsBatchRegistry?.commands||0,graphicsBatches:engine.host.graphicsBatchRegistry?.batches||0};
      if(scheduler?.rpcByName)frame.execution.rpcByName=Object.fromEntries(scheduler.rpcByName);
      if(options.captureGraphics&&frame.frames===3)engine.host.hostTimings=new Map();
      if(options.captureGraphics&&frame.frames===4)r.capture=[];
      if(options.captureGraphics&&frame.frames===5){r.capturedFrame=r.capture;r.capture=null;}
      postMessage({type:'frame',frame});
    };
    engine.host.strictFinish=!!options.strictFinish;
    // Screenshots never belong to the saves (persistence.mjs); old ones stay out.
    for(const file of options.savedFiles||[])if(!isScreenshot(file.path))engine.host.virtualFiles.set(file.path.toLowerCase(),new Uint8Array(file.data));
    restoreRegistry(engine.host);
    engine.host.virtualFiles.checkpoint();
    postMessage({type:'linked',modules:engine.modules});
    engine.initialize();
    // Safari only: keeps JavaScriptCore collecting this worker's garbage (webkit-gc.mjs).
    const nudge=webkitCollectorNudge(engine.host.memory);
    if(nudge)nudgeTimer=setInterval(nudge,500);
    // Every second: finished screenshots to the page, changed saves to storage.
    saveTimer=setInterval(()=>{
      sendScreenshots(engine);
      if(!options.persist)return;
      const changes=saveSnapshot(engine.host);
      if(changes.files.length||changes.deleted.length)postMessage({type:'save-changes',changes});
    },1000);
    scheduler=new GuestThreadScheduler(engine,{log,budget:options.budget??10000000,timeout:options.timeout??60000,batchGraphics:options.batchGraphics!==false,nativeGraphics:options.nativeGraphics===true,vsync:options.vsync!==false,maxFps:options.maxFps||0});
    // Diagnostic breakdown of synchronous broker calls by import name.
    if(options.profileRpc)scheduler.rpcByName=new Map();
    if(options.monitor)monitor=setInterval(()=>postMessage({type:'snapshot',snapshot:{
      time:performance.now(),calls:Object.values(scheduler.calls()).reduce((sum,n)=>sum+n,0),
      recent:engine.host.history.slice(-8),threads:scheduler.report(),heap:engine.host.heapStats(),
    }}),10000);
    await scheduler.runMain('war3.exe');
  } catch(caught) { error=caught;log(`${caught.name}: ${caught.message}`); }
  finally {
    clearInterval(monitor);clearInterval(saveTimer);clearInterval(nudgeTimer);clearTimeout(stopTimer);clearTimeout(quitTimer);clearTimeout(keyReleaseTimer);
    scheduler?.stop();
    lanMatch?.destroy();network?.destroy();
    const report=engine?engine.report(error):{wasmExecuted:false,gameplayVerified:false,error:error?{type:error.name,message:error.message,details:error.details}:null};
    if(scheduler){
      report.threads=scheduler.report();report.calls=scheduler.calls();
      report.execution={rpcCalls:scheduler.rpcCount,graphicsCommands:engine.host.graphicsBatchRegistry?.commands||0,graphicsBatches:engine.host.graphicsBatchRegistry?.batches||0};
    }
    if(engine?.host.graphics)report.graphics=engine.host.graphics.stats();
    if(engine?.host.graphics?.capturedFrame)report.graphics.capture=engine.host.graphics.capturedFrame;
    if(engine?.host.hostTimings)report.hostTimings=Object.fromEntries([...engine.host.hostTimings].sort((a,b)=>b[1].totalMs-a[1].totalMs));
    if(engine)report.heap=engine.host.heapStats();
    await downloads?.stop();downloads=null;
    disk?.close();disk=null;
    // What the game had to wait for: the first thing to look at when it stuttered.
    const fromServer=gameFiles?.networkReport();
    if(fromServer?.blocks){report.gameData=fromServer;log(describeNetwork(fromServer));}
    if(engine)try{sendScreenshots(engine);}catch(caught){log(`Screenshot: ${caught.message}`);}
    const snapshot=engine?saveSnapshot(engine.host,{full:true}):{files:[],deleted:[],deferred:[]};
    if(snapshot.deferred.length)report.deferredSaveFiles=snapshot.deferred;
    postMessage({type:'finished',report,savedFiles:snapshot.files,deletedFiles:snapshot.deleted});
  }
}

onmessage=event=>{
  const message=event.data;
  if(message.type==='start')void boot(message.options);
  else if(message.type==='packet')transport?.dispatchEvent(new CustomEvent('packet',{detail:message.packet}));
  else if(message.type==='peers'){pendingPeers=message.peers;transport?.dispatchEvent(new CustomEvent('peers',{detail:message.peers}));}
  else if(message.type==='disconnect'){disconnected=true;transport?.dispatchEvent(new Event('disconnect'));}
  else if(message.type==='input')engine?.host.injectInput?.(message.input);
  else if(message.type==='video-event')video?.dispatch(message);
  else if(message.type==='stop'){
    if(stopped)return;
    stopped=true;downloads?.pause('stopping');
    // Let the guest finish its normal settings flush before terminating its
    // CPUs. A stuck guest still stops within the client's five-second limit.
    const host=engine?.host,id=host?.handlers.get('user32.dll!GetForegroundWindow')?.fn([]);
    if(scheduler&&id){
      // Leaving the original menu commits text edits such as the LAN name.
      // WM_QUIT alone would save the previous value while its edit box is open.
      host.injectInput?.({type:'keydown',keyCode:27,text:'\x1b'});
      keyReleaseTimer=setTimeout(()=>host.injectInput?.({type:'keyup',keyCode:27}),50);
      quitTimer=setTimeout(()=>host.postWindowMessage(id,0x12),500);
      stopTimer=setTimeout(()=>scheduler?.stop(),2000);
    }else scheduler?.stop();
  }
};
