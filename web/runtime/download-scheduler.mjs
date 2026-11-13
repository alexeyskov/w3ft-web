import {BLOCK} from './game-cache.mjs';
import {downloadTasks} from './download-plan.mjs';

// Runs beside the guest broker, using its OPFS handles. Never a second owner
// of game-data. Demand reads hold this scheduler while their existing urgent
// queue drains. Anticipated data and the background plan use one low-priority
// HTTP request, at most 1 MiB, yielding after every request.
export class DownloadScheduler {
  constructor(entries,disk,{plan,log=()=>{},onProgress=()=>{},onFileReady=()=>{},
    fetcher=(...args)=>fetch(...args),now=()=>performance.now(),quietMs=750,gapMs=40,idleMs=30000,retryMs=30000,
    estimate=()=>globalThis.navigator?.storage?.estimate?.()}={}) {
    Object.assign(this,{entries,disk,log,onProgress,onFileReady,fetcher,now,quietMs,gapMs,idleMs,retryMs,estimate});
    this.background=downloadTasks(entries,plan).filter(task=>{
      for(let block=task.first;block<=task.last;block++)if(!disk.has(task.entry.key,block))return true;
      return false;
    }); this.priority=[]; this.active=null;
    this.foreground=0; this.readyAt=0; this.started=false; this.closed=false; this.reason='';
    this.contextPhase=null;this.chosenMap=null;this.announced=new Set();this.cached=new Map();
    this.total=entries.reduce((sum,entry)=>sum+entry.size,0);
    for(const entry of entries)this.cached.set(entry.key,disk.cachedBytes(entry.key));
    this.state='waiting';this.phase='menu';this.lastProgress=-Infinity;this.sinceEstimate=Infinity;
    this.metrics={requests:0,bytes:0,preemptions:0,retries:0};
    this.connection=globalThis.navigator?.connection;
    this.connectionChanged=()=>{
      if(this.connection?.saveData)this.pause('save-data');
      else if(this.reason==='save-data')this.resume();
    };
    if(!plan)log('Background cache: no resource plan; unclassified archive blocks follow menu files and maps.');
  }
  start() {
    if(this.started||this.closed)return;
    this.started=true;
    this.connection?.addEventListener?.('change',this.connectionChanged);
    // Already-complete campaign videos can play directly from the disk too,
    // including when data saver pauses further downloading.
    for(const entry of this.entries)if(this.cached.get(entry.key)===entry.size)this.announce(entry);
    if(this.connection?.saveData){this.pause('save-data');return;}
    this.state='downloading'; this.emit(true); this.schedule();
  }
  emit(force=false) {
    if(!force && this.now()-this.lastProgress<1000)return;
    this.lastProgress=this.now();
    this.onProgress({state:this.state,reason:this.reason,phase:this.phase,
      cached:[...this.cached.values()].reduce((sum,value)=>sum+value,0),total:this.total});
  }
  stored(key) {
    if(this.cached.has(key))this.cached.set(key,this.disk.cachedBytes(key));
  }
  announce(entry) {
    this.stored(entry.key);
    if(!/^webmedia\/.+\.(webm|mp4)$/i.test(entry.label) || this.announced.has(entry.key) || this.cached.get(entry.key)!==entry.size)return;
    this.announced.add(entry.key);
    // File snapshots are disk-backed Blobs, never a movie-sized JS buffer.
    void this.disk.snapshot(entry.key).then(file=>{if(file&&!this.closed)this.onFileReady(entry,file);})
      .catch(error=>this.log(`Cached cinematic unavailable: ${error.message}`));
  }
  demand(file) {
    if(this.closed)return ()=>{};
    this.foreground++;
    if(this.active&&!this.active.abort.signal.aborted){this.metrics.preemptions++;this.active.abort.abort();}
    clearTimeout(this.timer);
    const key=file.cacheKey;
    this.hint(file);
    let released=false;
    return ()=>{
      if(released)return;released=true;this.foreground--;
      if(key)this.stored(key);
      this.readyAt=this.now()+this.quietMs;this.schedule();
    };
  }
  hint(file) {
    // Reading a map beyond its catalog header predicts match/campaign data,
    // even when that map is already cached. An arbitrary MPQ block is not a
    // reliable scene hint: unclassified menu data belongs to the final phase.
    if(this.closed||!/^(maps|campaigns)\//i.test(file.path||''))return;
    const key=file.cacheKey,phase=/^campaigns\/|\.w3n$/i.test(file.path)?'campaign':'match';
    if(phase!==this.contextPhase||key!==this.chosenMap) {
      this.contextPhase=phase;this.chosenMap=key;
      const selected=[],oldPriority=[],rest=[];
      for(const candidate of this.priority)(candidate.phase===phase?selected:oldPriority).push(candidate);
      for(const candidate of this.background)(candidate.phase===phase?selected:rest).push(candidate);
      selected.sort((a,b)=>Number(b.entry.key===this.chosenMap)-Number(a.entry.key===this.chosenMap));
      // The new context supersedes an old prediction (e.g. another map, or a
      // campaign chosen while match resources were being anticipated).
      this.background=rest;this.priority=[...selected,...oldPriority];
    }
  }
  pause(reason='user') {
    if(this.closed)return;
    this.reason=reason;this.state='paused';clearTimeout(this.timer);clearTimeout(this.retryTimer);this.active?.abort.abort();this.emit(true);
    if(reason==='network')this.retryTimer=setTimeout(()=>{if(this.reason==='network')this.resume();},this.retryMs);
  }
  resume() {
    if(this.closed)return;
    clearTimeout(this.retryTimer);
    this.reason='';this.state='downloading';this.sinceEstimate=Infinity;this.emit(true);this.schedule();
  }
  schedule() {
    clearTimeout(this.timer);
    if(!this.started||this.closed||this.reason||this.foreground||this.active||this.state==='complete')return;
    this.timer=setTimeout(()=>{void this.pump();},Math.max(this.gapMs,this.readyAt-this.now()));
  }
  async pump() {
    if(this.closed||this.reason||this.foreground||this.active)return;
    let queue,task,first;
    // Fast skip of blocks the game has filled since this plan was made.
    for(;;) {
      queue=this.priority.length?this.priority:this.background;task=queue.shift();
      if(!task){this.disk.flush();this.state='complete';this.emit(true);this.log(`Background cache complete: ${JSON.stringify(this.metrics)}`);return;}
      first=task.first;
      while(first<=task.last && this.disk.has(task.entry.key,first))first++;
      if(first<=task.last)break;
      this.stored(task.entry.key);this.announce(task.entry);
    }
    let last=first;
    while(last<task.last&&!this.disk.has(task.entry.key,last+1))last++;
    // Keep this task until all its blocks are committed; cancellation merely
    // retries the remaining blocks. Never make cached data depend on a queue.
    queue.unshift(task);
    const abort=new AbortController(),active={abort,task};this.active=active;this.phase=task.phase;
    active.done=this.download(task,first,last,abort).then(()=>{task.failures=0;},error=>{
      if(abort.signal.aborted&&!active.timeout)return;
      if(this.closed)return;
      if(error.code==='quota'||error.code==='storage'){this.pause(error.code);this.log(`Background cache paused: ${error.message}`);return;}
      task.failures=(task.failures||0)+1;this.metrics.retries++;
      this.log(`Background cache retry ${task.failures}: ${error.message}`);
      if(task.failures>=3){task.failures=0;this.pause('network');}
      else this.readyAt=this.now()+Math.min(10000,1000*2**task.failures);
    }).finally(()=>{this.active=null;this.stored(task.entry.key);this.announce(task.entry);this.emit();this.schedule();});
    await active.done;
  }
  async download(task,first,last,abort) {
    if(this.sinceEstimate>=32*1024*1024) {
      const space=await Promise.resolve(this.estimate()).catch(()=>null);this.sinceEstimate=0;
      if(space?.quota>0 && space.quota-space.usage<64*1024*1024)
        throw Object.assign(new Error('Not enough free browser storage'),{code:'quota'});
    }
    if(abort.signal.aborted)return;
    if(!await this.disk.prepare(task.entry.key))throw Object.assign(new Error('Cache is unavailable'),{code:'storage'});
    if(abort.signal.aborted)return;
    const start=first*BLOCK,end=Math.min((last+1)*BLOCK,task.entry.size)-1;
    let timer,reader;
    const idle=()=>{clearTimeout(timer);timer=setTimeout(()=>{if(this.active)this.active.timeout=true;abort.abort();},this.idleMs);};
    try {
      idle();this.metrics.requests++;
      const response=await this.fetcher(task.entry.url,{headers:{Range:`bytes=${start}-${end}`},signal:abort.signal,priority:'low'});
      reader=response.body?.getReader();
      if(response.status!==206||!reader||response.headers.get('Content-Range')!==`bytes ${start}-${end}/${task.entry.size}`)
        throw new Error(`Invalid background range response: HTTP ${response.status}`);
      let index=first,filled=0,block=new Uint8Array(Math.min(BLOCK,task.entry.size-index*BLOCK));
      for(;;) {
        idle();const {done,value}=await reader.read();if(done)break;
        if(abort.signal.aborted)return;
        this.metrics.bytes+=value.length;
        for(let offset=0;offset<value.length;) {
          if(index>last)throw new Error('Background range response is too long');
          const count=Math.min(block.length-filled,value.length-offset);
          block.set(value.subarray(offset,offset+count),filled);filled+=count;offset+=count;
          if(filled===block.length) {
            if(!this.disk.write(task.entry.key,index,block))throw Object.assign(new Error('Cannot write game cache'),{code:'storage'});
            this.sinceEstimate+=block.length;index++;filled=0;
            if(index<=last)block=new Uint8Array(Math.min(BLOCK,task.entry.size-index*BLOCK));
          }
        }
      }
      if(index<=last)throw new Error('Incomplete background range response');
    } finally {clearTimeout(timer);await reader?.cancel().catch(()=>{});}
  }
  async stop() {
    this.closed=true;clearTimeout(this.timer);clearTimeout(this.retryTimer);this.active?.abort.abort();
    this.connection?.removeEventListener?.('change',this.connectionChanged);
    await this.active?.done;
    this.disk.flush();this.log(`Background cache stopped: ${JSON.stringify(this.metrics)}`);
  }
}
