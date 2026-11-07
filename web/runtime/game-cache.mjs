// Game data on this device. The runtime reads game files in 256 KiB blocks;
// blocks are kept in the origin private file system (OPFS) as they are read,
// or all at once by "Preload". Each file version is one OPFS file; index.json
// records which blocks it holds. The runtime worker reads them synchronously
// (FileSystemSyncAccessHandle). One holder at a time (Web Lock): a second tab
// with a game, or a preload, works over the network instead.
export const BLOCK = 256 * 1024;
const DIRECTORY = 'game-data', INDEX = 'index.json', LOCK = 'wc3-game-data';

export const cacheKey = (kind, id, version) => `${kind}-${String(id).slice(0, 32)}-${String(version).slice(0, 16)}`.replace(/[^A-Za-z0-9_-]/g, '_');
const family = key => key.split('-').slice(0, 2).join('-');

// Game files of one language: archives, binaries and maps. Cinematics stream
// through <video> elements and are not cached.
export function cacheEntries(assets, maps = []) {
  const entries = [];
  for (const file of assets) {
    if (file.version && !/^(webmedia|movies)\//i.test(file.path)) entries.push({key:cacheKey('a', file.id, file.version), size:file.size, url:file.downloadUrl});
  }
  for (const map of maps) if (map.sha256) entries.push({key:cacheKey('m', map.id, map.sha256), size:map.size, url:map.downloadUrl});
  return entries;
}
export function blockCount(size) { return Math.ceil(size / BLOCK); }
const blockBytes = (size, block) => Math.min(BLOCK, size - block * BLOCK);
function cachedBytes(size, bits) {
  let total = 0;
  for (let block = 0; block < blockCount(size); block++) if (bits[block >> 3] >> (block & 7) & 1) total += blockBytes(size, block);
  return total;
}
const encode = bits => { let text = ''; for (let i = 0; i < bits.length; i += 0x8000) text += String.fromCharCode(...bits.subarray(i, i + 0x8000)); return btoa(text); };
const decode = (text, length) => { const bits = new Uint8Array(length); try { const raw = atob(text || ''); for (let i = 0; i < Math.min(length, raw.length); i++) bits[i] = raw.charCodeAt(i); } catch {} return bits; };

export const cacheSupported = () => !!(globalThis.navigator?.storage?.getDirectory && globalThis.navigator?.locks);

async function directory() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(DIRECTORY, {create:true});
}
// Holds the lock until release() is called; null when someone else has it.
async function acquire() {
  return new Promise((resolve, reject) => {
    navigator.locks.request(LOCK, {ifAvailable:true}, lock => {
      if (!lock) { resolve(null); return undefined; }
      return new Promise(release => resolve(release));
    }).catch(reject);
  });
}

// Sizes only, for the launcher page (asynchronous APIs).
export async function cacheStatus(entries) {
  const total = entries.reduce((sum, entry) => sum + entry.size, 0);
  if (!cacheSupported()) return {supported:false, total, cached:0};
  let index = {};
  try {
    const file = await (await (await directory()).getFileHandle(INDEX)).getFile();
    index = JSON.parse(await file.text()).files || {};
  } catch {}
  let cached = 0;
  for (const entry of entries) {
    const record = index[entry.key];
    if (record?.size === entry.size) cached += cachedBytes(entry.size, decode(record.blocks, Math.ceil(blockCount(entry.size) / 8)));
  }
  return {supported:true, total, cached};
}

export async function clearCache() {
  if (!cacheSupported()) return;
  const release = await acquire();
  if (!release) throw new Error('busy');
  try { await (await navigator.storage.getDirectory()).removeEntry(DIRECTORY, {recursive:true}); }
  catch (error) { if (error?.name !== 'NotFoundError') throw error; }
  finally { release(); }
}

