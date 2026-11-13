import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {WarcraftHost} from '../web/runtime/host.mjs';

const memory=new WebAssembly.Memory({initial:1024,maximum:65536,shared:true});
const host=new WarcraftHost({memory}),{instance}=await WebAssembly.instantiate(await readFile(process.argv[2]),host.imports()),x=instance.exports;
host.instance=instance;host.exports=x;x._initialize();
assert.equal(x.wc3_init(0x7fff0000),1);host.attach(instance);
const cpu=x.wc3_cpu_pointer(),stack=host.view.getUint32(cpu+16,true),count=32768,width=8;
const data=host.alloc(count*width),thunk=host.resolve('MSVCR80.dll','qsort'),id=(thunk-0xf1000000)/16;
const reserve=x.malloc(384*1024);assert.ok(reserve);
const held=[];
for(const size of [1024*1024,65536,4096]){
  for(let n=0;n<256;n++){
    const pointer=x.malloc(size);if(!pointer)break;
    held.push(pointer);assert.ok(n<255,'bounded native arena exhaustion');
  }
}
// There is room for the first 256 KiB temporary but not the second. The
// partial allocation must be freed, leaving room for host.call's arguments.
x.free(reserve);
const probe=x.malloc(count*width);assert.ok(probe);
assert.equal(x.malloc(count*width),0);x.free(probe);
for(let i=0;i<count;i++){host.w32(data+i*width,(count-1-i)%17);host.w32(data+i*width+4,i);}
host.w32(stack,0x123abc);
[data,count,width,0x100000].forEach((value,i)=>host.w32(stack+4+i*4,value));
const before=new Uint8Array(memory.buffer,cpu,x.wc3_cpu_size()).slice();
const original=host.thunks[id].fn;
let fallbackCalls=0;
host.thunks[id].fn=(...args)=>{
  fallbackCalls++;
  assert.deepEqual(new Uint8Array(memory.buffer,cpu,x.wc3_cpu_size()),before,
    'failed native attempt must not change the guest CPU');
  for(let i=0;i<count;i++)assert.equal(host.u32(data+i*width+4),i,
    'failed native attempt must not invoke comparisons or rearrange data');
  return original(...args);
};
try{
  x.fixture_import(cpu,id);
  assert.equal(fallbackCalls,1);
  assert.equal(host.view.getUint32(cpu+16,true),stack+4,'cdecl arguments stay on stack');
  assert.equal(host.view.getUint32(cpu+32,true),0x123abc);
  assert.equal(host.calls.get('MSVCR80.dll!qsort'),1,'fallback is counted exactly once');
  assert.equal(Atomics.load(new Uint32Array(memory.buffer,x.wc3_native_counts_pointer(),65536),id),0);
  let key=-1,prior=-1;
  for(let i=0;i<count;i++){
    const next=host.u32(data+i*width),ordinal=host.u32(data+i*width+4);
    assert.ok(next>=key);assert.ok(next!==key||ordinal>prior,'equal keys remain stable');
    key=next;prior=ordinal;
  }
  const recovered=x.malloc(count*width);assert.ok(recovered,'partial native scratch is freed');x.free(recovered);
}finally{for(const pointer of held)x.free(pointer);}
console.log('Native qsort arena exhaustion fallback passed');
