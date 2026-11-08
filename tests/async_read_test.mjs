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

// The broker's file source over a scripted server: block i holds bytes i + 1.
function source({latency = 400, blockBody = 60, blocks = 12, hold = null, cut = null, status = 206, disk = null} = {}) {
  const file = {path: 'War3x.mpq', size: CHUNK * blocks, downloadUrl: '/api/assets/x', cacheKey: 'a-x-1'};
  const data = new Uint8Array(file.size);
  for (let i = 0; i < blocks; i++) data.fill(i + 1, i * CHUNK, (i + 1) * CHUNK);
  const requests = [], singles = [], logged = [];
  let time = 0;
  const fetch = (url, init) => {
    const [, a, b] = init.headers.Range.match(/bytes=(\d+)-(\d+)/), start = +a, end = +b + 1;
    requests.push([start / CHUNK, (end - start) / CHUNK]);
    time += latency;
    let sent = 0;
    const body = new ReadableStream({async pull(controller) {
      if (sent >= end - start) return controller.close();
      if (cut !== null && sent >= cut * CHUNK) return controller.error(new TypeError('network error'));
      if (hold && sent >= CHUNK) await hold.promise;
      time += blockBody;
      controller.enqueue(data.slice(start + sent, start + sent + CHUNK)); sent += CHUNK;
    }}, {highWaterMark: 0}); // bytes come when read, as from a network
    return Promise.resolve({status, body});
  };
  const requestAsync = (url, start, end) => { singles.push(start / CHUNK); time += latency; return Promise.resolve(data.slice(start, end)); };
  const files = sourceFiles([file], disk, {log: line => logged.push(line), now: () => time, fetch, requestAsync,
    request: () => assert.fail('no synchronous request')});
  // A block in memory reads at once (null); one still coming is waited for.
  const read = async index => { const value = files.readFileLater('War3x.mpq', index * CHUNK + 8, 16); return value === null ? null : (await value)[0]; };
  const value = async index => (await read(index)) ?? files.readFile('War3x.mpq', index * CHUNK + 8, 16)[0];
  return {files, requests, singles, logged, read, value, advance: ms => { time += ms; }};
}

test('read-ahead: a reader going on in order gets 2, then 4 blocks per request on a distant connection', async () => {
  const {files, requests, value} = source();
  for (let index = 0; index < 11; index++) assert.equal(await value(index), index + 1);
  assert.deepEqual(requests, [[0, 1], [1, 2], [3, 4], [7, 4]], 'the window stops growing at 4 blocks');
  assert.equal(files.networkReport().requests, 4);
});

test('read-ahead stays off for random reads and for a connection limited by its speed', async () => {
  const random = source();
  for (const index of [5, 1, 9, 3]) assert.equal(await random.value(index), index + 1);
  assert.deepEqual(random.requests, [[5, 1], [1, 1], [9, 1], [3, 1]]);
  const slow = source({latency: 50, blockBody: 2000});
  for (const index of [0, 1, 2, 3]) assert.equal(await slow.value(index), index + 1);
  assert.deepEqual(slow.requests, [[0, 1], [1, 1], [2, 1], [3, 1]], 'as before: single blocks');
});

test('the needed block is handed over before the rest of its request arrives', async () => {
  let release; const hold = {promise: new Promise(resolve => { release = resolve; })};
  const {requests, read} = source({hold});
  await read(0); hold.promise.then(() => {});
  const first = await read(1);
  assert.equal(first, 2, 'block 1 without waiting for block 2');
  const second = read(2);
  release();
  assert.equal(await second, 3, 'block 2 from the same request');
  assert.deepEqual(requests, [[0, 1], [1, 2]]);
});

test('a broken or refused request: the rest comes block by block, with retries', async () => {
  const broken = source({cut: 0});
  assert.equal(await broken.value(0), 1);
  assert.equal(await broken.value(1), 2);
  assert.deepEqual(broken.singles, [0, 1], 'each cut request asks for its blocks alone');
  const late = source({cut: 1});
  assert.equal(await late.value(0), 1); assert.equal(await late.value(1), 2); assert.equal(await late.value(2), 3);
  assert.deepEqual(late.requests, [[0, 1], [1, 2]]); assert.deepEqual(late.singles, [2], 'only the block the cut request lost');
  const refused = source({status: 200});
  assert.equal(await refused.read(0), 1);
  assert.deepEqual(refused.singles, [0]);
});

test('waits and requests in the session line; data on this device needs no request', async () => {
  const stored = new Map();
  const disk = {has: (key, block) => stored.has(block), read: (key, block) => stored.get(block) ?? null, write: (key, block, data) => stored.set(block, data)};
  const {files, requests, logged, read, value, advance} = source({latency: 1200, disk});
  await read(0); await read(1); await value(2); advance(20000); await read(6);
  assert.equal(files.readFileLater('War3x.mpq', 0, 16), null, 'stored on this device');
  assert.ok(stored.has(0) && stored.has(2), 'the read-ahead block is stored too');
  assert.deepEqual(requests, [[0, 1], [1, 2], [6, 1]]);
  const report = files.networkReport();
  // 1.26 + 1.32 + 1.26 s: the scripted clock moves on with the next block before the waiting read resumes.
  assert.deepEqual({blocks: report.blocks, requests: report.requests, backgroundMs: report.backgroundMs}, {blocks: 4, requests: 3, backgroundMs: 3840});
  assert.equal(logged.length, 2, 'at most one line in ten seconds');
  assert.match(logged[0], /^Slow game data from the server: 1 read waited over 1 s, up to 1\.3 s \(War3x\.mpq\)$/);
  assert.match(describeNetwork(report), /^Game data from the server this session: 4 blocks, 1\.0 MB in 3 requests; waits: the game thread 0\.0 s, loading threads 3\.8 s \(the game often waits for them too\); the longest 1\.3 s \(War3x\.mpq\); lately the server answered in 1\.2 s, 256 KiB took 0\.1 s$/);
});
