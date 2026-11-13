import test from 'node:test';
import assert from 'node:assert/strict';
import {WarcraftHost,GuestFault} from '../web/runtime/host.mjs';
import {WorkerVideo} from '../web/runtime/video-bridge.mjs';

function fixture(service=null){
  let cursor=0x10000,position=0,notify;
  const requests=[];
  const video=service||{
    create(listener){notify=listener;return 1;},
    load(id,path){requests.push({id,method:'load',path});return {width:800,height:368,duration:12,frameRate:24};},
    request(id,method,fields={}){requests.push({id,method,...fields});if(method==='seek')position=fields.position;return {position};},
    release(id){requests.push({id,method:'destroy'});},
  };
  const h=new WarcraftHost({memory:new WebAssembly.Memory({initial:64}),video});
  h.base=0;h.exports={wc3_guest_alloc(size){const p=cursor;cursor+=size;return p;}};
  const guid=value=>{
    const parts=value.split('-'),p=h.alloc(16);h.w32(p,parseInt(parts[0],16));h.w16(p+4,parseInt(parts[1],16));h.w16(p+6,parseInt(parts[2],16));
    const tail=parts.slice(3).join('');for(let i=0;i<8;i++)h.w8(p+8+i,parseInt(tail.slice(i*2,i*2+2),16));return p;
  };
  const wide=value=>{const p=h.alloc((value.length+1)*2);for(let i=0;i<value.length;i++)h.w16(p+2*i,value.charCodeAt(i));return p;};
  const call=(pointer,index,...args)=>{
    const thunk=h.u32(h.u32(pointer)+4*index),id=(thunk-0xf1000000)/16;
    assert.equal(h.thunks[id].argc,args.length+1,'COM stdcall argument count includes this');
    const cpu=128,esp=0x8000;
    h.w32(cpu+16,esp);h.w32(esp,0x401234);[pointer,...args].forEach((v,i)=>h.w32(esp+4+i*4,v));
    h.invoke(id,cpu);
    assert.equal(h.u32(cpu+16),esp+4+4*(args.length+1));assert.equal(h.u32(cpu+32),0x401234);
    return h.u32(cpu);
  };
  const output=h.alloc(16),iid=part=>guid(`56a868${part}-0ad4-11ce-b03a-0020af0ba770`);
  assert.equal(h.handlers.get('ole32.dll!CoInitializeEx').fn([0,0]),0);
  const create=h.handlers.get('ole32.dll!CoCreateInstance').fn;
  assert.equal(create([guid('e436ebb3-524f-11ce-9f53-0020af0ba770'),0,1,iid('a9'),output]),0);
  const graph=h.u32(output);
  const query=part=>{assert.equal(call(graph,0,iid(part),output),0);return h.u32(output);};
  return {h,call,graph,query,wide,guid,output,requests,video,ended:()=>notify('ended')};
}

test('DirectShow COM ABI loads real media metadata, forwards playback and returns double positions',()=>{
  const {h,graph,call,query,wide,output,requests,guid}=fixture();
  const control=query('b1'),position=query('b2'),basic=query('b5');
  assert.equal(call(control,7),0x80040227,'Run requires rendered media');
  assert.equal(call(graph,13,wide('Movies\\IntroX.mpq'),0),0);
  assert.equal(requests[0].path,'Movies\\IntroX.mpq');
  assert.equal(call(basic,10,output),0);assert.equal(h.u32(output),800);
  assert.equal(call(basic,7,output),0);assert.equal(h.view.getFloat64(output,true),1/24);
  assert.equal(call(control,7),0);assert.equal(requests.at(-1).method,'play');
  assert.equal(call(control,10,0,output),0);assert.equal(h.u32(output),2);
  const bits=new DataView(new ArrayBuffer(8));bits.setFloat64(0,3.25,true);
  assert.equal(call(position,8,bits.getUint32(0,true),bits.getUint32(4,true)),0);
  assert.equal(call(position,9,output),0);assert.equal(h.view.getFloat64(output,true),3.25);
  assert.equal(call(control,8),0);assert.equal(requests.at(-1).method,'pause');
  assert.equal(call(control,10,0,output),0);assert.equal(h.u32(output),1);
  assert.equal(call(control,9),0);assert.equal(requests.at(-1).method,'stop');
  assert.equal(call(position,0,guid('00000000-0000-0000-c000-000000000046'),output),0);
  assert.equal(h.u32(output),graph,'IUnknown identity is canonical across interfaces');
  assert.equal(call(graph,2),4);
  assert.equal(call(position,0,guid('ffffffff-ffff-ffff-ffff-ffffffffffff'),output),0x80004002);assert.equal(h.u32(output),0);
  for(const ptr of [basic,position,control])call(ptr,2);
  assert.equal(call(graph,2),0);assert.equal(requests.at(-1).method,'destroy');
});

