import test from 'node:test';
import assert from 'node:assert/strict';
import {VirtualWinsock, WSA, WSAError, peerGonePacket} from '../web/runtime/winsock.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const wsa = code => error => error instanceof WSAError && error.code === code;

// A relay room: frames go to one peer or to every other peer (destination 0).
// A peer whose game crashed (`gameOver`) receives nothing; its page still sends.
function room(count) {
  const transports = [];
  for (let peerId = 1; peerId <= count; peerId++) {
    const transport = new EventTarget();
    transport.peerId = peerId;
    transport.send = (destination, data, fromPage = false) => {
      if (transport.gameOver && !fromPage) return;
      for (const other of transports) {
        if (other !== transport && (destination === 0 || destination === other.peerId)) {
          setImmediate(() => { if (!other.gameOver) other.dispatchEvent(new CustomEvent('packet', {detail:{source:peerId, data:data.slice()}})); });
        }
      }
    };
    transports.push(transport);
  }
  return transports;
}

async function connected(host, guest) {
  const client = guest.socket('tcp');
  assert.throws(() => guest.connect(client, {address:host.address, port:6112}), wsa(WSA.EWOULDBLOCK));
  for (let i = 0; i < 4; i++) await tick();
  return client;
}

test('when a player\'s game is gone, only the streams with that player fail at once', async () => {
  const transports = room(4);
  const [host, first, second, third] = transports.map(transport => new VirtualWinsock(transport));
  const listener = host.socket('tcp');
  host.bind(listener, {port:6112}); host.listen(listener);
  const firstClient = await connected(host, first), secondClient = await connected(host, second);
  const accepted = [host.accept(listener), host.accept(listener)];
  const fromFirst = accepted.find(item => item.address === first.address).socket;
  const fromSecond = accepted.find(item => item.address === second.address).socket;
  // A third player is still connecting when the second's game ends.
  const late = third.socket('tcp');
  assert.throws(() => third.connect(late, {address:second.address, port:6112}), wsa(WSA.EWOULDBLOCK));

  // The second player's game crashes: it answers nothing more, and its page
  // announces it (client.mjs).
  transports[2].gameOver = true;
  transports[2].send(0, peerGonePacket(), true);
  for (let i = 0; i < 3; i++) await tick();
  assert.throws(() => host.recv(fromSecond, 16), wsa(WSA.ECONNRESET), 'the host stops waiting for the player');
  assert.deepEqual(host.select({read:[fromSecond, fromFirst]}).read, [fromSecond], 'a waiting read wakes up');
  assert.throws(() => third.send(late, new Uint8Array([1])), wsa(WSA.ECONNREFUSED));
  // Everyone else keeps playing.
  first.send(firstClient, new Uint8Array([7, 8]));
  await tick();
  assert.deepEqual([...host.recv(fromFirst, 2)], [7, 8]);
  host.send(fromFirst, new Uint8Array([9]));
  await tick();
  assert.deepEqual([...first.recv(firstClient, 1)], [9]);
  // The second player's own sockets are not touched by its announcement, and
  // a malformed announcement changes nothing.
  assert.equal(second.getError(secondClient), 0);
  const malformed = new Uint8Array(peerGonePacket().length + 1);
  malformed.set(peerGonePacket());
  new DataView(malformed.buffer).setUint16(10, 1, true);
  transports[1].send(0, malformed);
  for (let i = 0; i < 3; i++) await tick();
  assert.equal(host.getError(fromFirst), 0);
  for (const network of [host, first, second, third]) network.destroy();
});
