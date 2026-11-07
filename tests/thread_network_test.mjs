import test from 'node:test';
import assert from 'node:assert/strict';
import {WarcraftHost} from '../web/runtime/host.mjs';
import {createOfflineNetwork} from '../web/runtime/network-local.mjs';

test('blocking Winsock select wakes on real packets and keeps errors per guest thread',async()=>{
  const network=createOfflineNetwork(),h=new WarcraftHost({memory:new WebAssembly.Memory({initial:8}),network});
  let next=0x10000;h.base=0;h.exports={wc3_guest_alloc:size=>{const p=next;next+=size;return p;}};
  h.registerContext(0x1000,1);h.registerContext(0x2000,2);h.currentCPU=0x1000;h.scheduler={};
  const call=(name,args=[])=>h.handlers.get('wsock32.dll!'+name).fn(args);
  const incoming=network.socket(2),sender=network.socket(2);network.bind(incoming,{address:'127.0.0.1',port:6000});
  const set=h.alloc(8),timeout=h.alloc(8);h.w32(set,1);h.w32(set+4,incoming);h.w32(timeout+4,100000);
  call('WSASetLastError',[123]);const pending=call('select',[0,set,0,0,timeout]);assert.ok(pending instanceof Promise);
  h.currentCPU=0x2000;call('WSASetLastError',[456]);
  network.sendto(sender,Uint8Array.of(1,2,3),{address:'127.0.0.1',port:6000});
  assert.equal(await pending,1);assert.equal(h.u32(set),1);assert.equal(h.u32(set+4),incoming);
  assert.equal(call('WSAGetLastError'),456);h.currentCPU=0x1000;assert.equal(call('WSAGetLastError'),123);
  assert.deepEqual([...network.recvfrom(incoming,3).data],[1,2,3]);
  h.w32(set,1);h.w32(set+4,incoming);h.w32(timeout+4,1000);
  assert.equal(await call('select',[0,set,0,0,timeout]),0);assert.equal(h.u32(set),0);
  network.destroy();h.cancelThreadWaits();
});

test('completion ports associate actual socket handles without aliasing ordinary kernel handles',()=>{
  const network=createOfflineNetwork(),h=new WarcraftHost({memory:new WebAssembly.Memory({initial:8}),network});h.base=0;
  const call=(name,...args)=>h.handlers.get('kernel32.dll!'+name).fn(args);
  const socket=network.socket(1),port=call('CreateIoCompletionPort',socket,0,0x12345678,0);
  assert.ok(port);assert.notEqual(socket,port);assert.equal(h.handles.has(socket),false);
  assert.equal(network.sockets.get(socket).port,h.handles.get(port));
  assert.equal(network.sockets.get(socket).completionKey,0x12345678);
  assert.equal(call('CreateIoCompletionPort',socket,port,0x12345678,0),port);
  assert.equal(call('CreateIoCompletionPort',socket,0,0,0),0);assert.equal(h.lastError,87);
  network.destroy();
});