test('DirectShow completion signals its event and posts the guest notification exactly once',()=>{
  const {h,graph,call,query,wide,output,ended}=fixture();
  const events=query('c0'),window=h.handle({kind:'window',threadId:1});
  assert.equal(call(graph,13,wide('Movies\\IntroX.mpq'),0),0);
  assert.equal(call(events,13,window,0x8001,123),0);
  assert.equal(call(events,7,output),0);const handle=h.u32(output);
  assert.equal(h.handles.get(handle).signal,false);
  assert.equal(call(events,8,output,output+4,output+8,0),0x80004004);
  ended();assert.equal(h.handles.get(handle).signal,true);
  assert.equal(h.events.length,1);assert.equal(h.events[0].message,0x8001);assert.equal(h.events[0].lParam,123);
  assert.equal(call(events,8,output,output+4,output+8,0),0);assert.equal(h.u32(output),1);
  assert.equal(h.handles.get(handle).signal,false);
  assert.equal(call(events,8,output,output+4,output+8,0),0x80004004);
  call(events,2);call(graph,2);assert.equal(h.handles.has(handle),false);
});

test('A real video RPC timeout skips the cinematic and release does not wait again',async()=>{
  const messages=[],video=new WorkerVideo({timeout:10,post:message=>messages.push(message),movies:new Map([
    ['movies/introx.mpq',{downloadUrl:'/api/assets/intro.webm',frameRate:'24/1'}],
  ])});
  const {h,graph,call,query,wide,output}=fixture(video),control=query('b1'),events=query('c0');
  assert.equal(call(graph,13,wide('Movies\\IntroX.mpq'),0),0,'A missing reply must not abort RenderFile');
  assert.equal(Atomics.load(new Int32Array(messages[0].control),0),-2);
  assert.equal(call(control,7),0);assert.equal(call(control,7),0);
  await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(call(events,8,output,output+4,output+8,0),0);
  assert.equal(h.u32(output),1,'The game receives EC_COMPLETE, like a skipped movie');
  assert.equal(call(events,8,output,output+4,output+8,0),0x80004004,'Completion is not duplicated');
  call(events,2);call(control,2);assert.equal(call(graph,2),0);
  assert.equal(messages.at(-1).method,'destroy');
  assert.equal(Atomics.load(new Int32Array(messages.at(-1).control),0),0,'Failed-load cleanup was sent without another blocking wait');
  assert.equal(video.listeners.size,0);
});

test('Stopping or releasing a failed movie cancels deferred completion',async()=>{
  for(const action of ['stop','release']){
    const {graph,call,query,wide,output,video}=fixture(),control=query('b1'),events=query('c0');
    video.load=()=>{throw new GuestFault('Video load: cannot decode',{videoOperation:'load',reason:'media'});};
    assert.equal(call(graph,13,wide('Movies\\IntroX.mpq'),0),0);
    assert.equal(call(events,7,output),0);
    call(control,7);
    if(action==='stop')call(control,9);
    else{call(events,2);call(control,2);call(graph,2);}
    await new Promise(resolve=>setTimeout(resolve,5));
    if(action==='stop')assert.equal(call(events,8,output,output+4,output+8,0),0x80004004);
  }
});

test('Missing media and malformed bridge replies remain actionable errors',()=>{
  const {graph,call,wide,video}=fixture();
  for(const message of ['Browser cinematic is missing; run tools/prepare_media.py','Invalid video response']){
    video.load=()=>{throw new GuestFault(message);};
    assert.throws(()=>call(graph,13,wide('Movies\\IntroX.mpq'),0),error=>error.message===message);
  }
});

test('startup intro completes without any media RPC; the same movie remains playable after the menu',async()=>{
  const messages=[],video=new WorkerVideo({skipIntro:true,post:m=>messages.push(m)});
  const {h,graph,call,query,wide,output}=fixture(video),control=query('b1'),events=query('c0');
  call(graph,13,wide('Movies\\TutorialIn.mpq'),0);call(control,7);
  await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(call(events,8,output,output+4,output+8,0),0);assert.equal(h.u32(output),1);
  call(events,2);call(control,2);call(graph,2);
  assert.equal(messages.length,0,'no load/configure/destroy request for the omitted intro');
  video.skipIntro=false;
  assert.throws(()=>video.load(2,'Movies\\TutorialIn.mpq'),/cinematic is missing/,'campaign/tutorial is not silently skipped');
  video.movies.set('movies/tutorialin.mpq',{downloadUrl:'/api/assets/tutorial',frameRate:'25/1'});
  video.request=(id,method)=>{messages.push(method);return {duration:2,width:640,height:480};};
  assert.equal(video.load(2,'Movies\\TutorialIn.mpq').duration,2);assert.deepEqual(messages,['load']);
});
