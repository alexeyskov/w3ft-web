import test from 'node:test';
import assert from 'node:assert/strict';
import {WarcraftHost} from '../web/runtime/host.mjs';
import {createOfflineNetwork} from '../web/runtime/network-local.mjs';
import {WSA} from '../web/runtime/winsock.mjs';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t){
  const network=createOfflineNetwork(),h=new WarcraftHost({memory:new WebAssembly.Memory({initial:16}),network});
  let next=0x10000;h.base=0;h.exports={wc3_guest_alloc:size=>{const p=next;next+=size;return p;}};
  h.registerContext(0x1000,1);h.registerContext(0x2000,2);h.currentCPU=0x1000;h.scheduler={};
  t.after(()=>{h.scheduler.stopped=true;network.destroy();h.cancelThreadWaits();});
  const call=(dll,name,...args)=>{const handler=h.handlers.get(dll+'!'+name);assert.ok(handler,name);assert.equal(handler.argc,args.length);return handler.fn(args);};
  const ws=(name,...args)=>call('ws2_32.dll',name,...args),ms=(name,...args)=>call('mswsock.dll',name,...args),kernel=(name,...args)=>call('kernel32.dll',name,...args);
  const listener=network.socket('tcp');network.bind(listener,{port:6112});network.listen(listener,250);
  const target=network.socket('tcp'),client=network.socket('tcp'),port=kernel('CreateIoCompletionPort',listener,0,0xaabbccdd,0);
  const connect=async()=>{assert.throws(()=>network.connect(client,{address:'127.0.0.1',port:6112}),error=>error.code===WSA.EWOULDBLOCK);await tick();};
  const dequeue=async(timeout=0)=>{
    const output=h.alloc(12),success=await kernel('GetQueuedCompletionStatus',port,output,output+4,output+8,timeout);
    return {success,bytes:h.u32(output),key:h.u32(output+4),overlapped:h.u32(output+8)};
  };
  const buf=(...arrays)=>{
    const pointer=h.alloc(arrays.length*8),data=arrays.map(a=>{const p=h.alloc(a.length);h.copyIn(p,Uint8Array.from(a));return p;});
    arrays.forEach((a,i)=>{h.w32(pointer+i*8,a.length);h.w32(pointer+i*8+4,data[i]);});return {pointer,data,count:arrays.length};
  };
  return {h,network,ws,ms,kernel,listener,target,client,port,connect,dequeue,buf};
}

test('AcceptEx accepts into the supplied socket, reports addresses and wakes the listener IOCP',async t=>{
  const {h,network,ws,ms,kernel,listener,target,client,port,connect,dequeue}=fixture(t);
  const ov=h.alloc(20),output=h.alloc(64),count=h.alloc(4);h.w32(count,0xdeadbeef);
  assert.equal(ms('AcceptEx',listener,target,output,0,32,32,count,ov),0);assert.equal(ws('WSAGetLastError'),997);
  const completion=dequeue(1000);assert.equal(h.u32(ov),0x103);
  h.currentCPU=0x2000;ws('WSASetLastError',1234);await connect();
  assert.deepEqual(await completion,{success:1,bytes:0,key:0xaabbccdd,overlapped:ov});assert.equal(h.u32(count),0xdeadbeef);
  assert.equal(ws('WSAGetLastError'),1234);assert.equal(h.u32(ov),0);assert.equal(network.sockets.get(target).state,'connected');
  const pointers=h.alloc(16);ms('GetAcceptExSockaddrs',output,0,32,32,pointers,pointers+4,pointers+8,pointers+12);
  assert.equal(h.u32(pointers),output+16);assert.equal(h.u32(pointers+4),16);assert.equal(h.u32(pointers+8),output+48);
  assert.deepEqual([...h.copyOut(output+20,4)],[127,0,0,1]);assert.equal(h.u8(output+18)*256+h.u8(output+19),6112);
  assert.equal(kernel('CreateIoCompletionPort',target,port,42,0),port);
  h.w32(count,listener);assert.equal(ws('setsockopt',target,0xffff,0x700b,count,4),0);
  network.send(client,Uint8Array.of(7,8));await tick();assert.deepEqual([...network.recv(target,2)],[7,8]);
  assert.equal((await dequeue()).success,0,'One accept generates exactly one completion');
});

test('pending scatter receive captures WSABUF values without overwriting expired stack outputs',async t=>{
  const {h,network,ws,ms,kernel,listener,target,client,port,connect,dequeue,buf}=fixture(t);
  await connect();const accept=h.alloc(20),out=h.alloc(64);assert.equal(ms('AcceptEx',listener,target,out,0,32,32,0,accept),1);await dequeue();
  kernel('CreateIoCompletionPort',target,port,77,0);
  const receive=buf([0,0],[0,0,0,0]),ov=h.alloc(20),stack=h.alloc(8);h.w32(stack,0xabcdef);
  assert.equal(ws('WSARecv',target,receive.pointer,2,stack,stack+4,ov,0),-1);assert.equal(ws('WSAGetLastError'),997);
  h.zero(receive.pointer,16);h.w32(stack+4,0x12345678);
  network.send(client,Uint8Array.of(1,2,3,4,5));await tick();
  assert.deepEqual(await dequeue(),{success:1,bytes:5,key:77,overlapped:ov});
  assert.deepEqual([...h.copyOut(receive.data[0],2),...h.copyOut(receive.data[1],4)],[1,2,3,4,5,0]);
  assert.equal(h.u32(stack),0xabcdef);assert.equal(h.u32(stack+4),0x12345678);
  const send=buf([10,11],[12,13]),sendOv=h.alloc(20);assert.equal(ws('WSASend',target,send.pointer,2,stack,0,sendOv,0),0);
  assert.equal(h.u32(stack),4);assert.deepEqual(await dequeue(),{success:1,bytes:4,key:77,overlapped:sendOv});await tick();assert.deepEqual([...network.recv(client,4)],[10,11,12,13]);
  const next=buf([0]),eof=h.alloc(20);h.w32(stack+4,0);assert.equal(ws('WSARecv',target,next.pointer,1,0,stack+4,eof,0),-1);
  network.shutdown(client,1);await tick();assert.deepEqual(await dequeue(),{success:1,bytes:0,key:77,overlapped:eof});
});

