import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {WarcraftHost} from '../web/runtime/host.mjs';

const memory=new WebAssembly.Memory({initial:1024,maximum:65536,shared:true});
const host=new WarcraftHost({memory}),{instance}=await WebAssembly.instantiate(await readFile(process.argv[2]),host.imports()),x=instance.exports;
host.instance=instance;host.exports=x;x._initialize();
assert.equal(x.wc3_init(0x7fff0000),1);host.attach(instance);
const cpu=x.wc3_cpu_pointer(),base=x.wc3_memory_base(),stack=host.view.getUint32(cpu+16,true);
assert.ok(memory.buffer.byteLength<140*1048576,'startup commits only stack, images and used heap');
assert.throws(()=>x.fixture_read(0x30000000),WebAssembly.RuntimeError,'uncommitted addresses trap');
const native=x.malloc(1024);assert.ok(native&&native<base);host.bytes[native]=97;
assert.equal(x.malloc(64*1048576),0,'native allocator cannot grow into the guest window');
const first=x.wc3_guest_alloc(32*1048576);assert.ok(first);host.w32(first,0x12345678);
const last=x.wc3_guest_alloc(440*1048576);assert.ok(last&&last+440*1048576>0x20000000,'guest heap can grow beyond old 512MiB window');
assert.equal(host.u32(first),0x12345678);assert.equal(host.bytes[native],97,'native allocation survives guest growth');
const before=memory.buffer.byteLength;assert.equal(x.wc3_guest_alloc(0xffffffff),0);assert.equal(memory.buffer.byteLength,before);
x.free(native);const reused=x.malloc(1024);assert.ok(reused&&reused<base);x.free(reused);

function invoke(name,args=[],values=[]){
  const thunk=host.resolve('MSVCR80.dll',name),id=(thunk-0xf1000000)/16;
  host.view.setUint32(cpu+16,stack,true);host.w32(stack,0x123abc);args.forEach((v,i)=>host.w32(stack+4+i*4,v));
  const top=x.wc3_cpu_top_offset(),st=x.wc3_cpu_st_offset();host.view.setInt32(cpu+top,0,true);
  values.forEach((v,i)=>host.view.setFloat64(cpu+st+i*8,v,true));
  x.fixture_import(cpu,id);
  assert.equal(host.view.getUint32(cpu+32,true),0x123abc);assert.equal(host.view.getUint32(cpu+16,true),stack+4,'cdecl arguments stay on stack');
  const t=host.view.getInt32(cpu+top,true);
  return {integer:host.view.getUint32(cpu,true),float:host.view.getFloat64(cpu+st+t*8,true),top:t,id};
}
for(const [name,fn]of [['_CIsqrt',Math.sqrt],['_CIsin',Math.sin],['_CIcos',Math.cos],['_CIlog10',Math.log10],['_CIatan',Math.atan],['_CIexp',Math.exp],['_CItan',Math.tan],['_CIacos',Math.acos],['_CIasin',Math.asin]]){
  const result=invoke(name,[],[0.25]);assert.ok(Math.abs(result.float-fn(0.25))<1e-14);assert.equal(result.top,0);
}
assert.equal(invoke('_CIpow',[],[3,2]).float,8);
assert.equal(invoke('_CIatan2',[],[1,1]).top,1);
assert.equal(invoke('_CIfmod',[],[3,11]).float,2);
assert.ok(Object.is(invoke('_CIsqrt',[],[-0]).float,-0));
assert.ok(Number.isNaN(invoke('_CIacos',[],[2]).float));
const double=new DataView(new ArrayBuffer(8));double.setFloat64(0,-2.5,true);
assert.equal(invoke('floor',[double.getUint32(0,true),double.getUint32(4,true)]).float,-3);
const a=host.alloc(128),b=host.string('abc'),c=host.string('abd');
assert.equal(invoke('memcpy',[a,b,4]).integer,a);assert.equal(host.cstr(a),'abc');
invoke('memmove',[a+1,a,4]);assert.equal(host.cstr(a),'aabc');
invoke('memset',[a,65,3]);assert.equal(host.cstr(a),'AAAc');
assert.equal(invoke('memcmp',[b,c,3]).integer|0,-1);
assert.equal(invoke('strlen',[b]).integer,3);
assert.equal(invoke('strcmp',[b,c]).integer|0,-1);
assert.equal(invoke('strncmp',[b,c,2]).integer,0);
assert.equal(invoke('_stricmp',[b,host.string('ABC')]).integer,0);
const sort=host.alloc(48);[3,1,3,2,1,0].forEach((v,i)=>{host.w32(sort+i*8,v);host.w32(sort+i*8+4,i);});
invoke('qsort',[sort,6,8,0x100000]);
assert.deepEqual(Array.from({length:6},(_,i)=>host.u32(sort+i*8)),[0,1,1,2,3,3]);
assert.deepEqual(Array.from({length:6},(_,i)=>host.u32(sort+i*8+4)),[5,1,4,3,0,2],'stable equal keys');
assert.ok(host.calls.get('MSVCR80.dll!_CIsqrt')>=2,'native calls remain in diagnostics');
assert.equal(host.history.length,0,'pure native CRT never enters JS imports');
console.log('Native CRT and growing memory passed',memory.buffer.byteLength);
