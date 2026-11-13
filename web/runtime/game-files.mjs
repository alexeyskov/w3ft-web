import {rangeBlock, rangeBlockAsync} from './range-request.mjs';

// The server's game files for the runtime worker, in 256 KiB blocks: the last
// 64 in memory, game data on this device (game-cache.mjs), else the server.
//
// readFile returns the bytes at once; a block from the server stops the worker
// meanwhile. readFileLater is for a guest thread's ReadFile, which may wait:
// null when every block is here, else a Promise of the bytes, fetched while
// the worker goes on serving the other guest threads (rendering among them).
// Two threads asking for one block share its download.
//
// Read-ahead: a reader going through a file block after block (a music track,
// a large texture) gets the next blocks in the same request, each handed over
// as soon as its bytes are here. A request costs a round trip (about 0.5 s on
// a distant connection) while 256 KiB more may take far less, so the request
// grows to 2, then 4 blocks only while the reads go on in order and the last
// requests show a connection limited by its latency, not its speed. Random
// reads, a slow connection and data on this device are read as before.
export const CHUNK = 256 * 1024;
export const MAX_WINDOW = 4;
const STREAM_IDLE_MS = 30000;

export function sourceFiles(entries, disk = null, {log = () => {}, now = () => performance.now(), downloads = null,
  request = rangeBlock, requestAsync = rangeBlockAsync, fetch: fetcher = (...args) => fetch(...args)} = {}) {
  const files = new Map(entries.map(e => [e.path.replaceAll('\\', '/').toLowerCase(), e]));
  const cache = new Map(), pending = new Map(), recent = new Map();
  // For the log: blocks and requests to the server, and how long threads
  // waited for them; the game thread (or this worker) stood still meanwhile.
  const network = {blocks: 0, bytes: 0, requests: 0, stoodMs: 0, backgroundMs: 0, longestMs: 0, longestPath: '',
    slow: 0, slowMs: 0, slowPath: '', slowLogged: -Infinity};
  const waited = (file, ms, stood) => {
    if (stood) network.stoodMs += ms; else network.backgroundMs += ms;
    if (ms > network.longestMs) { network.longestMs = ms; network.longestPath = file.path; }
    if (ms < 1000) return;
    // A slow connection: at most one line in ten seconds.
    network.slow++; network.slowMs = Math.max(network.slowMs, ms); network.slowPath = file.path;
    const time = now();
    if (time - network.slowLogged < 10000) return;
    log(`Slow game data from the server: ${network.slow} read${network.slow > 1 ? 's' : ''} waited over 1 s, up to ${(network.slowMs / 1000).toFixed(1)} s (${network.slowPath})`);
    network.slowLogged = time; network.slow = 0; network.slowMs = 0;
  };
  // The connection by the last requests: time to the first byte, body time per block.
  const link = {latencyMs: 0, blockMs: 0, samples: 0};
  const measure = (latencyMs, bodyMs, blocks) => {
    const k = link.samples ? 0.3 : 1;
    link.latencyMs += (latencyMs - link.latencyMs) * k; link.blockMs += (bodyMs / blocks - link.blockMs) * k; link.samples++;
  };
  const latencyBound = () => link.samples > 0 && link.latencyMs > link.blockMs;
  // Blocks read lately, per file, with the request size of their reader.
  const touch = (file, index, window) => {
    let blocks = recent.get(file.downloadUrl);
    if (!blocks) recent.set(file.downloadUrl, blocks = new Map());
    blocks.delete(index); blocks.set(index, {at: now(), window});
    if (blocks.size > 64) blocks.delete(blocks.keys().next().value);
  };
  const previous = (file, index) => {
    const entry = recent.get(file.downloadUrl)?.get(index - 1);
    return entry && now() - entry.at < 5000 ? entry : null;
  };
  const canonical = path => {
    path = path.replaceAll('\\', '/').replace(/^C:\/Warcraft III\/?/i, '').replace(/^\.\//, '').toLowerCase();
    if (path.split('/').includes('..')) throw Error('Unsafe file path');
    const file = files.get(path); if (!file) throw Error(`File not found: ${path}`); return file;
  };
  const span = (file, offset, length) => {
    length = length === undefined ? file.size - offset : Math.min(length, file.size - offset);
    if (offset < 0 || length < 0 || length > 128 * 1024 * 1024) throw Error('Invalid file range');
    return length;
  };
  const keyOf = (file, index) => file.downloadUrl + ':' + index * CHUNK;
  const local = (file, index) => cache.has(keyOf(file, index)) || pending.has(keyOf(file, index)) || !!(file.cacheKey && disk?.has(file.cacheKey, index));
  const remember = (key, block) => { cache.set(key, block); if (cache.size > 64) cache.delete(cache.keys().next().value); };
  const store = (file, start, block) => { if (file.cacheKey) disk?.write(file.cacheKey, start / CHUNK, block); };
  // blocks: some of the range's blocks already in hand (readFileLater).
  const readFile = (path, offset = 0, length = undefined, blocks = null) => {
    const file = canonical(path); length = span(file, offset, length);
    // A map's first bytes come with the catalog: the startup read of every
    // map's HM3W header (124 bytes) needs no 256 KiB block of each map.
    if (file.header && offset + length <= file.header.length) return file.header.slice(offset, offset + length);
    if(length)downloads?.hint?.(file);
    const out = new Uint8Array(length);
    for (let done = 0; done < length;) {
      const start = Math.floor((offset + done) / CHUNK) * CHUNK, key = file.downloadUrl + ':' + start;
      let block = blocks?.get(start) ?? cache.get(key);
      // Game data on this device first, then the server (stored for next time).
      if (!block && file.cacheKey) block = disk?.read(file.cacheKey, start / CHUNK);
      if (!block) {
        const began = now();
        const release=downloads?.demand(file,start/CHUNK);
        try {
          block = request(file.downloadUrl, start, Math.min(start + CHUNK, file.size), {label: file.path, onRetry: log});
          network.requests++; network.blocks++; network.bytes += block.length; store(file, start, block);
          waited(file, now() - began, true);
        } finally { release?.(); }
      }
      remember(key, block);
      const begin = offset + done - start, n = Math.min(block.length - begin, length - done);
      if (n <= 0) throw Error('Truncated resource range');
      out.set(block.subarray(begin, begin + n), done); done += n;
    }
    return out;
  };
  // Blocks first .. first+count-1 in one request, each ready when its bytes
  // are here. On any trouble the rest come block by block, with retries.
  const fetchSpan = (file, first, count) => {
    const release=downloads?.demand(file,first);
    const entries = Array.from({length: count}, (_, i) => {
      const start = (first + i) * CHUNK, key = file.downloadUrl + ':' + start;
      let resolve, reject;
      const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
      promise.catch(() => {}).finally(() => { if (pending.get(key) === promise) pending.delete(key); });
      pending.set(key, promise);
      return {start, key, promise, resolve, reject, done: false};
    });
    const finish = (entry, block) => {
      if (entry.done) return;
      entry.done = true; network.blocks++; network.bytes += block.length;
      store(file, entry.start, block); remember(entry.key, block); entry.resolve(block);
    };
    const alone = entry => {
      network.requests++;
      requestAsync(file.downloadUrl, entry.start, Math.min(entry.start + CHUNK, file.size), {label: file.path, onRetry: log})
        .then(block => finish(entry, block), error => { entry.done = true; entry.reject(error); });
    };
    network.requests++;
    stream(file, entries, finish).catch(() => { for (const entry of entries) if (!entry.done) alone(entry); });
    const promises=entries.map(entry => entry.promise);
    // Includes adaptive read-ahead: the background must not compete with the
    // tail of a foreground stream after its first block reached the guest.
    void Promise.allSettled(promises).then(()=>release?.());
    return promises;
  };
  const stream = async (file, entries, finish) => {
    const start = entries[0].start, end = Math.min(entries.at(-1).start + CHUNK, file.size);
    const abort = new AbortController();
    let timer;
    const idle = () => { clearTimeout(timer); timer = setTimeout(() => abort.abort(), STREAM_IDLE_MS); };
    const began = now(); idle();
    try {
      const response = await fetcher(file.downloadUrl, {headers: {Range: `bytes=${start}-${end - 1}`}, signal: abort.signal});
      const headers = now();
      if (response.status !== 206 || !response.body) throw new Error(`HTTP ${response.status}`);
      const reader = response.body.getReader();
      let index = 0, block = new Uint8Array(Math.min(CHUNK, end - start)), filled = 0;
      for (;;) {
        idle();
        const {done, value} = await reader.read();
        if (done) break;
        for (let offset = 0; offset < value.length;) {
          if (index >= entries.length) throw new Error('Range answer is too long');
          const n = Math.min(block.length - filled, value.length - offset);
          block.set(value.subarray(offset, offset + n), filled); filled += n; offset += n;
          if (filled < block.length) continue;
          finish(entries[index++], block);
          if (index < entries.length) { block = new Uint8Array(Math.min(CHUNK, end - entries[index].start)); filled = 0; }
        }
      }
      if (index < entries.length) throw new Error('Range answer is too short');
      measure(headers - began, now() - headers, entries.length);
    } catch (error) { abort.abort(); throw error; }
    finally { clearTimeout(timer); }
  };
  // stood: the game thread asks, so the game stands still until it is here.
  const readFileLater = (path, offset = 0, length = undefined, {stood = false} = {}) => {
    const file = canonical(path); length = span(file, offset, length);
    if (!length || (file.header && offset + length <= file.header.length)) return null;
    downloads?.hint?.(file);
    const first = Math.floor(offset / CHUNK), last = Math.floor((offset + length - 1) / CHUNK);
    const blocks = new Map(), waits = [], missing = [];
    for (let index = first; index <= last; index++) {
      const key = keyOf(file, index), block = cache.get(key);
      if (block) blocks.set(index * CHUNK, block);
      else if (pending.has(key)) waits.push([index, pending.get(key)]);
      else if (!(file.cacheKey && disk?.has(file.cacheKey, index))) missing.push(index);
    }
    // The request size: doubled while this reader goes on in order and the
    // connection is limited by latency; one block otherwise. Reads of blocks
    // already here keep the reader's size for its next miss.
    const before = previous(file, first);
    const window = !missing.length ? before?.window ?? 1 : before && latencyBound() ? Math.min(MAX_WINDOW, before.window * 2) : 1;
    for (let index = first; index <= last; index++) touch(file, index, window);
    if (!missing.length && !waits.length) return null;
    // Contiguous runs of missing blocks; the last one reads ahead.
    const runs = [];
    for (const index of missing) {
      const run = runs.at(-1);
      if (run && run.first + run.count === index) run.count++; else runs.push({first: index, count: 1});
    }
    const ahead = runs.at(-1);
    if (ahead) {
      const blockCount = Math.ceil(file.size / CHUNK);
      while (ahead.count < window && ahead.first + ahead.count < blockCount && !local(file, ahead.first + ahead.count)) ahead.count++;
    }
    const began = now(), needed = [];
    for (const run of runs) fetchSpan(file, run.first, run.count).forEach((promise, i) => {
      const index = run.first + i;
      if (index <= last) needed.push(promise.then(block => blocks.set(index * CHUNK, block)));
    });
    for (const [index, promise] of waits) needed.push(promise.then(block => blocks.set(index * CHUNK, block)));
    return Promise.all(needed).then(() => { waited(file, now() - began, stood); return readFile(path, offset, length, blocks); });
  };
  const networkReport = () => ({blocks: network.blocks, bytes: network.bytes, requests: network.requests,
    stoodMs: Math.round(network.stoodMs), backgroundMs: Math.round(network.backgroundMs),
    longestMs: Math.round(network.longestMs), longestPath: network.longestPath,
    ...link.samples ? {firstByteMs: Math.round(link.latencyMs), blockMs: Math.round(link.blockMs)} : {}});
  return {readFile, readFileLater, networkReport, fileSize: path => canonical(path).size,
    listFiles: () => entries.map(e => e.hidden ? {path: e.path, hidden: true} : e.path)};
}

// The session's line in the log: how much came from the server and how long
// threads waited for it. Loading threads (Storm's file thread, the music
// loader) wait for the game too: it often stands still until they are done.
export function describeNetwork({blocks, bytes, requests = blocks, stoodMs, backgroundMs, longestMs, longestPath, firstByteMs, blockMs}) {
  const time = ms => ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60000)} min ${Math.round(ms % 60000 / 1000)} s`;
  return `Game data from the server this session: ${blocks} block${blocks === 1 ? '' : 's'}, ${(bytes / 1048576).toFixed(1)} MB in ${requests} request${requests === 1 ? '' : 's'}; ` +
    `waits: the game thread ${time(stoodMs)}, loading threads ${time(backgroundMs)} (the game often waits for them too); the longest ${time(longestMs)} (${longestPath})` +
    (firstByteMs === undefined ? '' : `; lately the server answered in ${time(firstByteMs)}, 256 KiB took ${time(blockMs)}`);
}
