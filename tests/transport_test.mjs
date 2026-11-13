import test from 'node:test';
import assert from 'node:assert/strict';
import {FrameTransport} from '../web/src/transport.mjs';

class Socket extends EventTarget {
  static OPEN = 1;
  constructor(url) { super(); this.url = new URL(url); this.readyState = 1; this.bufferedAmount = 0; }
  message(data) { this.dispatchEvent(new MessageEvent('message', {data: typeof data === 'object' && !(data instanceof ArrayBuffer) ? JSON.stringify(data) : data})); }
  send(packet) { this.sent = packet; }
  close() { this.readyState = 3; queueMicrotask(() => this.dispatchEvent(new Event('close'))); }
}

function browser(t, url) {
  for (const [name, value] of [['location', new URL(url)], ['WebSocket', Socket]]) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, {configurable: true, writable: true, value});
    t.after(() => { if (previous) Object.defineProperty(globalThis, name, previous); else delete globalThis[name]; });
  }
}

test('a lobby joined before launch retains its peer roster and binary LAN transport', async t => {
  browser(t, 'https://warcraft.example/');
  const transport = new FrameTransport('public-lobby-code', {publicLobby: true});
  const connecting = transport.connect(), socket = transport.socket;
  assert.equal(socket.url.protocol, 'wss:');
  assert.equal(socket.url.searchParams.get('lobby'), '1');
  socket.message({type: 'welcome', peerId: 2, peers: [1, 2], presenceToken: 'first-connection', lobby: {id: transport.room, name: 'Friends', players: 2, maxPlayers: 12}});
  await connecting;
  assert.deepEqual(transport.peerIds, [1, 2]);
  assert.equal(transport.presenceToken, 'first-connection');
  let roster, packet;
  transport.addEventListener('peers', event => { roster = event.detail; });
  transport.addEventListener('packet', event => { packet = event.detail; });
  socket.message({type: 'peers', peers: [1, 2, 3]});
  assert.deepEqual(roster, [1, 2, 3]);
  assert.equal(transport.lobby.players, 3);
  transport.send(1, Uint8Array.of(0xf7, 0, 0xff));
  assert.deepEqual([...socket.sent], [1, 0xf7, 0, 0xff]);
  transport.send(255, Uint8Array.of(9, 1));
  assert.deepEqual([...socket.sent], [255, 9, 1]);
  assert.throws(()=>transport.send(256, Uint8Array.of(1)), /Invalid peer/);
  socket.message(Uint8Array.of(3, 0xf7, 0, 0xff).buffer);
  assert.equal(packet.source, 3);
  assert.deepEqual([...packet.data], [0xf7, 0, 0xff]);
  transport.close();
  await Promise.resolve();
  assert.equal(transport.peerId, 0);
  assert.deepEqual(transport.peerIds, []);
  assert.equal(transport.presenceToken, null);
});

test('leaving and immediately reconnecting ignores the old socket close event', async t => {
  browser(t, 'http://warcraft.example/');
  const transport = new FrameTransport('private-room-code');
  let connecting = transport.connect();
  transport.socket.message({type: 'welcome', peerId: 1});
  await connecting;
  assert.equal(transport.socket.url.search, '');
  let disconnects = 0;
  transport.addEventListener('disconnect', () => { disconnects++; });
  transport.close();
  connecting = transport.connect();
  const replacement = transport.socket;
  replacement.message({type: 'welcome', peerId: 3, presenceToken: 'replacement-connection'});
  await connecting;
  assert.equal(disconnects, 1);
  assert.equal(transport.socket, replacement);
  assert.equal(transport.peerId, 3);
  assert.equal(transport.presenceToken, 'replacement-connection');
  replacement.close();
  await Promise.resolve();
  assert.equal(disconnects, 2);
  assert.equal(transport.socket, null);
  assert.equal(transport.peerId, 0);
  assert.equal(transport.presenceToken, null);
});
