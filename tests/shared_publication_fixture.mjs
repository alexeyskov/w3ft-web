// Synthetic flag-release fixture built by test_build_runtime.py.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRuntime} from '../web/runtime/engine.mjs';

const root=process.argv[2];
for(const variant of ['standard','compat']){
  const profile=JSON.parse(await readFile(`${root}/build/build${variant==='compat'?'-compat':''}.json`));
  assert.equal(profile.optimizations.shared_publications,1);
  const engine=await createRuntime({wasm:await readFile(`${root}/build/${profile.artifact}`),profile,
    images:[{name:'fixture.dll',bytes:await readFile(`${root}/fixture.dll`)}]});
  const h=engine.host,x=engine.instance.exports,cpu=x.wc3_cpu_pointer(),lock=h.alloc(16);
  for(const waiting of [0,1,7]){
    h.w32(lock,0);h.w32(lock+4,waiting);h.w32(lock+8,0);h.w32(lock+12,0xf00d);
    h.view.setUint32(cpu+4,lock,true);h.view.setUint32(cpu+8,0x02001040,true);
    assert.equal(h.call(0x02001000),waiting);
    assert.equal(h.u32(lock),1,'publish the free lock');
    assert.equal(h.u32(lock+4),waiting,'do not consume or overwrite waiter state');
    assert.equal(h.u32(lock+8),waiting?1:0,'signal precisely when waiters are present');
    assert.equal(h.u32(lock+12),0xf00d,'preserve neighboring fields');
  }
  console.log(variant,'publication passed');
}
