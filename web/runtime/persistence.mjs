// The guest filesystem owns these bytes. Persistence receives immutable
// snapshots, so a later WriteFile cannot change an IndexedDB transaction.
export class FileOverlay extends Map {
  constructor(){super();this.dirty=new Set();this.deleted=new Set();}
  set(path,data){super.set(path,data);this.dirty.add(path);this.deleted.delete(path);return this;}
  delete(path){const existed=super.delete(path);if(existed){this.dirty.add(path);this.deleted.add(path);}return existed;}
  clear(){for(const path of this.keys())this.delete(path);}
  checkpoint(){this.dirty.clear();this.deleted.clear();}
  changes(ready=()=>true){
    const files=[],deleted=[];
    for(const path of this.dirty){if(!ready(path))continue;const data=this.get(path);if(data)files.push({path,data:data.slice()});else deleted.push(path);this.dirty.delete(path);}
    return {files,deleted};
  }
}

export function saveSnapshot(host,{full=false}={}){
  // MPQ saves are written in multiple calls. A timer or runtime stop must not
  // overwrite the last good IndexedDB save with an unfinished open file.
  const writing=new Set([...host.handles.values()].filter(item=>item.kind==='file'&&item.writing).map(item=>item.key));
  const ready=path=>!writing.has(path),overlay=host.virtualFiles;
  if(!full)return overlay.changes(ready);
  return {files:[...overlay].filter(([path])=>ready(path)).map(([path,data])=>({path,data:data.slice()})),
    deleted:[...overlay.deleted].filter(ready),deferred:[...overlay.dirty].filter(path=>!ready(path))};
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
