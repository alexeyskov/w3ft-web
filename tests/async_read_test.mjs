import test from 'node:test';
import assert from 'node:assert/strict';
import {WarcraftHost} from '../web/runtime/host.mjs';
import {installKernel} from '../web/runtime/kernel.mjs';
import {sourceFiles, describeNetwork, CHUNK} from '../web/runtime/game-files.mjs';

// A guest thread's ReadFile through the broker's real path (invokeAsync): a
// block from the server leaves only that thread waiting; data on this device
// is read in the call, exactly as before.
function fixture({later}) {
  const data = Uint8Array.from({length: 64}, (_, i) => i), reads = [], waits = [];
  let cursor = 0x10000;
  const h = new WarcraftHost({memory: new WebAssembly.Memory({initial: 64}), listFiles: () => ['war3.mpq'], fileSize: () => data.length,
    readFile: (path, offset, length) => { reads.push(offset); return data.slice(offset, offset + length); },
    readFileLater: (path, offset, length, options) => { waits.push({offset, length, ...options}); return later(data.slice(offset, offset + length)); }});
  h.base = 0; h.exports = {wc3_guest_alloc(size) { const p = cursor; cursor += size; return p; }};
  installKernel(h);
  const thread = id => { const cpu = h.alloc(64); h.registerContext(cpu, id); return cpu; };
  // stdcall from guest code: esp -> [return address, arguments...]
  const call = (cpu, name, args) => {
    const stack = h.alloc(64); h.w32(stack, 0x401000); args.forEach((value, i) => h.w32(stack + 4 + i * 4, value));
    h.view.setUint32(cpu + 16, stack, true);
    return h.invokeAsync((h.resolve('kernel32.dll', name) - 0xf1000000) / 16, cpu).then(() => h.view.getUint32(cpu, true));
  };
  const file = h.handlers.get('kernel32.dll!CreateFileA').fn([h.string('war3.mpq'), 0x80000000, 1, 0, 3, 0, 0]);
  return {h, data, reads, waits, thread, call, file};
}

test('a block from the server: the reading thread waits, its result and file position follow', async () => {
  let arrive;
  const {h, data, reads, waits, thread, call, file} = fixture({later: bytes => new Promise(resolve => { arrive = () => resolve(bytes); })});
  const storm = thread(3), output = h.alloc(16), count = h.alloc(4);
  const pending = call(storm, 'ReadFile', [file, output, 8, count, 0]);
  assert.deepEqual(waits, [{offset: 0, length: 8, stood: false}], 'a background thread: the game goes on');
  assert.equal(h.importMayWait, false, 'only during the import itself');
  // Meanwhile the broker serves another thread.
  assert.equal(h.handlers.get('kernel32.dll!GetCurrentThreadId').fn([]) >= 0, true);
  arrive();
  assert.equal(await pending, 1);
  assert.deepEqual([...h.copyOut(output, 8)], [...data.slice(0, 8)]);
  assert.equal(h.u32(count), 8);
  assert.equal(await call(storm, 'SetFilePointer', [file, 0, 0, 1]), 8, 'the position moved by the bytes read');
  assert.deepEqual(reads, [], 'no synchronous request');
  // The game thread waiting is counted as the game standing still.
  const game = thread(1), pendingGame = call(game, 'ReadFile', [file, output, 4, count, 0]);
  assert.equal(waits.at(-1).stood, true);
  arrive(); assert.equal(await pendingGame, 1);
});

test('data on this device, or guest code the broker runs itself: read in the call as before', async () => {
  const {h, reads, waits, thread, call, file} = fixture({later: () => null});
  const output = h.alloc(16), count = h.alloc(4);
  assert.equal(await call(thread(3), 'ReadFile', [file, output, 8, count, 0]), 1);
  assert.deepEqual(reads, [0]); assert.equal(waits.length, 1);
  // A synchronous import (a window procedure the broker runs) never waits.
  const sync = fixture({later: () => assert.fail('must not be asked')});
  assert.equal(sync.h.handlers.get('kernel32.dll!ReadFile').fn([sync.file, sync.h.alloc(8), 8, sync.h.alloc(4), 0]), 1);
  assert.deepEqual(sync.reads, [0]);
});

// The broker's file source: shared downloads, the device cache, the log.
function source(disk = null) {
  const file = {path: 'War3x.mpq', size: CHUNK * 3 + 100, downloadUrl: '/api/assets/x', cacheKey: 'a-x-1'};
  const requests = [], logged = [];
  let time = 0, resolve = [];
  const files = sourceFiles([file], disk, {log: line => logged.push(line), now: () => time,
    request: (url, start, end) => { requests.push(['sync', start]); time += 1500; return new Uint8Array(end - start).fill(start / CHUNK + 1); },
    requestAsync: (url, start, end) => { requests.push(['async', start]); return new Promise(done => resolve.push(() => { time += 2000; done(new Uint8Array(end - start).fill(start / CHUNK + 1)); })); }});
  return {files, requests, logged, release: () => { const list = resolve; resolve = []; list.forEach(done => done()); }};
}

test('the broker fetches a missing block once for every thread waiting on it', async () => {
  const stored = new Map();
  const disk = {has: (key, block) => stored.has(block), read: (key, block) => stored.get(block) ?? null, write: (key, block, data) => stored.set(block, data)};
  const {files, requests, logged, release} = source(disk);
  const first = files.readFileLater('War3x.mpq', CHUNK - 4, 8), second = files.readFileLater('war3x.mpq', CHUNK + 10, 4, {stood: true});
  assert.deepEqual(requests, [['async', 0], ['async', CHUNK]], 'the second read shares the first one\'s download of block 1');
  release();
  assert.deepEqual([...await first], [1, 1, 1, 1, 2, 2, 2, 2]);
  assert.deepEqual([...await second], [2, 2, 2, 2]);
  assert.equal(files.readFileLater('War3x.mpq', 0, 16), null, 'now on this device');
  assert.ok(stored.has(0) && stored.has(1));
  assert.deepEqual([...files.readFile('War3x.mpq', CHUNK * 2, 2)], [3, 3], 'a synchronous read of a new block');
  assert.equal(requests.at(-1)[0], 'sync');
  // Both downloads ended at 4 s; the shared one counts for its first reader,
  // a background thread. The synchronous one stopped the broker: the game stood.
  const report = files.networkReport();
  assert.deepEqual({blocks: report.blocks, stoodMs: report.stoodMs, backgroundMs: report.backgroundMs},
    {blocks: 3, stoodMs: 1500, backgroundMs: 8000});
  assert.match(logged[0], /^Slow game data from the server: 1 block over 1 s, up to 4\.0 s \(War3x\.mpq\)$/);
  assert.equal(logged.length, 1, 'at most one line in ten seconds');
  assert.match(describeNetwork(report), /^Game data from the server this session: 3 blocks, 0\.8 MB; the game waited 1\.5 s, background loading 8\.0 s; the longest block 4\.0 s \(War3x\.mpq\)$/);
});
