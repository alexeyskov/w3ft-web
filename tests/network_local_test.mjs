import test from 'node:test';
import assert from 'node:assert/strict';
import {createOfflineNetwork} from '../web/runtime/network-local.mjs';
import {WSA,WSAError} from '../web/runtime/winsock.mjs';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const wsa=code=>error=>error instanceof WSAError&&error.code===code;

test('offline UDP and TCP loopback work without server frames; remote peers are unreachable',async()=>{
  const network=createOfflineNetwork();assert.equal(network.isOffline,true);assert.equal(network.address,'127.0.0.1');
  const udp=network.socket('udp');network.bind(udp,{address:'127.0.0.1',port:6112});
  network.sendto(udp,new Uint8Array([1,0,255]),{address:'127.0.0.1',port:6112});await tick();
  const received=network.recvfrom(udp,3);assert.deepEqual([...received.data],[1,0,255]);assert.equal(received.address,'127.0.0.1');
  assert.throws(()=>network.sendto(udp,new Uint8Array([1]),{address:'10.77.0.2',port:6112}),wsa(WSA.ENETUNREACH));
  const listener=network.socket('tcp');network.bind(listener,{port:6112});network.listen(listener);
  const client=network.socket('tcp');assert.throws(()=>network.connect(client,{address:'localhost',port:6112}),wsa(WSA.EWOULDBLOCK));await tick();
  const accepted=network.accept(listener);assert.equal(accepted.address,'127.0.0.1');assert.equal(network.getpeername(client).address,'127.0.0.1');
  network.send(client,new Uint8Array([8,9]));await tick();assert.deepEqual([...network.recv(accepted.socket,2)],[8,9]);
  network.destroy();
});

test('offline UDP broadcasts are restricted to its own adapter',async()=>{
  const first=createOfflineNetwork(),second=createOfflineNetwork();
  const a=first.socket('udp'),b=second.socket('udp');first.bind(a,{port:6112});second.bind(b,{port:6112});first.setsockopt(a,'SO_BROADCAST',true);
  first.sendto(a,new Uint8Array([7]),{address:'255.255.255.255',port:6112});await tick();
  assert.equal(first.recvfrom(a,1).data[0],7);assert.throws(()=>second.recvfrom(b,1),wsa(WSA.EWOULDBLOCK));first.destroy();second.destroy();
});
