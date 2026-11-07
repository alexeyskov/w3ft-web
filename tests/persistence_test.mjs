import test from 'node:test';
import assert from 'node:assert/strict';
import {FileOverlay,SaveWriter,saveSnapshot} from '../web/runtime/persistence.mjs';
import {WarcraftHost} from '../web/runtime/host.mjs';

test('real Win32 writes and deletions produce immutable save snapshots',()=>{
  const h=new WarcraftHost({memory:new WebAssembly.Memory({initial:8}),listFiles:()=>[]});
  h.base=0;let next=0x10000;h.exports={wc3_guest_alloc:n=>{const p=next;next+=n;return p;}};
  const call=(name,...args)=>h.handlers.get('kernel32.dll!'+name).fn(args);
  h.virtualFiles.set('save/old.w3z',Uint8Array.of(1));h.virtualFiles.checkpoint();
  const path=h.string('Save/live.w3z'),file=call('CreateFileA',path,0x40000000,3,0,2,0,0),data=h.alloc(8),count=h.alloc(4);
  h.copyIn(data,Uint8Array.of(10,20));call('WriteFile',file,data,1,count,0);
  assert.deepEqual(saveSnapshot(h),{files:[],deleted:[]},'Partial saves cannot replace a completed IndexedDB save');
  const stopped=saveSnapshot(h,{full:true});assert.deepEqual(stopped.deferred,['save/live.w3z']);assert.ok(!stopped.files.some(f=>f.path==='save/live.w3z'));
  call('WriteFile',file,data+1,1,count,0);call('CloseHandle',file);
  const first=saveSnapshot(h);assert.equal(first.files.length,1);assert.deepEqual(first.files[0],{path:'save/live.w3z',data:Uint8Array.of(10,20)});
  h.virtualFiles.get('save/live.w3z')[0]=99;assert.equal(first.files[0].data[0],10,'snapshot does not alias later file changes');
  call('DeleteFileA',h.string('save/old.w3z'));
  assert.deepEqual(h.virtualFiles.changes(),{files:[],deleted:['save/old.w3z']});
  assert.deepEqual([...h.virtualFiles.deleted],['save/old.w3z'],'final snapshot retains deletions already sent');
  h.virtualFiles.set('save/old.w3z',Uint8Array.of(3));assert.equal(h.virtualFiles.deleted.size,0);
});

test('save queue preserves ordering across asynchronous writes and retries after failure',async()=>{
  const files=new Map(),seen=[],errors=[];let release;
  const writer=new SaveWriter({async write(path,data){seen.push(path);if(path==='first')await new Promise(resolve=>release=resolve);if(path==='fail')throw Error('storage full');files.set(path,[...data]);},async remove(path){files.delete(path);}},error=>errors.push(error.message));
  const first=writer.enqueue({files:[{path:'first',data:Uint8Array.of(1)}]}),second=writer.enqueue({deleted:['first'],files:[{path:'second',data:Uint8Array.of(2)}]});
  await Promise.resolve();assert.deepEqual(seen,['first']);release();await Promise.all([first,second]);
  assert.deepEqual([...files],[['second',[2]]]);
  await writer.enqueue({files:[{path:'fail',data:Uint8Array.of(3)}]});assert.equal(writer.error.message,'storage full');assert.deepEqual(errors,['storage full']);
  await writer.enqueue({files:[{path:'second',data:Uint8Array.of(4)}],full:true});assert.equal(writer.error,null);assert.deepEqual(files.get('second'),[4]);
});

test('save adapters with transactions receive replacements and deletions as one batch',async()=>{
  const store=new FileOverlay();store.set('save/old',Uint8Array.of(1));store.checkpoint();store.delete('save/old');store.set('save/new',Uint8Array.of(2));
  let applied;await new SaveWriter({applyChanges:async changes=>{applied=changes;}}).enqueue(store.changes());
  assert.deepEqual(applied,{files:[{path:'save/new',data:Uint8Array.of(2)}],deleted:['save/old']});
});
