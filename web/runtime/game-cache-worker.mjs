// Startup and manual preloads share cancellation, streaming and diagnostics.
// Game archives stay in 256 KiB OPFS blocks; no game code runs in this worker.
import {GameDataCache, BLOCK, blockCount} from './game-cache.mjs';
import {RETRY_DELAYS} from './range-request.mjs';

let cancelled = false;
// A dropped connection, a stalled body or a busy server: worth asking again.
const transient = (error, flag = true) => Object.assign(error, {transient: flag});
const retryableStatus = status => status === 408 || status === 429 || status >= 500;
const controllers = new Set();
const bytesOf = (size, block) => Math.min(BLOCK, size - block * BLOCK);
const IDLE_TIMEOUT = 30000;
const status = message => postMessage({type:'status', message});
const statistics = kind => ({kind, started:performance.now(), requests:0, completed:0,
  plannedBytes:0, cacheSkippedBytes:0, decodedBytes:0, transferBytes:0,
  firstByteTotalMs:0, firstByteSamples:0, bodyMs:0, cacheOpenMs:0, cacheWriteMs:0,
  cacheCloseMs:0, slowestMs:0, slowestFile:''});
function summarize(stats) {
  const {started, firstByteTotalMs, firstByteSamples, ...summary} = stats;
  return {...summary, elapsedMs:Math.round(performance.now()-started),
    firstByteMs:Math.round(firstByteTotalMs/Math.max(1,firstByteSamples)),
    bodyMs:Math.round(stats.bodyMs), cacheOpenMs:Math.round(stats.cacheOpenMs),
    cacheWriteMs:Math.round(stats.cacheWriteMs), cacheCloseMs:Math.round(stats.cacheCloseMs),
    slowestMs:Math.round(stats.slowestMs)};
}
async function openCache(entries, stats) {
  const start = performance.now();
  try { return await GameDataCache.open(entries, {log:status}); }
  finally { stats.cacheOpenMs += performance.now()-start; }
}
function closeCache(cache, stats) {
  const start = performance.now();
  try { cache?.close(); }
  finally { stats.cacheCloseMs += performance.now()-start; }
}
function appendRanges(tasks, item, blocks) {
  for (let first=0; first<blocks.length;) {
    let last=first;
    while (last+1<blocks.length && blocks[last+1]===blocks[last]+1 && last-first<31) last++;
    const start=blocks[first]*BLOCK, end=blocks[last]*BLOCK+bytesOf(item.size,blocks[last])-1;
    tasks.push({item,first:blocks[first],last:blocks[last],start,end,bytes:end-start+1,done:0});
    first=last+1;
  }
}
function progressFor(tasks) {
  let last=0;
  return (force=false) => {
    const now=performance.now();
    if (!force && now-last<100) return;
    last=now;
    postMessage({type:'progress',done:tasks.reduce((sum,task)=>sum+task.done,0),
      total:tasks.reduce((sum,task)=>sum+task.bytes,0)});
  };
}

async function preload(entries) {
  const stats=statistics('preload'),tasks=[];
  const diagnosticTimer=setInterval(()=>status(`Preload in progress: ${JSON.stringify(summarize(stats))}`),10000);
  let cache,terminal;
  try {
    cache=await openCache(entries,stats);
    if (!cache) throw Object.assign(new Error('Game data cache is unavailable or in use by another tab'),{code:'busy'});
    let requested=0;
    for (const item of entries) {
      requested+=item.size;
      appendRanges(tasks,item,cache.missing(item.key));
    }
    stats.plannedBytes=tasks.reduce((sum,task)=>sum+task.bytes,0);
    stats.cacheSkippedBytes=Math.max(0,requested-stats.plannedBytes);
    const progress=progressFor(tasks);
    progress(true);
    for (const key of new Set(tasks.map(task=>task.item.key))) {
      if (cancelled) break;
      const opening=performance.now(),handle=await cache.prepare(key);
      stats.cacheOpenMs+=performance.now()-opening;
      if (!handle) throw new Error('Game data storage is unavailable');
    }
    // The manual download fetches the whole game, often over a poor link. A
    // brief network failure is asked again with the pauses of the game's own
    // block reads (range-request.mjs) instead of ending the download.
    for (const task of tasks) {
      for (let attempt=1;!cancelled;attempt++) {
        try { await download(cache,task,progress,stats); break; }
        catch (error) {
          if (cancelled||!error.transient||attempt>RETRY_DELAYS.length) throw error;
          const delay=RETRY_DELAYS[attempt-1];
          stats.retries=(stats.retries||0)+1;task.done=0;progress(true);
          status(`Game data download: ${error.message}; retrying in ${delay/1000} s`);
          await new Promise(resolve=>setTimeout(resolve,delay));
        }
      }
      if (cancelled) break;
    }
    progress(true);
    terminal={type:cancelled?'cancelled':'done'};
  } catch (error) {
    terminal=cancelled?{type:'cancelled'}:{type:'error',code:error.code||'network',message:error.message};
  } finally {
    clearInterval(diagnosticTimer);
    for (const controller of controllers) controller.abort();
    closeCache(cache,stats);
    // The page terminates us after this message: flush/close first.
    postMessage({...terminal,metrics:summarize(stats)});
  }
}

