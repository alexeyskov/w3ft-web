import {createRuntime} from './engine.mjs';
import {FixedFunctionGL} from './graphics.mjs';
import {VirtualWinsock} from './winsock.mjs';
import {WorkerAudio} from './audio-bridge.mjs';
import {createOfflineNetwork} from './network-local.mjs';
import {GuestThreadScheduler} from './thread-scheduler.mjs';
import {WorkerVideo} from './video-bridge.mjs';
import {saveSnapshot} from './persistence.mjs';
import {GRAPHICS_SETTINGS} from './launch-settings.mjs';
import {GameDataCache,cacheKey} from './game-cache.mjs';

let engine = null, scheduler = null, stopped = false, monitor,saveTimer;
const log = message => postMessage({type:'status',message:String(message)});
class WorkerTransport extends EventTarget {
  constructor(peerId) { super(); this.peerId=peerId; }
  send(destination,data) { const copy=data.slice();postMessage({type:'packet',destination,data:copy},[copy.buffer]); }
}
let transport,video,network,pendingPeers=null,disconnected=false,disk=null;

function sourceFiles(entries,disk=null) {
  const files=new Map(entries.map(e=>[e.path.replaceAll('\\','/').toLowerCase(),e]));
  const cache=new Map(), chunkSize=256*1024;
  const canonical=path=>{
    path=path.replaceAll('\\','/').replace(/^C:\/Warcraft III\/?/i,'').replace(/^\.\//,'').toLowerCase();
    if(path.split('/').includes('..'))throw Error('Unsafe file path');
    const file=files.get(path);if(!file)throw Error(`File not found: ${path}`);return file;
  };
  const readFile=(path,offset=0,length=undefined)=>{
    const file=canonical(path);length=length===undefined?file.size-offset:Math.min(length,file.size-offset);
    if(offset<0||length<0||length>128*1024*1024)throw Error('Invalid file range');
    const out=new Uint8Array(length);
    for(let done=0;done<length;){
      const start=Math.floor((offset+done)/chunkSize)*chunkSize,key=file.downloadUrl+':'+start;
      let block=cache.get(key);
      // Game data on this device first, then the server (stored for next time).
      if(!block&&file.cacheKey)block=disk?.read(file.cacheKey,start/chunkSize);
      if(!block){
        const xhr=new XMLHttpRequest();xhr.open('GET',file.downloadUrl,false);xhr.responseType='arraybuffer';
        xhr.setRequestHeader('Range',`bytes=${start}-${Math.min(start+chunkSize,file.size)-1}`);xhr.send();
        if(xhr.status!==206)throw Error(`Range load failed: ${xhr.status} ${file.path}`);
        block=new Uint8Array(xhr.response);if(file.cacheKey)disk?.write(file.cacheKey,start/chunkSize,block);
      }
      cache.set(key,block);if(cache.size>64)cache.delete(cache.keys().next().value);
      const begin=offset+done-start,n=Math.min(block.length-begin,length-done);if(n<=0)throw Error('Truncated resource range');out.set(block.subarray(begin,begin+n),done);done+=n;
    }
    return out;
  };
  return {readFile,fileSize:path=>canonical(path).size,listFiles:()=>entries.map(e=>e.hidden?{path:e.path,hidden:true}:e.path)};
}

async function boot(options) {
  let error=null;
  try {
    log('Загрузка WASM и проверка профиля бинарников…');
    const [wasm,profile,manifest,catalog]=await Promise.all([
      fetch(options.wasmUrl).then(r=>{if(!r.ok)throw Error('WASM download failed');return r.arrayBuffer();}),
      fetch(new URL('./build.json',import.meta.url)).then(r=>r.json()),
      // Game language: the server puts that localization's archives and
      // cinematics in place of the base installation's (same patch).
      fetch(options.language?`/api/assets?language=${encodeURIComponent(options.language)}`:'/api/assets').then(r=>{if(!r.ok)throw Error(`Game files for language ${options.language} are unavailable`);return r.json();}),
      fetch('/api/maps').then(r=>{if(!r.ok)throw Error('Map catalog download failed');return r.json();}),
    ]);
    if(stopped)return;
    const mountedMaps=new Map((catalog.maps||[]).map(map=>[map.id,map]));
    if(options.map)mountedMaps.set(options.map.id,options.map);
    // Archives, binaries and maps are game data kept on this device per
    // version (game-cache.mjs); cinematics stream through <video>.
    const entries=manifest.files.map(file=>file.version&&!/^(webmedia|movies)\//i.test(file.path)?{...file,cacheKey:cacheKey('a',file.id,file.version)}:file);
    // The catalog is the game's own Maps (and Campaigns) folder, as in an
    // installed copy: the map list opens directly on the catalog's folders.
    // Saves made while maps lived under Maps/Web record that path; a hidden
    // alias lets them load without showing a Web folder in the map list.
    for(const map of mountedMaps.values()){
      const folder=map.path.toLowerCase().endsWith('.w3n')?'Campaigns':'Maps',file={size:map.size,downloadUrl:map.downloadUrl,...map.sha256?{cacheKey:cacheKey('m',map.id,map.sha256)}:{}};
      entries.push({path:`${folder}/${map.path}`,...file},{path:`${folder}/Web/${map.path}`,...file,hidden:true});
    }
    log(`Mounted ${mountedMaps.size} server maps`);
    if(options.gameDataCache!==false){
      const cached=new Map(entries.filter(e=>e.cacheKey).map(e=>[e.cacheKey,{key:e.cacheKey,size:e.size,url:e.downloadUrl}]));
      disk=await GameDataCache.open([...cached.values()],{log});
    }
    const lookup=new Map(entries.map(e=>[e.path.toLowerCase(),e]));
    const mediaFile=lookup.get('webmedia/media.json'),movies=new Map();
    if(mediaFile){
      const media=await fetch(mediaFile.downloadUrl).then(r=>r.json());
      for(const[path,description]of Object.entries(media.movies||{})){
        const file=lookup.get(description.path.toLowerCase());if(file)movies.set(path.toLowerCase(),{...description,downloadUrl:file.downloadUrl});
      }
    }
    video=new WorkerVideo({movies});
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
    if(transport){
      const peers=pendingPeers||options.peerIds;
      if(peers)transport.dispatchEvent(new CustomEvent('peers',{detail:peers}));
      if(disconnected)transport.dispatchEvent(new Event('disconnect'));
    }
    if(options.canvas&&options.resolution){options.canvas.width=options.resolution.width;options.canvas.height=options.resolution.height;}
    const graphics=options.canvas?new FixedFunctionGL(options.canvas,{debugChecks:!!options.graphicsDebugChecks,legacyClampToEdge:options.legacyClampToEdge!==false,nativeTextureShader:options.nativeTextureShader!==false}):null;
    engine=await createRuntime({wasm,profile,images,...sourceFiles(entries,disk),log,graphics,video,
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
      const r=engine.host.graphics;
      frame.execution={rpcCalls:scheduler?.rpcCount||0,graphicsCommands:engine.host.graphicsBatchRegistry?.commands||0,graphicsBatches:engine.host.graphicsBatchRegistry?.batches||0};
      if(scheduler?.rpcByName)frame.execution.rpcByName=Object.fromEntries(scheduler.rpcByName);
      if(options.captureGraphics&&frame.frames===3)engine.host.hostTimings=new Map();
      if(options.captureGraphics&&frame.frames===4)r.capture=[];
      if(options.captureGraphics&&frame.frames===5){r.capturedFrame=r.capture;r.capture=null;}
      postMessage({type:'frame',frame});
    };
    engine.host.strictFinish=!!options.strictFinish;
    for(const file of options.savedFiles||[])engine.host.virtualFiles.set(file.path.toLowerCase(),new Uint8Array(file.data));
    engine.host.virtualFiles.checkpoint();
    postMessage({type:'linked',modules:engine.modules});
    engine.initialize();
    if(options.persist)saveTimer=setInterval(()=>{
      const changes=saveSnapshot(engine.host);
      if(changes.files.length||changes.deleted.length)postMessage({type:'save-changes',changes});
    },1000);
    scheduler=new GuestThreadScheduler(engine,{log,budget:options.budget??10000000,timeout:options.timeout??60000,batchGraphics:options.batchGraphics!==false,vsync:options.vsync!==false,maxFps:options.maxFps||0});
    // Diagnostic breakdown of synchronous broker calls by import name.
    if(options.profileRpc)scheduler.rpcByName=new Map();
    if(options.monitor)monitor=setInterval(()=>postMessage({type:'snapshot',snapshot:{
      time:performance.now(),calls:Object.values(scheduler.calls()).reduce((sum,n)=>sum+n,0),
      recent:engine.host.history.slice(-8),threads:scheduler.report(),heap:engine.host.heapStats(),
    }}),10000);
    await scheduler.runMain('war3.exe');
  } catch(caught) { error=caught;log(`${caught.name}: ${caught.message}`); }
  finally {
    clearInterval(monitor);clearInterval(saveTimer);
    scheduler?.stop();
    network?.destroy();
    const report=engine?engine.report(error):{wasmExecuted:false,gameplayVerified:false,error:error?{type:error.name,message:error.message,details:error.details}:null};
    if(scheduler){
      report.threads=scheduler.report();report.calls=scheduler.calls();
      report.execution={rpcCalls:scheduler.rpcCount,graphicsCommands:engine.host.graphicsBatchRegistry?.commands||0,graphicsBatches:engine.host.graphicsBatchRegistry?.batches||0};
    }
    if(engine?.host.graphics)report.graphics=engine.host.graphics.stats();
    if(engine?.host.graphics?.capturedFrame)report.graphics.capture=engine.host.graphics.capturedFrame;
    if(engine?.host.hostTimings)report.hostTimings=Object.fromEntries([...engine.host.hostTimings].sort((a,b)=>b[1].totalMs-a[1].totalMs));
    if(engine)report.heap=engine.host.heapStats();
    disk?.close();disk=null;
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
  else if(message.type==='stop'){stopped=true;scheduler?.stop();}
};
