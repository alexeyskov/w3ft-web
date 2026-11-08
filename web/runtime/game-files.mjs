import {rangeBlock, rangeBlockAsync} from './range-request.mjs';

// The server's game files for the runtime worker, in 256 KiB blocks: the last
// 64 in memory, game data on this device (game-cache.mjs), else the server.
//
// readFile returns the bytes at once; a block from the server stops the worker
// meanwhile. readFileLater is for a guest thread's ReadFile, which may wait:
// null when every block is here, else a Promise of the bytes, fetched while
// the worker goes on serving the other guest threads (rendering among them).
// Two threads asking for one block share its download.
export const CHUNK = 256 * 1024;

export function sourceFiles(entries, disk = null, {log = () => {}, now = () => performance.now(),
  request = rangeBlock, requestAsync = rangeBlockAsync} = {}) {
  const files = new Map(entries.map(e => [e.path.replaceAll('\\', '/').toLowerCase(), e]));
  const cache = new Map(), pending = new Map();
  // Blocks from the server, for the log: `stood` is the time the game stood
  // still for them (this worker or the game thread waited), `background` the
  // time other threads waited while the game went on.
  const network = {blocks: 0, bytes: 0, stoodMs: 0, backgroundMs: 0, longestMs: 0, longestPath: '',
    slow: 0, slowMs: 0, slowPath: '', slowLogged: -Infinity};
  const note = (file, bytes, ms, stood) => {
    network.blocks++; network.bytes += bytes;
    if (stood) network.stoodMs += ms; else network.backgroundMs += ms;
    if (ms > network.longestMs) { network.longestMs = ms; network.longestPath = file.path; }
    if (ms < 1000) return;
    // A slow connection: at most one line in ten seconds.
    network.slow++; network.slowMs = Math.max(network.slowMs, ms); network.slowPath = file.path;
    const time = now();
    if (time - network.slowLogged < 10000) return;
    log(`Slow game data from the server: ${network.slow} block${network.slow > 1 ? 's' : ''} over 1 s, up to ${(network.slowMs / 1000).toFixed(1)} s (${network.slowPath})`);
    network.slowLogged = time; network.slow = 0; network.slowMs = 0;
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
  const remember = (key, block) => { cache.set(key, block); if (cache.size > 64) cache.delete(cache.keys().next().value); };
  const store = (file, start, block) => { if (file.cacheKey) disk?.write(file.cacheKey, start / CHUNK, block); };
  // blocks: some of the range's blocks already in hand (readFileLater).
  const readFile = (path, offset = 0, length = undefined, blocks = null) => {
    const file = canonical(path); length = span(file, offset, length);
    // A map's first bytes come with the catalog: the startup read of every
    // map's HM3W header (124 bytes) needs no 256 KiB block of each map.
    if (file.header && offset + length <= file.header.length) return file.header.slice(offset, offset + length);
    const out = new Uint8Array(length);
    for (let done = 0; done < length;) {
      const start = Math.floor((offset + done) / CHUNK) * CHUNK, key = file.downloadUrl + ':' + start;
      let block = blocks?.get(start) ?? cache.get(key);
      // Game data on this device first, then the server (stored for next time).
      if (!block && file.cacheKey) block = disk?.read(file.cacheKey, start / CHUNK);
      if (!block) {
        const began = now();
        block = request(file.downloadUrl, start, Math.min(start + CHUNK, file.size), {label: file.path, onRetry: log});
        note(file, block.length, now() - began, true); store(file, start, block);
      }
      remember(key, block);
      const begin = offset + done - start, n = Math.min(block.length - begin, length - done);
      if (n <= 0) throw Error('Truncated resource range');
      out.set(block.subarray(begin, begin + n), done); done += n;
    }
    return out;
  };
  const fetchBlock = (file, start, stood) => {
    const key = file.downloadUrl + ':' + start;
    let fetching = pending.get(key);
    if (!fetching) {
      const began = now();
      fetching = requestAsync(file.downloadUrl, start, Math.min(start + CHUNK, file.size), {label: file.path, onRetry: log})
        .then(block => { note(file, block.length, now() - began, stood); store(file, start, block); remember(key, block); return block; })
        .finally(() => pending.delete(key));
      pending.set(key, fetching);
    }
    return fetching;
  };
  // stood: the game thread asks, so the game stands still until it is here.
  const readFileLater = (path, offset = 0, length = undefined, {stood = false} = {}) => {
    const file = canonical(path); length = span(file, offset, length);
    if (!length || (file.header && offset + length <= file.header.length)) return null;
    const blocks = new Map(), missing = [];
    for (let start = Math.floor(offset / CHUNK) * CHUNK; start < offset + length; start += CHUNK) {
      const block = cache.get(file.downloadUrl + ':' + start);
      if (block) blocks.set(start, block);
      else if (!(file.cacheKey && disk?.has(file.cacheKey, start / CHUNK))) missing.push(start);
    }
    if (!missing.length) return null;
    return Promise.all(missing.map(start => fetchBlock(file, start, stood).then(block => blocks.set(start, block))))
      .then(() => readFile(path, offset, length, blocks));
  };
  const networkReport = () => ({blocks: network.blocks, bytes: network.bytes, stoodMs: Math.round(network.stoodMs),
    backgroundMs: Math.round(network.backgroundMs), longestMs: Math.round(network.longestMs), longestPath: network.longestPath});
  return {readFile, readFileLater, networkReport, fileSize: path => canonical(path).size,
    listFiles: () => entries.map(e => e.hidden ? {path: e.path, hidden: true} : e.path)};
}

// The session's line in the log: how much came from the server and how long it took.
export function describeNetwork({blocks, bytes, stoodMs, backgroundMs, longestMs, longestPath}) {
  const time = ms => ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60000)} min ${Math.round(ms % 60000 / 1000)} s`;
  return `Game data from the server this session: ${blocks} block${blocks === 1 ? '' : 's'}, ${(bytes / 1048576).toFixed(1)} MB; ` +
    `the game waited ${time(stoodMs)}, background loading ${time(backgroundMs)}; the longest block ${time(longestMs)} (${longestPath})`;
}
