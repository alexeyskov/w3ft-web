import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import test from 'node:test';

async function load(path) {
  const memory = new WebAssembly.Memory({initial:128,maximum:4096,shared:true});
  let x, reenter = 0, hostCalls = 0;
  const regs = cpu => new Uint32Array(memory.buffer, cpu, 9);
  const guest = () => new Uint32Array(memory.buffer, x.wc3_memory_base());
  const word = a => guest()[a >>> 2], put = (a, v) => {guest()[a >>> 2] = v;};
  const string = p => {const b = new Uint8Array(memory.buffer); let e = p; while(b[e]) e++; return new TextDecoder().decode(b.subarray(p,e));};
  const imports = {env:{memory},wc3:{
    wc3_host_resolve:()=>0,wc3_host_log:()=>{},wc3_host_now:()=>performance.now(),
    wc3_host_fault:(_a,p)=>{throw Error(string(p));},
    wc3_host_call:(id,cpu)=>{
      assert.equal(id,2); hostCalls++;
      const r = regs(cpu), pointer = r[1];
      put(0x200000, Math.imul(word(0x200000),33) + word(pointer+12));
      if (reenter) {
        const root = reenter; reenter = 0;
        // A host callback can re-enter this same guest function while its
        // first native activation has suspended virtual recursion.
        const saved = [...r]; x.fixture_call(cpu,root,0x401020);
        r.set(saved);
      }
      r[8] = word(r[4]); r[4] += 8;
    }},wasi_snapshot_preview1:{
      sched_yield:()=>0,proc_exit:c=>{throw Error('exit '+c);},fd_close:()=>0,fd_seek:()=>8,fd_write:()=>8,
      clock_time_get:(_id,_precision,p)=>{new DataView(memory.buffer).setBigUint64(p,BigInt(Date.now())*1000000n,true);return 0;}}};
  x = (await WebAssembly.instantiate(readFileSync(path),imports)).instance.exports;
  x._initialize(); assert.equal(x.wc3_init(0x4000000),1); x.wc3_set_budget(0);
  const cpu=x.wc3_cpu_pointer();
  return {x,cpu,regs:()=>regs(cpu),word,put,reenter:root=>{reenter=root;},hostCalls:()=>hostCalls};
}

function tree(m, depth) {
  const nodes=[], base=0x100000, leaf=0x1f0000;
  m.put(leaf,0x402000);m.put(leaf+12,77);
  for(let i=0;i<depth;i++){
    const p=base+i*16,next=i+1<depth?p+16:0;
    const left=i%2?leaf:next,right=i%2?next:leaf,value=i+1;
    nodes.push({p,left,right,value});
    [0x401000,left,right,value].forEach((v,j)=>m.put(p+j*4,v));
  }
  return {root:depth?base:0,nodes,leaf};
}

function expected({root,nodes,leaf}, extra=0) {
  let hash=0; const work=root?[{p:root}]:[];
  const add=v=>{hash=(Math.imul(hash,33)+v)>>>0;};
  while(work.length){
    const {p,post}=work.pop();
    if(p===leaf){add(77);if(extra){add(extra);add(extra^0x55);extra=0;}continue;}
    const n=nodes[(p-0x100000)/16];
    if(post){add(n.value^0x55);continue;}
    add(n.value);work.push({p,post:true});
    if(n.right)work.push({p:n.right});if(n.left)work.push({p:n.left});
  }
  return hash;
}

function run(m,depth,reentrant=false) {
  const t=tree(m,depth),r=m.regs(),esp=r[4],native=m.x.__stack_pointer.value;
  const before=m.x.wc3_trace_count();
  m.put(0x200000,0);r[6]=0x123;r[7]=0x456;
  if(reentrant){
    const p=0x1e0000;[0x401000,0,0,999].forEach((v,j)=>m.put(p+j*4,v));m.reenter(p);
  }
  // The outer return deliberately equals an internal continuation. Depth,
  // not just return-address equality, must decide whether to leave the loop.
  m.x.fixture_call(m.cpu,t.root,0x401020);
  assert.equal(m.word(0x200000),expected(t,reentrant?999:0));
  assert.equal(r[4],esp);assert.equal(r[6],0x123);assert.equal(r[7],0x456);assert.equal(r[8],0x401020);
  assert.equal(m.x.__stack_pointer.value,native);
  assert.equal(m.x.wc3_trace_count()-before,depth?depth*3+(reentrant?1:0):1);
}

if(process.argv[2]){
  const dir=process.argv[2];
  const original=await load(join(dir,'original.wasm'));
  for(const depth of [0,1,2,31,100])run(original,depth);
  run(original,31,true);
  assert.throws(()=>run(original,30000),/call stack|recursion/i,'The original fixture reproduces the native stack limit');
  for(const variant of ['standard','compat']){
    const m=await load(join(dir,variant+'.wasm'));
    for(const depth of [0,1,2,31,100,30000])run(m,depth);
    run(m,30000,true);
    const esp=m.regs()[4],native=m.x.__stack_pointer.value;
    m.x.wc3_set_budget(50);
    assert.throws(()=>run(m,100),/Guest dispatch budget exhausted/);
    m.x.__stack_pointer.value=native;m.regs()[4]=esp;m.x.wc3_set_budget(0);
    run(m,31);
    console.log(variant+': 30000 recursive levels, both branches, host re-entry, stack balance and budget passed');
  }
}else{
  test('virtual self-call WASM fixture',{skip:'Run tests/test_runtime_self_calls.py to build all variants'},()=>{});
}
