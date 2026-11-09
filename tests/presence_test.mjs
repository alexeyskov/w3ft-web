import test from 'node:test';
import assert from 'node:assert/strict';
import {PresenceCounter} from '../web/src/presence.mjs';

class Socket {
  static OPEN = 1;
  constructor(url) { this.url = new URL(url); this.readyState = 0; this.sent = []; }
  open() { this.readyState = 1; this.onopen?.(); }
  send(value) { this.sent.push(JSON.parse(value)); }
  message(value) { this.onmessage?.({data:JSON.stringify(value)}); }
  close() { this.readyState = 3; queueMicrotask(() => this.onclose?.()); }
}

function counter(t) {
  for (const [name, value] of [['location', new URL('https://warcraft.example/')], ['WebSocket', Socket]]) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, {configurable:true, writable:true, value});
    t.after(() => { if (previous) Object.defineProperty(globalThis, name, previous); else delete globalThis[name]; });
  }
  const value = new PresenceCounter();
  t.after(() => value.stop());
  return value;
}

test('LAN presence carries its relay token and clears it when the game stops', t => {
  const presence = counter(t);
  presence.update({playing:true, lan:true, presenceToken:'connection-one'});
  presence.start();
  presence.socket.open();
  assert.equal(presence.socket.url.href, 'wss://warcraft.example/api/presence');
  assert.deepEqual(presence.socket.sent.at(-1), {playing:true, lan:true, presenceToken:'connection-one', control:1});
  presence.update({playing:false, lan:true, presenceToken:'connection-one'});
  assert.deepEqual(presence.socket.sent.at(-1), {playing:false, lan:false, presenceToken:null, control:1});
});

test('an administrator kick stops automatic and page-restoration reconnects', async t => {
  const presence = counter(t).start(), socket = presence.socket;
  let kicks = 0;
  presence.addEventListener('kicked', () => kicks++);
  socket.open();
  socket.message({type:'kick'});
  await Promise.resolve();
  assert.equal(kicks, 1);
  assert.equal(presence.kicked, true);
  assert.equal(presence.socket, null);
  assert.equal(presence.timer, null);
  presence.start();
  assert.equal(presence.socket, null, 'pageshow must not undo a kick');
  socket.message({type:'kick'});
  assert.equal(kicks, 1);
});

test('the reserved close code also stops reconnection if the kick message was lost', t => {
  const presence = counter(t).start(), socket = presence.socket;
  socket.open();
  socket.onclose({code:4003});
  assert.equal(presence.kicked, true);
  assert.equal(presence.timer, null);
});

test('one change event exposes matching presence and lobby snapshots', t => {
  const presence = counter(t).start();
  const socket = presence.socket;
  socket.open();
  const changes = [];
  presence.addEventListener('change', () => changes.push({counts:presence.counts, lobbies:presence.lobbies}));
  const lobbies = [{id:'shared-en-1', players:1, maxPlayers:200}];
  socket.message({type:'presence', online:2, playing:1, lan:1, lobbies, privatePlayers:0});
  assert.deepEqual(changes, [{counts:{online:2, playing:1, lan:1}, lobbies:{lobbies, privatePlayers:0}}]);
  // Roster changes still reach the UI when no game/presence flag changes.
  socket.message({type:'presence', online:2, playing:1, lan:1, lobbies:[], privatePlayers:1});
  assert.equal(changes.length, 2);
  assert.deepEqual(presence.lobbies, {lobbies:[], privatePlayers:1});
});

test('stopped and replaced sockets cannot restore stale lobby counts', async t => {
  const presence = counter(t).start(), old = presence.socket;
  old.open();
  old.message({type:'presence', online:1, playing:1, lan:1, lobbies:[], privatePlayers:1});
  old.close();
  await Promise.resolve();
  assert.equal(presence.counts, null);
  assert.equal(presence.lobbies, null);
  presence.stop();
  presence.update({playing:false, lan:false});
  presence.start();
  const replacement = presence.socket;
  replacement.open();
  replacement.message({type:'presence', online:1, playing:0, lan:0, lobbies:[], privatePlayers:0});
  old.message({type:'presence', online:99, playing:99, lan:99, lobbies:[], privatePlayers:99});
  assert.deepEqual(presence.counts, {online:1, playing:0, lan:0});
  presence.stop();
  replacement.message({type:'presence', online:99, playing:99, lan:99, lobbies:[], privatePlayers:99});
  assert.equal(presence.counts, null);
  assert.equal(presence.lobbies, null);
  assert.equal(presence.timer, null);
});