test('AcceptEx waits for initial data, and event low bit suppresses IOCP delivery',async t=>{
  const {h,network,ws,ms,kernel,listener,target,client,connect,dequeue}=fixture(t);
  const ov=h.alloc(20),output=h.alloc(80),count=h.alloc(4),flags=h.alloc(4),event=kernel('CreateEventA',0,1,1,0);
  h.w32(ov+16,event|1);assert.equal(ms('AcceptEx',listener,target,output,16,32,32,0,ov),0);
  assert.equal(kernel('WaitForSingleObject',event,0),258);await connect();assert.equal(h.u32(ov),0x103);
  network.send(client,Uint8Array.of(21,22,23));await tick();
  assert.equal(kernel('WaitForSingleObject',event,0),0);assert.equal(ws('WSAGetOverlappedResult',target,ov,count,0,flags),1);
  assert.equal(h.u32(count),3);assert.deepEqual([...h.copyOut(output,3)],[21,22,23]);assert.equal((await dequeue()).success,0);
});

test('closing an accept socket cancels exactly once on its listener completion port',async t=>{
  const {h,network,ws,ms,listener,target,dequeue}=fixture(t);
  const ov=h.alloc(20);assert.equal(ms('AcceptEx',listener,target,h.alloc(64),0,32,32,0,ov),0);
  const result=dequeue(1000);network.close(target);await tick();
  assert.deepEqual(await result,{success:0,bytes:0,key:0xaabbccdd,overlapped:ov});assert.equal(h.lastError,995);assert.equal(h.u32(ov),0xc0000120);
  assert.equal((await dequeue()).success,0);assert.equal(ws('WSAGetLastError'),997,'Completion does not replace the initiating thread error');
});

test('WSAIoctl resolves real extension thunks and supports the Warcraft UDP reset request',t=>{
  const {h,network,ws,listener}=fixture(t),guid=h.alloc(16),out=h.alloc(4),count=h.alloc(4);
  h.copyIn(guid,Uint8Array.from(Buffer.from('f17d36b5accbcf1195ca00805f48a192','hex')));
  assert.equal(ws('WSAIoctl',listener,0xc8000006,guid,16,out,4,count,0,0),0);assert.equal(h.u32(count),4);
  assert.equal(h.u32(out),h.resolve('mswsock.dll','AcceptEx',0));
  const udp=network.socket('udp');h.w32(out,0);assert.equal(ws('WSAIoctl',udp,0x9800000c,out,4,0,0,count,0,0),0);
  assert.equal(ws('WSAIoctl',udp,0xdeadbeef,0,0,0,0,count,0,0),-1);assert.equal(ws('WSAGetLastError'),WSA.EOPNOTSUPP);
});

test('a pending WSASend resumes after transport backpressure clears',async t=>{
  const {h,network,ws,ms,kernel,listener,target,client,port,connect,dequeue,buf}=fixture(t);
  await connect();assert.equal(ms('AcceptEx',listener,target,h.alloc(64),0,32,32,0,h.alloc(20)),1);await dequeue();
  kernel('CreateIoCompletionPort',target,port,81,0);network.transport.socket={bufferedAmount:5*1024*1024};
  const data=buf([0,255,8],[65,66]),ov=h.alloc(20),stack=h.alloc(4);h.w32(stack,0x12345678);
  assert.equal(ws('WSASend',target,data.pointer,2,stack,0,ov,0),-1);assert.equal(ws('WSAGetLastError'),997);
  h.zero(data.pointer,16);const pending=dequeue(1000);network.transport.socket.bufferedAmount=0;
  assert.deepEqual(await pending,{success:1,bytes:5,key:81,overlapped:ov});await tick();
  assert.deepEqual([...network.recv(client,5)],[0,255,8,65,66]);assert.equal(h.u32(stack),0x12345678);
});

test('relay disconnect completes pending AcceptEx with a network error',async t=>{
  const {h,network,ms,listener,target,dequeue}=fixture(t),ov=h.alloc(20);
  assert.equal(ms('AcceptEx',listener,target,h.alloc(64),0,32,32,0,ov),0);
  const pending=dequeue(1000);network.transport.dispatchEvent(new Event('disconnect'));
  assert.deepEqual(await pending,{success:0,bytes:0,key:0xaabbccdd,overlapped:ov});assert.equal(h.lastError,WSA.ENETDOWN);
});
