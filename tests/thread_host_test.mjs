import test from 'node:test';
import assert from 'node:assert/strict';
import {WarcraftHost,GuestFault} from '../web/runtime/host.mjs';

test('pending guest imports preserve per-thread registers, TLS and last-error state',async()=>{
  const h=new WarcraftHost({memory:new WebAssembly.Memory({initial:4,maximum:4,shared:true})});
  h.base=0;h.registerContext(0x1000,1);h.registerContext(0x2000,2);
  for(const[cpu,esp,ret]of[[0x1000,0x10000,0x401000],[0x2000,0x20000,0x402000]]){
    h.view.setUint32(cpu+16,esp,true);h.w32(esp,ret);h.w32(esp+4,cpu);
  }
  let resume;
  h.add('test.dll','wait',1,()=>{
    const context=h.threadContext;assert.equal(h.threadId,1);h.lastError=7;h.tls.set(0,111);
    return new Promise(resolve=>{resume=()=>{context.lastError=9;resolve(17);};});
  });
  h.add('test.dll','signal',1,()=>{
    assert.equal(h.threadId,2);assert.equal(h.lastError,0);assert.equal(h.tls.has(0),false);
    h.lastError=8;h.tls.set(0,222);resume();return 18;
  });
  const id=name=>(h.resolve('test.dll',name)-0xf1000000)/16;
  const pending=h.invokeAsync(id('wait'),0x1000);
  await h.invokeAsync(id('signal'),0x2000);await pending;
  assert.equal(h.view.getUint32(0x1000,true),17);assert.equal(h.view.getUint32(0x2000,true),18);
  assert.equal(h.view.getUint32(0x1000+16,true),0x10008);assert.equal(h.view.getUint32(0x2000+16,true),0x20008);
  assert.equal(h.threadContexts.get(0x1000).lastError,9);assert.equal(h.threadContexts.get(0x2000).lastError,8);
  assert.equal(h.threadContexts.get(0x1000).tls.get(0),111);assert.equal(h.threadContexts.get(0x2000).tls.get(0),222);
});

test('synchronous guest callbacks reject blocking imports instead of returning false success',()=>{
  const h=new WarcraftHost({memory:new WebAssembly.Memory({initial:4})});h.base=0;
  h.view.setUint32(0x1010,0x10000,true);h.w32(0x10000,0x401000);
  h.add('test.dll','blocking',0,()=>Promise.resolve(0));
  assert.throws(()=>h.invoke((h.resolve('test.dll','blocking')-0xf1000000)/16,0x1000),GuestFault);
  assert.equal(h.view.getUint32(0x1010,true),0x10000);
});

test('import views refresh at boundaries and on newly grown shared ranges',()=>{
  const memory=new WebAssembly.Memory({initial:4,maximum:8,shared:true});let reads=0;
  const h=new WarcraftHost({memory:{get buffer(){reads++;return memory.buffer;}}});h.base=0;
  const cpu=0x1000,stack=0x10000;h.view.setUint32(cpu+16,stack,true);h.w32(stack,0x401000);
  h.add('test.dll','grow',0,()=>{
    const before=reads;
    for(let i=0;i<100;i++){h.view.setUint32(0x8000,i,true);h.bytes[0x9000]=i;}
    assert.equal(reads,before,'no memory.buffer getter per accessor inside an import');
    const old=memory.buffer.byteLength;memory.grow(1);
    h.w32(old,123);assert.equal(h.u32(old),123,'check refreshes newly committed ranges');
    return 7;
  });
  h.invoke((h.resolve('test.dll','grow')-0xf1000000)/16,cpu);
  assert.equal(h.view.getUint32(cpu,true),7);assert.equal(h._viewDepth,0);
  memory.grow(1);assert.equal(h.bytes.length,memory.buffer.byteLength,'external readers refresh');
  const calls=h.calls;assert.equal(calls.get('test.dll!grow'),1);
  assert.deepEqual(h.history,[{name:'test.dll!grow',threadId:1,returnAddress:0x401000}]);
  h.add('test.dll','fail',0,()=>{throw new Error('expected');});
  h.view.setUint32(cpu+16,stack,true);
  assert.throws(()=>h.invoke((h.resolve('test.dll','fail')-0xf1000000)/16,cpu),/expected/);
  assert.equal(h._viewDepth,0,'exceptions do not leave cached-import scope active');
});

test('unshared test runtimes refresh detached buffers during an import',()=>{
  const memory=new WebAssembly.Memory({initial:4,maximum:8});
  const h=new WarcraftHost({memory});h.base=0;
  h.view.setUint32(0x1010,0x10000,true);h.w32(0x10000,0x401000);
  h.add('test.dll','grow',0,()=>{memory.grow(1);h.view.setUint32(0x8000,123,true);return 9;});
  h.invoke((h.resolve('test.dll','grow')-0xf1000000)/16,0x1000);
  assert.equal(h.u32(0x8000),123);assert.equal(h.view.getUint32(0x1000,true),9);
});
