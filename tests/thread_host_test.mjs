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
