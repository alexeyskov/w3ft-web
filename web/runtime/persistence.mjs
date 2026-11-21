// The guest filesystem owns these bytes. Persistence receives immutable
// snapshots, so a later WriteFile cannot change an IndexedDB transaction.
export class FileOverlay extends Map {
  constructor(){super();this.dirty=new Set();this.deleted=new Set();}
  set(path,data){super.set(path,data);this.dirty.add(path);this.deleted.delete(path);return this;}
  delete(path){const existed=super.delete(path);if(existed){this.dirty.add(path);this.deleted.add(path);}return existed;}
  clear(){for(const path of this.keys())this.delete(path);}
  // Gone without a trace: the saves never had this file.
  forget(path){super.delete(path);this.dirty.delete(path);this.deleted.delete(path);}
  checkpoint(){this.dirty.clear();this.deleted.clear();}
  changes(ready=()=>true){
    const files=[],deleted=[];
    for(const path of this.dirty){if(!ready(path))continue;const data=this.get(path);if(data)files.push({path,data:data.slice()});else deleted.push(path);this.dirty.delete(path);}
    return {files,deleted};
  }
}

// Warcraft's screenshots (Print Screen, screenshot.mjs) belong to the player,
// not to the saves: each finished one leaves the guest filesystem for the page.
export const isScreenshot=path=>/^screenshots\//i.test(path);
// The player's own maps: Warcraft's download folder, where a LAN game puts the
// host's map. They live in the browser's map store (the launcher's Maps tab),
// apart from the saves, and are never sent to the server.
export const USER_MAPS='maps/download/';
export const isUserMap=path=>/^maps\/download\/[^/]+\.w3[mx]$/i.test(path);
// A stored map in the guest filesystem without its bytes in memory: read in
// 256 KiB blocks from its Blob (on disk in the browser's storage) as Warcraft
// reads it. A dedicated worker reads Blobs synchronously (FileReaderSync).
// The last 32 blocks read (8 MiB) are kept for all stored maps together: the
// game's start reads the first bytes of every map for its lists.
const STORED_BLOCK=256*1024,STORED_BLOCKS=32,storedBlocks=new Map();
let storedFiles=0;
export class StoredFile {
  constructor(blob,{read=part=>new FileReaderSync().readAsArrayBuffer(part)}={}){this.blob=blob;this.length=blob.size;this.read=read;this.id=++storedFiles;}
  block(index){
    const key=`${this.id}:${index}`;
    let block=storedBlocks.get(key);
    if(block){storedBlocks.delete(key);storedBlocks.set(key,block);return block;}
    const start=index*STORED_BLOCK;
    block=new Uint8Array(this.read(this.blob.slice(start,Math.min(this.length,start+STORED_BLOCK))));
    storedBlocks.set(key,block);if(storedBlocks.size>STORED_BLOCKS)storedBlocks.delete(storedBlocks.keys().next().value);
    return block;
  }
  // Uint8Array.prototype.slice for the ranges the kernel asks for.
  slice(start=0,end=this.length){
    start=Math.max(0,Math.min(this.length,start));end=Math.max(start,Math.min(this.length,end));
    const out=new Uint8Array(end-start);
    for(let at=start;at<end;){
      const index=Math.floor(at/STORED_BLOCK),block=this.block(index),offset=at-index*STORED_BLOCK,n=Math.min(block.length-offset,end-at);
      if(n<=0)throw new Error('Stored map is shorter than recorded');
      out.set(block.subarray(offset,offset+n),at-start);at+=n;
    }
    return out;
  }
}
export const REGISTRY_FILE='__w3ft__/registry.json';
export function restoreRegistry(host){
  const data=host.virtualFiles.get(REGISTRY_FILE);
  if(data&&!host.registry?.restore(data))host.log?.('Saved game settings are invalid; using defaults.');
}
const openForWriting=host=>new Set([...host.handles.values()].filter(item=>item.kind==='file'&&item.writing).map(item=>item.key));

export function takeScreenshots(host){
  const writing=openForWriting(host),overlay=host.virtualFiles;
  const taken=[...overlay].filter(([path])=>isScreenshot(path)&&!writing.has(path)).map(([path,data])=>({path,data:data.slice()}));
  for(const {path} of taken)overlay.forget(path);
  return taken;
}

// Maps the guest has finished writing (a LAN download) or deleted, for the
// map store. Only with separateMaps; otherwise they stay with the saves, as
// for a launcher without a map store. sizes: the size a LAN host announced
// for each map path (map-offers.mjs); a closed file of another size is an
// interrupted download and stays out.
export function mapChanges(host,sizes=null){
  const writing=openForWriting(host),overlay=host.virtualFiles;
  const complete=path=>{const size=sizes?.get(path),data=overlay.get(path);return size===undefined||!data||data.length===size;};
  return overlay.changes(path=>isUserMap(path)&&!writing.has(path)&&complete(path));
}

export function saveSnapshot(host,{full=false,separateMaps=false}={}){
  if(host.registry?.dirty){
    const data=host.registry.encode();
    if(data)host.virtualFiles.set(REGISTRY_FILE,data);
    else host.log?.('Game settings exceed the snapshot limit; retaining the previous settings.');
    host.registry.dirty=false;
  }
  // MPQ saves are written in multiple calls. A timer or runtime stop must not
  // overwrite the last good IndexedDB save with an unfinished open file.
  const writing=openForWriting(host),saved=path=>!isScreenshot(path)&&!(separateMaps&&isUserMap(path));
  const ready=path=>saved(path)&&!writing.has(path),overlay=host.virtualFiles;
  if(!full)return overlay.changes(ready);
  return {files:[...overlay].filter(([path])=>ready(path)).map(([path,data])=>({path,data:data.slice()})),
    deleted:[...overlay.deleted].filter(ready),deferred:[...overlay.dirty].filter(path=>saved(path)&&!ready(path))};
}

// Message handlers run concurrently while IndexedDB awaits its transaction.
// Keep snapshots in guest order and let a final full snapshot retry a failure.
export class SaveWriter {
  constructor(store,onError=()=>{}){this.store=store;this.onError=onError;this.pending=Promise.resolve();this.error=null;}
  enqueue(changes){
    this.pending=this.pending.then(async()=>{
      if(!this.store)return;
      try{
        if(this.store.applyChanges)await this.store.applyChanges(changes);
        else{
          for(const path of changes.deleted||[]){if(!this.store.remove)throw Error('Save adapter cannot persist file deletion');await this.store.remove(path);}
          for(const file of changes.files||[])await this.store.write(file.path,file.data);
        }
        if(changes.full)this.error=null;
      }catch(error){this.error=error;this.onError(error);}
    });
    return this.pending;
  }
}
