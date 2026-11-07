import test from 'node:test';
import assert from 'node:assert/strict';
import {WarcraftHost} from '../web/runtime/host.mjs';
import {localImportDispatcher} from '../web/runtime/worker-fast.mjs';
import {GuestThreadScheduler} from '../web/runtime/thread-scheduler.mjs';

test('local imports preserve cdecl/stdcall, memory bases, x87 state and exact shared counters',()=>{
  const memory=new WebAssembly.Memory({initial:8,maximum:8,shared:true}),h=new WarcraftHost({memory}),cpu=0x1000,esp=0x3000;
  h.base=0x4000;h.registerContext(cpu,9);
  h.exports={wc3_cpu_st_offset:()=>72,wc3_cpu_top_offset:()=>136};
  const names=[['MSVCR80.dll','toupper'],['MSVCR80.dll','memmove'],['MSVCR80.dll','_CIsqrt'],['kernel32.dll','InterlockedIncrement'],['kernel32.dll','GetCurrentThreadId'],['kernel32.dll','GetLastError'],['MSVCR80.dll','malloc']];
  const descriptors=names.map(([dll,name])=>{const {argc,convention}=h.handlers.get(dll.toLowerCase()+'!'+name);return {dll,name,argc,convention};});
  const counters=new SharedArrayBuffer(descriptors.length*4),dispatch=localImportDispatcher(h,{descriptors,counters},cpu);
  const call=(id,args)=>{h.view.setUint32(cpu+16,esp,true);h.w32(esp,0x123456);args.forEach((v,i)=>h.w32(esp+4+i*4,v));assert.equal(dispatch(id,cpu),true);return h.view.getUint32(cpu,true);};
  assert.equal(call(0,[97]),65);assert.equal(h.view.getUint32(cpu+16,true),esp+4);assert.equal(h.view.getUint32(cpu+32,true),0x123456);
  h.copyIn(0x5000,Uint8Array.of(1,2,3,4));assert.equal(call(1,[0x5001,0x5000,3]),0x5001);assert.deepEqual([...h.copyOut(0x5000,4)],[1,1,2,3]);
  h.view.setFloat64(cpu+72,81,true);call(2,[]);assert.equal(h.view.getFloat64(cpu+72,true),9);
  h.w32(0x6000,41);assert.equal(call(3,[0x6000]),42);assert.equal(h.u32(0x6000),42);assert.equal(h.view.getUint32(cpu+16,true),esp+8);
  assert.equal(call(4,[]),9);h.threadContexts.get(cpu).lastError=71;assert.equal(call(5,[]),71);assert.equal(dispatch(6,cpu),false);assert.equal(dispatch(1000,cpu),false);
  assert.throws(()=>dispatch(0,cpu+4),/does not belong/);
  assert.deepEqual([...new Uint32Array(counters)],[1,1,1,1,1,1,0]);
  const broker={calls:new Map([['MSVCR80.dll!toupper',2]])};
  const combined=GuestThreadScheduler.prototype.calls.call({host:broker,threads:new Map([[9,{localImports:{descriptors,counters}}]])});
  assert.equal(combined['MSVCR80.dll!toupper'],3);assert.equal(combined['kernel32.dll!GetCurrentThreadId'],1);
});
