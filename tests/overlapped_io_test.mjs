import test from 'node:test';
import assert from 'node:assert/strict';
import {WarcraftHost} from '../web/runtime/host.mjs';

function fixture(){
  let cursor=0x10000;
  const h=new WarcraftHost({memory:new WebAssembly.Memory({initial:32})});h.base=0;h.scheduler={};
  h.exports={wc3_guest_alloc:n=>{const p=cursor;cursor+=n;return p;}};
  const call=(name,...args)=>h.handlers.get('kernel32.dll!'+name).fn(args);
  const file=call('CreateFileA',h.string('Save/Profile1/Campaigns.w3v'),0xc0000000,3,0,2,0x40000000,0);
  const port=call('CreateIoCompletionPort',file,0,0x12345678,0),event=call('CreateEventA',0,1,0,0);
  const ov=h.alloc(20),data=h.alloc(16),bytes=h.alloc(4),key=h.alloc(4),result=h.alloc(4);
  h.w32(ov+16,event);h.copyIn(data,Uint8Array.of(10,20,30,40));
  return {h,call,file,port,event,ov,data,bytes,key,result};
}

test('overlapped write updates the real file and wakes an IOCP waiter with its key and request',async()=>{
  const {h,call,file,port,event,ov,data,bytes,key,result}=fixture();
  assert.equal(event&3,0,'kernel handles reserve low tag bits');
  const pending=call('GetQueuedCompletionStatus',port,bytes,key,result,0xffffffff);
  assert.ok(pending instanceof Promise);
  h.w32(ov+8,2);
  assert.equal(call('WriteFile',file,data,3,0,ov),1);
  assert.equal(await pending,1);
  assert.deepEqual([...h.virtualFiles.get('save/profile1/campaigns.w3v')],[0,0,10,20,30]);
  assert.equal(h.u32(bytes),3);assert.equal(h.u32(key),0x12345678);assert.equal(h.u32(result),ov);
  assert.equal(h.u32(ov),0);assert.equal(h.u32(ov+4),3);
  assert.equal(call('SetFilePointer',file,0,0,1),0,'overlapped offset does not advance shared file position');
  assert.equal(call('GetOverlappedResult',file,ov,bytes,0),1);assert.equal(h.u32(bytes),3);
  assert.equal(call('WaitForSingleObject',event,0),0);assert.equal(call('WaitForSingleObject',file,0),0);
  assert.equal(call('GetQueuedCompletionStatus',port,bytes,key,result,0),0);assert.equal(h.lastError,258);assert.equal(h.u32(result),0);
});

test('IOCP status publishes on dequeue, while tagged events suppress only the completion packet',()=>{
  const {h,call,file,port,event,ov,data,bytes,key,result}=fixture();
  assert.equal(call('WriteFile',file,data,4,bytes,ov),1);
  assert.equal(h.u32(ov),0x103);assert.equal(call('GetOverlappedResult',file,ov,bytes,0),0);assert.equal(h.lastError,996);
  assert.equal(call('GetQueuedCompletionStatus',port,bytes,key,result,0),1);assert.equal(h.u32(ov),0);
  call('ResetEvent',event);h.w32(ov+16,event|1);h.w32(ov+8,1);
  assert.equal(call('ReadFile',file,data,8,bytes,ov),1);assert.equal(h.u32(bytes),3);
  assert.deepEqual([...h.copyOut(data,3)],[20,30,40]);assert.equal(call('WaitForSingleObject',event,0),0);
  assert.equal(call('GetOverlappedResult',file,ov,bytes,0),1);assert.equal(h.u32(bytes),3);
  assert.equal(call('GetQueuedCompletionStatus',port,bytes,key,result,0),0);
  h.w32(ov+8,100);
  assert.equal(call('ReadFile',file,data,1,bytes,ov),0);assert.equal(h.lastError,38);
  assert.equal(h.u32(ov),0xc0000011);assert.equal(call('GetOverlappedResult',file,ov,bytes,0),0);assert.equal(h.lastError,38);
});

test('overlapped append, zero writes and synchronous explicit offsets retain their distinct semantics',()=>{
  const {h,call,file,ov,data,bytes}=fixture();h.w32(ov+16,0);
  assert.equal(call('WriteFile',file,data,4,bytes,0),0);assert.equal(h.lastError,87);
  h.w32(ov+8,0xffffffff);h.w32(ov+12,0xffffffff);
  assert.equal(call('WriteFile',file,data,4,bytes,ov),1);
  assert.equal(call('WriteFile',file,data,2,bytes,ov),1);
  assert.deepEqual([...h.virtualFiles.get('save/profile1/campaigns.w3v')],[10,20,30,40,10,20]);
  h.w32(ov+8,100);h.w32(ov+12,0);
  assert.equal(call('WriteFile',file,data,0,bytes,ov),1);assert.equal(h.virtualFiles.get('save/profile1/campaigns.w3v').length,6);
  const sync=call('CreateFileA',h.string('sync.bin'),0xc0000000,3,0,2,0,0);
  h.w32(ov+8,3);assert.equal(call('WriteFile',sync,data,2,bytes,ov),1);
  assert.equal(call('SetFilePointer',sync,0,0,1),5);
  assert.deepEqual([...h.virtualFiles.get('sync.bin')],[0,0,0,10,20]);
});