// Worker side: synchronous block reads and writes for one session.
export class GameDataCache {
  static async open(entries, {log = () => {}} = {}) {
    if (!cacheSupported() || typeof FileSystemSyncAccessHandle === 'undefined') return null;
    const release = await acquire().catch(() => null);
    if (!release) { log('Game data cache is in use by another tab; reading over the network.'); return null; }
    const cache = new GameDataCache(release, log);
    try { await cache._load(entries); return cache; }
    catch (error) { log(`Game data cache unavailable: ${error.message}`); cache.close(); return null; }
  }
  constructor(release, log) {
    this.release = release; this.log = log; this.files = new Map(); this.index = {}; this.flushTimer = null; this.closed = false;
  }
  async _load(entries) {
    this.directory = await directory();
    this.indexHandle = await (await this.directory.getFileHandle(INDEX, {create:true})).createSyncAccessHandle();
    const size = this.indexHandle.getSize();
    if (size) {
      const bytes = new Uint8Array(size); this.indexHandle.read(bytes, {at:0});
      try { this.index = JSON.parse(new TextDecoder().decode(bytes)).files || {}; } catch { this.index = {}; }
    }
    // A newer version of a file replaces the stored one.
    const current = new Set(entries.map(entry => entry.key)), families = new Set(entries.map(entry => family(entry.key)));
    for (const key of Object.keys(this.index)) {
      if (!current.has(key) && families.has(family(key))) {
        delete this.index[key];
        await this.directory.removeEntry(key).catch(() => {});
      }
    }
    for (const entry of entries) {
      const length = Math.ceil(blockCount(entry.size) / 8), record = this.index[entry.key];
      const bits = record?.size === entry.size ? decode(record.blocks, length) : new Uint8Array(length);
      const file = {entry, bits, handle:null, opening:null, pending:[]};
      this.files.set(entry.key, file);
      if (bits.some(Boolean)) await this._handle(file);
    }
  }
  async _handle(file) {
    if (file.handle || this.closed) return file.handle;
    file.opening ??= (async () => {
      const handle = await (await this.directory.getFileHandle(file.entry.key, {create:true})).createSyncAccessHandle();
      if (this.closed) { handle.close(); return null; }
      file.handle = handle;
      for (const [block, data] of file.pending.splice(0)) this.write(file.entry.key, block, data);
      return handle;
    })().catch(error => { this.log(`Game data cache: ${error.message}`); return null; });
    return file.opening;
  }
  has(key, block) { const file = this.files.get(key); return !!file?.handle && !!(file.bits[block >> 3] >> (block & 7) & 1); }
  read(key, block) {
    if (!this.has(key, block)) return null;
    const file = this.files.get(key), data = new Uint8Array(blockBytes(file.entry.size, block));
    try { return file.handle.read(data, {at:block * BLOCK}) === data.length ? data : null; } catch { return null; }
  }
  write(key, block, data) {
    const file = this.files.get(key);
    if (!file || this.closed || data.length !== blockBytes(file.entry.size, block)) return false;
    // Storage of a file opens asynchronously on its first block; blocks read
    // meanwhile are written once it is open.
    if (!file.handle) { if (file.pending.length < 16) file.pending.push([block, data.slice()]); void this._handle(file); return false; }
    try { file.handle.write(data, {at:block * BLOCK}); }
    catch (error) { this.log(`Game data cache write failed: ${error.message}`); return false; }
    file.bits[block >> 3] |= 1 << (block & 7);
    this.index[key] = {size:file.entry.size, blocks:encode(file.bits)};
    this.flushTimer ??= setTimeout(() => this.flush(), 2000);
    return true;
  }
  readAll(key) {
    const file = this.files.get(key);
    if (!file?.handle || this.missing(key).length) return null;
    const data = new Uint8Array(file.entry.size);
    try { return file.handle.read(data, {at:0}) === data.length ? data : null; } catch { return null; }
  }
  async writeAll(key, data) {
    const file = this.files.get(key);
    if (!file || data.length !== file.entry.size || !await this._handle(file)) return false;
    for (let block = 0; block < blockCount(file.entry.size); block++) {
      if (!this.write(key, block, data.subarray(block * BLOCK, block * BLOCK + blockBytes(file.entry.size, block)))) return false;
    }
    return true;
  }
  missing(key) {
    const file = this.files.get(key), blocks = [];
    for (let block = 0; block < blockCount(file.entry.size); block++) if (!(file.bits[block >> 3] >> (block & 7) & 1)) blocks.push(block);
    return blocks;
  }
  async prepare(key) { return this._handle(this.files.get(key)); }
  flush() {
    clearTimeout(this.flushTimer); this.flushTimer = null;
    if (this.closed || !this.indexHandle) return;
    const bytes = new TextEncoder().encode(JSON.stringify({schemaVersion:1, files:this.index}));
    try { this.indexHandle.truncate(0); this.indexHandle.write(bytes, {at:0}); this.indexHandle.flush(); }
    catch (error) { this.log(`Game data index write failed: ${error.message}`); }
  }
  close() {
    if (this.closed) return;
    this.flush(); this.closed = true;
    for (const file of this.files.values()) { try { file.handle?.flush(); file.handle?.close(); } catch {} }
    try { this.indexHandle?.close(); } catch {}
    this.release();
  }
}
