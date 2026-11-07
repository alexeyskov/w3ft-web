// "Preload the rest": downloads the game data blocks this device lacks into
// the same storage the runtime reads (game-cache.mjs). Runs in its own worker
// for synchronous file access; posts progress and stops on request.
import {GameDataCache, BLOCK} from './game-cache.mjs';

let cancelled = false;
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

onmessage = ({data}) => {
  if (data?.type === 'cancel') cancelled = true;
  else if (data?.type === 'preload') void preload(data.entries);
};