// Startup ranges use six requests concurrently. Manual preload remains one
// bounded 8 MiB range at a time; both now expose actual transfer/write time.
async function prepare(items, concurrency=6) {
  const stats=statistics('prepare'),tasks=[];
  const diagnosticTimer=setInterval(()=>status(`Preload in progress: ${JSON.stringify(summarize(stats))}`),10000);
  let cache,terminal;
  try {
    cache=await openCache(items,stats);
    if (!cache) throw Object.assign(new Error('Game data cache is unavailable or in use by another tab'),{code:'busy'});
    let requested=0;
    for (const item of items) {
      const missing=new Set(cache.missing(item.key));
      if (!item.blocks) {
        requested+=item.size;
        if (missing.size) tasks.push({item,whole:true,bytes:item.size,done:0});
        continue;
      }
      const wanted=[...new Set(item.blocks)].filter(block=>Number.isInteger(block)&&block>=0&&block<blockCount(item.size)).sort((a,b)=>a-b);
      requested+=wanted.reduce((sum,block)=>sum+bytesOf(item.size,block),0);
      appendRanges(tasks,item,wanted.filter(block=>missing.has(block)));
    }
    stats.plannedBytes=tasks.reduce((sum,task)=>sum+task.bytes,0);
    stats.cacheSkippedBytes=Math.max(0,requested-stats.plannedBytes);
    const progress=progressFor(tasks);
    progress(true);
    for (const key of new Set(tasks.map(task=>task.item.key))) {
      if (cancelled) break;
      const opening=performance.now(),handle=await cache.prepare(key);
      stats.cacheOpenMs+=performance.now()-opening;
      if (!handle) throw new Error('Game data storage is unavailable');
    }
    let next=0,failure=null;
    const run=async()=>{
      while (!cancelled&&!failure&&next<tasks.length) {
        const task=tasks[next++];
        try { await download(cache,task,progress,stats); }
        catch (error) { failure??=error; }
      }
    };
    await Promise.all(Array.from({length:Math.min(concurrency,tasks.length)},run));
    if (failure&&!cancelled) throw failure;
    progress(true);
    terminal={type:cancelled?'cancelled':'done'};
  } catch (error) {
    terminal=cancelled?{type:'cancelled'}:{type:'error',code:error.code||'network',message:error.message};
  } finally {
    clearInterval(diagnosticTimer);
    for (const controller of controllers) controller.abort();
    closeCache(cache,stats);
    postMessage({...terminal,metrics:summarize(stats)});
  }
}

async function download(cache, task, progress, stats) {
  const controller=new AbortController(),began=performance.now();
  controllers.add(controller);
  let timer,headersAt=0,bodyFinished=false;
  const idle=()=>{clearTimeout(timer);timer=setTimeout(()=>controller.abort(),IDLE_TIMEOUT);};
  stats.requests++;
  idle();
  try {
    const {item}=task;
    let response;
    try { response=await fetch(item.url,{signal:controller.signal,headers:task.whole?{}:{Range:`bytes=${task.start}-${task.end}`}}); }
    catch (error) { throw error.name==='AbortError'?error:transient(error); }
    headersAt=performance.now();
    stats.firstByteTotalMs+=headersAt-began;stats.firstByteSamples++;
    if (response.status!==(task.whole?200:206)) {
      response.body?.cancel().catch(()=>{});
      throw transient(new Error(`Download failed: HTTP ${response.status} (${item.label||'game data'})`),retryableStatus(response.status));
    }
    const sent=Number(response.headers.get('Content-Length'));
    if (task.whole&&response.headers.get('Content-Encoding')&&sent>0) task.bytes=sent;
    const expected=task.whole?item.size:task.end-task.start+1,bytes=new Uint8Array(expected);
    const reader=response.body.getReader();
    let received=0;
    for (;;) {
      idle();
      let chunk;
      try { chunk=await reader.read(); }
      catch (error) { throw error.name==='AbortError'?error:transient(error); }
      const {done,value}=chunk;
      if (done) break;
      if (received+value.length>expected) throw new Error('Unexpected download size');
      bytes.set(value,received);received+=value.length;stats.decodedBytes+=value.length;
      task.done=Math.round(received/expected*task.bytes);progress();
    }
    clearTimeout(timer);
    stats.bodyMs+=performance.now()-headersAt;
    bodyFinished=true;
    if (received!==expected) throw transient(new Error('Incomplete download'));
    stats.transferBytes+=sent||received;
    const writing=performance.now();
    const stored=task.whole?await cache.writeAll(item.key,bytes):writeBlocks(cache,task,bytes);
    stats.cacheWriteMs+=performance.now()-writing;
    if (!stored) {
      const estimate=await navigator.storage.estimate().catch(()=>null),error=new Error('Game data storage is full or unavailable');
      error.code=estimate&&estimate.quota-estimate.usage<BLOCK*4?'quota':'write';throw error;
    }
    stats.completed++;task.done=task.bytes;progress();
  } catch (error) {
    if (!cancelled&&error.name==='AbortError') throw transient(Object.assign(new Error('Game data download stalled for 30 seconds'),{code:'timeout'}));
    throw error;
  } finally {
    if (headersAt&&!bodyFinished) stats.bodyMs+=performance.now()-headersAt;
    clearTimeout(timer);controllers.delete(controller);
    const elapsed=performance.now()-began;
    if (elapsed>stats.slowestMs) {stats.slowestMs=elapsed;stats.slowestFile=task.item.label||'game data';}
  }
}

function writeBlocks(cache, task, bytes) {
  for (let block=task.first;block<=task.last;block++) {
    const at=(block-task.first)*BLOCK;
    if (!cache.write(task.item.key,block,bytes.subarray(at,at+bytesOf(task.item.size,block)))) return false;
  }
  return true;
}

onmessage=({data})=>{
  if (data?.type==='cancel') {cancelled=true;for(const controller of controllers)controller.abort();}
  else if (data?.type==='preload') void preload(data.entries);
  else if (data?.type==='prepare') void prepare(data.items,data.concurrency);
};
