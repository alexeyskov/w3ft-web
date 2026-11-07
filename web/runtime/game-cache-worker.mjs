// "Preload the rest": downloads the game data blocks this device lacks into
// the same storage the runtime reads (game-cache.mjs). Runs in its own worker
// for synchronous file access; posts progress and stops on request.
// "prepare" (client.mjs prepareGame) downloads only what a launch needs first.
import {GameDataCache, BLOCK, blockCount} from './game-cache.mjs';

let cancelled = false;
const controllers = new Set();
const bytesOf = (size, block) => Math.min(BLOCK, size - block * BLOCK);

async function preload(entries) {
  const cache = await GameDataCache.open(entries);
  if (!cache) { postMessage({type:'error', code:'busy'}); return; }
  try {
    const plan = entries.map(entry => ({entry, blocks:cache.missing(entry.key)})).filter(item => item.blocks.length);
    const total = plan.reduce((sum, {entry, blocks}) => sum + blocks.reduce((bytes, block) => bytes + bytesOf(entry.size, block), 0), 0);
    let done = 0;
    postMessage({type:'progress', done, total});
    for (const {entry, blocks} of plan) {
      if (cancelled) break;
      if (!await cache.prepare(entry.key)) throw new Error('Game data storage is unavailable');
      // Consecutive missing blocks are downloaded together, up to 8 MiB.
      for (let first = 0; first < blocks.length && !cancelled;) {
        let last = first;
        while (last + 1 < blocks.length && blocks[last + 1] === blocks[last] + 1 && last - first < 31) last++;
        const start = blocks[first] * BLOCK, end = blocks[last] * BLOCK + bytesOf(entry.size, blocks[last]) - 1;
        const response = await fetch(entry.url, {headers:{Range:`bytes=${start}-${end}`}});
        if (response.status !== 206) throw new Error(`Download failed: HTTP ${response.status}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length !== end - start + 1) throw new Error('Incomplete download');
        for (let block = blocks[first]; block <= blocks[last]; block++) {
          const at = (block - blocks[first]) * BLOCK;
          if (!cache.write(entry.key, block, bytes.subarray(at, at + bytesOf(entry.size, block)))) {
            const estimate = await navigator.storage.estimate().catch(() => null);
            postMessage({type:'error', code:estimate && estimate.quota - estimate.usage < BLOCK * 4 ? 'quota' : 'write'});
            return;
          }
        }
        done += bytes.length; first = last + 1;
        postMessage({type:'progress', done, total});
      }
    }
    postMessage({type:cancelled ? 'cancelled' : 'done', done, total});
  } catch (error) {
    postMessage({type:'error', code:'network', message:error.message});
  } finally {
    cache.close();
  }
}

// Before a launch: the files and blocks the game reads up to its main menu.
// items: [{key, size, url, blocks}], `blocks` absent for a whole file. A whole
// file (executables, the intro cinematic) is one request, which the server
// may send gzip-compressed; blocks go as ranges of up to 8 MiB. Six downloads
// run at once: the menu needs many small ranges across the archives.
async function prepare(items, concurrency = 6) {
  const cache = await GameDataCache.open(items.map(({key, size, url}) => ({key, size, url})));
  if (!cache) { postMessage({type:'error', code:'busy'}); return; }
  const tasks = [];
  let lastProgress = 0;
  const progress = (force = false) => {
    const now = performance.now();
    if (!force && now - lastProgress < 100) return;
    lastProgress = now;
    postMessage({type:'progress', done:tasks.reduce((sum, task) => sum + task.done, 0), total:tasks.reduce((sum, task) => sum + task.bytes, 0)});
  };
  try {
    for (const item of items) {
      const missing = new Set(cache.missing(item.key));
      if (!missing.size) continue;
      if (!item.blocks) { tasks.push({item, whole:true, bytes:item.size, done:0}); continue; }
      const wanted = [...new Set(item.blocks)].filter(block => Number.isInteger(block) && block >= 0 && block < blockCount(item.size) && missing.has(block)).sort((a, b) => a - b);
      for (let first = 0; first < wanted.length;) {
        let last = first;
        while (last + 1 < wanted.length && wanted[last + 1] === wanted[last] + 1 && last - first < 31) last++;
        const start = wanted[first] * BLOCK, end = wanted[last] * BLOCK + bytesOf(item.size, wanted[last]) - 1;
        tasks.push({item, first:wanted[first], last:wanted[last], start, end, bytes:end - start + 1, done:0});
        first = last + 1;
      }
    }
    progress(true);
    for (const key of new Set(tasks.map(task => task.item.key))) if (!await cache.prepare(key)) throw new Error('Game data storage is unavailable');
    let next = 0, failure = null;
    const run = async () => {
      while (!cancelled && !failure && next < tasks.length) {
        const task = tasks[next++];
        try { await download(cache, task, progress); } catch (error) { failure ??= error; }
      }
    };
    await Promise.all(Array.from({length:Math.min(concurrency, tasks.length)}, run));
    if (cancelled) { postMessage({type:'cancelled'}); return; }
    if (failure) throw failure;
    progress(true);
    postMessage({type:'done'});
  } catch (error) {
    postMessage(cancelled ? {type:'cancelled'} : {type:'error', code:error.code || 'network', message:error.message});
  } finally {
    for (const controller of controllers) controller.abort();
    cache.close();
  }
}

async function download(cache, task, progress) {
  const controller = new AbortController();
  controllers.add(controller);
  try {
    const {item} = task;
    const response = await fetch(item.url, {signal:controller.signal, headers:task.whole ? {} : {Range:`bytes=${task.start}-${task.end}`}});
    if (response.status !== (task.whole ? 200 : 206)) throw new Error(`Download failed: HTTP ${response.status}`);
    // A gzip download counts its compressed bytes: what the network carries.
    const sent = Number(response.headers.get('Content-Length'));
    if (task.whole && response.headers.get('Content-Encoding') && sent > 0) task.bytes = sent;
    const expected = task.whole ? item.size : task.end - task.start + 1, bytes = new Uint8Array(expected);
    const reader = response.body.getReader();
    let received = 0;
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      if (received + value.length > expected) throw new Error('Unexpected download size');
      bytes.set(value, received); received += value.length;
      task.done = Math.round(received / expected * task.bytes); progress();
    }
    if (received !== expected) throw new Error('Incomplete download');
    if (!(task.whole ? await cache.writeAll(item.key, bytes) : writeBlocks(cache, task, bytes))) {
      const estimate = await navigator.storage.estimate().catch(() => null), error = new Error('Game data storage is full or unavailable');
      error.code = estimate && estimate.quota - estimate.usage < BLOCK * 4 ? 'quota' : 'write';
      throw error;
    }
    task.done = task.bytes; progress();
  } finally {
    controllers.delete(controller);
  }
}

function writeBlocks(cache, task, bytes) {
  for (let block = task.first; block <= task.last; block++) {
    const at = (block - task.first) * BLOCK;
    if (!cache.write(task.item.key, block, bytes.subarray(at, at + bytesOf(task.item.size, block)))) return false;
  }
  return true;
}

onmessage = ({data}) => {
  if (data?.type === 'cancel') { cancelled = true; for (const controller of controllers) controller.abort(); }
  else if (data?.type === 'preload') void preload(data.entries);
  else if (data?.type === 'prepare') void prepare(data.items, data.concurrency);
};
