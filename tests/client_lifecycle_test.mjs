import test from 'node:test';
import assert from 'node:assert/strict';
import {runDiagnostics} from '../web/runtime/client.mjs';
import {peerGonePacket} from '../web/runtime/winsock.mjs';

test('stopping flushes LAN packets and saves before releasing the worker, and retains lobby membership', async t => {
  class AudioContext {
    constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; }
    async resume() {}
    async close() { this.state = 'closed'; }
    createGain() { return {gain: {value: 1}, connect() {}, disconnect() {}}; }
  }
  let worker;
  class Worker {
    constructor() { worker = this; this.terminated = false; }
    postMessage(message) {
      if (message.type === 'start') this.options = message.options;
      if (message.type === 'stop') queueMicrotask(async () => {
        await this.onmessage({data: {type: 'packet', destination: 2, data: Uint8Array.of(0xf1)}});
        await this.onmessage({data: {type: 'finished', report: {wasmExecuted: true}, savedFiles: [{path: 'save/test.w3z', data: Uint8Array.of(7)}]}});
      });
    }
    terminate() { this.terminated = true; }
  }
  for (const [name, value] of [['AudioContext', AudioContext], ['Worker', Worker]]) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, {configurable: true, value});
    t.after(() => { if (previous) Object.defineProperty(globalThis, name, previous); else delete globalThis[name]; });
  }
  const transport = new EventTarget(), packets = [], reports = [];
  Object.assign(transport, {peerId: 1, peerIds: [1, 2], send: (destination, data) => packets.push({destination, data}), close: () => assert.fail('Game stop must retain its lobby')});
  let persist, release;
  const persisted = new Promise(resolve => { release = resolve; });
  const saves = {list: async () => [], applyChanges: async changes => { persist = changes; await persisted; }};
  const controller = await runDiagnostics({saves, transport, onReport: report => reports.push(report), timeout: 0,
    audioEnabled: false, batchGraphics: false, resolution: {width: 800, height: 600}});
  t.after(() => controller.stop());
  assert.equal(worker.options.audio, true, 'Mute must not remove the guest audio device');
  assert.equal(worker.options.batchGraphics, false);
  assert.deepEqual(worker.options.peerIds, [1, 2]);
  assert.deepEqual(worker.options.resolution, {width: 800, height: 600});
  const stopping = controller.stop();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(worker.terminated, false, 'Stop must wait for the final save transaction');
  // The lobby first hears that any earlier game of this page is gone, then the
  // game's own packets.
  assert.equal(packets[0].destination, 0);
  assert.deepEqual([...packets[0].data], [...peerGonePacket()]);
  assert.equal(packets[1].destination, 2);
  assert.deepEqual([...packets[1].data], [0xf1]);
  assert.equal(persist.files[0].path, 'save/test.w3z');
  assert.equal(reports.length, 0);
  release(); await stopping;
  assert.equal(worker.terminated, true);
  // After the game's last packets (its FINs), the others drop what is left.
  assert.equal(packets.length, 3);
  assert.equal(packets[2].destination, 0);
  assert.deepEqual([...packets[2].data], [...peerGonePacket()]);
  assert.equal(reports.length, 1);
  assert.equal(transport.peerId, 1);
});

test('worker failure drains accepted save writes before publishing a report or resolving stop', async t => {
  for (const writeFails of [false, true]) await t.test(writeFails ? 'storage failure still completes cleanup' : 'pending snapshot is committed', async t => {
    let audioClosed = false, worker, resolveWrite, rejectWrite;
    class AudioContext {
      constructor() { this.state = 'running'; this.destination = {}; }
      async resume() {}
      async close() { audioClosed = true; this.state = 'closed'; }
      createGain() { return {gain: {value: 1}, connect() {}, disconnect() {}}; }
    }
    class Worker {
      constructor() { worker = this; }
      postMessage() {}
      terminate() { this.terminated = true; }
    }
    for (const [name, value] of [['AudioContext', AudioContext], ['Worker', Worker]]) {
      const previous = Object.getOwnPropertyDescriptor(globalThis, name);
      Object.defineProperty(globalThis, name, {configurable: true, value});
      t.after(() => { if (previous) Object.defineProperty(globalThis, name, previous); else delete globalThis[name]; });
    }
    const pendingWrite = new Promise((resolve, reject) => { resolveWrite = resolve; rejectWrite = reject; });
    let committed = false, stopped = false, callbackStop = false;
    const reports = [], saves = {list: async () => [], applyChanges: async () => { await pendingWrite; committed = true; }};
    const controller = await runDiagnostics({saves, timeout: 0, onReport: report => {
      reports.push(report);
      // A report callback can request stop again without creating a cycle.
      void controller.stop().then(() => { callbackStop = true; });
    }});
    const saving = worker.onmessage({data: {type: 'save-changes', changes: {files: [{path: 'save/profile.w3z', data: Uint8Array.of(9)}]}}});
    await new Promise(resolve => setImmediate(resolve));
    worker.onerror({message: 'Guest worker crashed'});
    const stopping = controller.stop().then(() => { stopped = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(worker.terminated, true, 'A failed guest stops immediately');
    assert.equal(stopped, false, 'Cleanup must wait for accepted saves');
    assert.equal(reports.length, 0, 'The launcher must not allow a stale-profile relaunch');
    if (writeFails) rejectWrite(new Error('Storage unavailable')); else resolveWrite();
    await Promise.all([saving, stopping]);
    assert.equal(committed, !writeFails);
    assert.equal(audioClosed, true);
    assert.equal(callbackStop, true);
    assert.equal(reports.length, 1);
    assert.equal(reports[0].error.message, 'Guest worker crashed');
    assert.equal(reports[0].persistenceError, writeFails ? 'Storage unavailable' : undefined);
  });
});
