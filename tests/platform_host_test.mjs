import test from 'node:test';
import assert from 'node:assert/strict';
import {installPlatform} from '../web/runtime/platform.mjs';
import {VirtualWinsock,WSA} from '../web/runtime/winsock.mjs';
import {decodePCM} from '../web/runtime/audio.mjs';
import {createOfflineNetwork} from '../web/runtime/network-local.mjs';
import {FixedFunctionGL,GL as GLenum,floatAttributes} from '../web/runtime/graphics.mjs';

class Host {
  constructor(options={}){Object.assign(this,options);this.base=0;this.memory={buffer:new ArrayBuffer(1024*1024)};this.handlers=new Map();this.handles=new Map();this.next=4096;this.nextHandle=1;this.callbackCalls=[];installPlatform(this);}
  get view(){return new DataView(this.memory.buffer);}
  check(p,n=1){if(!Number.isSafeInteger(p)||p<0||p+n>this.memory.buffer.byteLength)throw Error('memory bounds');return p;}
  u8(p){return this.view.getUint8(this.check(p));}u16(p){return this.view.getUint16(this.check(p,2),true);}u32(p){return this.view.getUint32(this.check(p,4),true);}i32(p){return this.view.getInt32(this.check(p,4),true);}
  w8(p,v){this.view.setUint8(this.check(p),v);}w16(p,v){this.view.setUint16(this.check(p,2),v,true);}w32(p,v){this.view.setUint32(this.check(p,4),v,true);}
  copyIn(p,b){new Uint8Array(this.memory.buffer).set(b,this.check(p,b.length));}copyOut(p,n){return new Uint8Array(this.memory.buffer).slice(this.check(p,n),p+n);}zero(p,n){new Uint8Array(this.memory.buffer).fill(0,this.check(p,n),p+n);}
  alloc(n){const p=this.next;this.next+=Math.ceil(n/16)*16;this.check(p,n);this.zero(p,n);return p;}free(){}
  string(s){const b=new TextEncoder().encode(s+'\0'),p=this.alloc(b.length);this.copyIn(p,b);return p;}
  cstr(p){let s='';while(this.u8(p))s+=String.fromCharCode(this.u8(p++));return s;}
  writeString(p,s,size){const data=new TextEncoder().encode(s);this.copyIn(p,data.subarray(0,size-1));this.w8(p+Math.min(size-1,data.length),0);}
  add(dll,name,argc,fn,convention='stdcall'){this.handlers.set(`${dll}!${name}`,{argc,fn,convention});}
  handle(value){const id=this.nextHandle++;this.handles.set(id,value);return id;}getHandle(id,kind){const v=this.handles.get(id);return v?.kind===kind?v:null;}
  resolve(dll,name){return this.handlers.has(`${dll}!${name}`)?0xf1000100:0;}
  call(address,args){this.callbackCalls.push({address,args});return 0;}
  invoke(dll,name,...args){const handler=this.handlers.get(`${dll}!${name}`);assert.ok(handler,`${dll}!${name} registered`);assert.equal(handler.argc,args.length);return handler.fn(args);}
}
const floatBits=value=>{const a=new DataView(new ArrayBuffer(4));a.setFloat32(0,value,true);return a.getUint32(0,true);};
const doubleBits=value=>{const a=new DataView(new ArrayBuffer(8));a.setFloat64(0,value,true);return[a.getUint32(0,true),a.getUint32(4,true)];};
const GL=0x1406;

test('OpenGL HLE converts IEEE stack words and double argument counts',()=>{
  const calls=[],h=new Host({graphics:{clearColor:(...a)=>calls.push(a),ortho:(...a)=>calls.push(a)}});
  h.invoke('opengl32.dll','glClearColor',...[.25,.5,.75,1].map(floatBits));assert.deepEqual(calls[0],[.25,.5,.75,1]);
  h.invoke('opengl32.dll','glOrtho',...[-1,2,-3,4,.1,100].flatMap(doubleBits));assert.deepEqual(calls[1],[-1,2,-3,4,.1,100]);
  assert.equal(h.handlers.get('opengl32.dll!glOrtho').argc,12);assert.equal(h.handlers.get('opengl32.dll!glOrtho').convention,'stdcall');
});

test('OpenGL fog HLE converts scalars/vectors, queries state and rejects invalid calls',()=>{
  const graphics=Object.create(FixedFunctionGL.prototype);
  graphics.gl={isContextLost:()=>false};graphics.fog={enabled:false,mode:GLenum.EXP,density:1,start:0,end:1,color:new Float32Array(4)};
  const h=new Host({graphics}),call=(name,...args)=>h.invoke('opengl32.dll',name,...args);
  call('glFogi',GLenum.FOG_MODE,GLenum.LINEAR);
  call('glFogf',GLenum.FOG_DENSITY,floatBits(.25));
  call('glFogi',GLenum.FOG_START,0xfffffffe);
  assert.equal(graphics.fog.start,-2);assert.equal(graphics.fog.density,.25);
  [1.5,-1,.5,.75].forEach((v,i)=>h.view.setFloat32(128+i*4,v,true));
  call('glFogfv',GLenum.FOG_COLOR,128);assert.deepEqual([...graphics.fog.color],[1,0,.5,.75]);
  call('glEnable',GLenum.FOG);assert.equal(call('glIsEnabled',GLenum.FOG),true);
  call('glGetFloatv',GLenum.FOG_COLOR,256);assert.deepEqual([0,1,2,3].map(i=>h.view.getFloat32(256+i*4,true)),[1,0,.5,.75]);
  call('glGetIntegerv',GLenum.FOG_COLOR,256);assert.equal(h.u32(256),0x7fffffff);assert.equal(h.u32(264),0x40000000);
  call('glGetBooleanv',GLenum.FOG,256);assert.equal(h.u8(256),1);
  call('glDisable',GLenum.FOG);assert.equal(call('glIsEnabled',GLenum.FOG),false);
  [0x7fffffff,0x80000000,0x7fffffff,0x80000000].forEach((v,i)=>h.w32(128+i*4,v));
  call('glFogiv',GLenum.FOG_COLOR,128);assert.deepEqual([...graphics.fog.color],[1,0,1,0]);
  assert.throws(()=>call('glFogi',GLenum.FOG_MODE,123),/unsupported value/);assert.equal(graphics.fog.mode,GLenum.LINEAR);
  assert.throws(()=>call('glFogf',GLenum.FOG_DENSITY,floatBits(-1)),/nonnegative/);assert.equal(graphics.fog.density,.25);
  assert.throws(()=>call('glFogf',GLenum.FOG_COLOR,floatBits(0)),/unsupported value/);
  assert.throws(()=>call('glFogfv',GLenum.FOG_COLOR,1024*1024-4),/memory bounds/);
  graphics.begin(GLenum.TRIANGLES);assert.throws(()=>call('glFogf',GLenum.FOG_END,floatBits(5)),/between begin\/end/);
});

test('OpenGL HLE reads strided positions, normalized UBYTE colors and indexed triangles',()=>{
  let drawn;const h=new Host({graphics:{drawElements:(...args)=>drawn=args}}),base=128;
  const positions=[[1,2,3],[4,5,6],[7,8,9]],colors=[[255,0,0,255],[0,255,0,128],[0,0,255,255]],uvs=[[0,0],[1,0],[1,1]];
  for(let i=0;i<3;i++){positions[i].forEach((v,c)=>h.view.setFloat32(base+i*24+c*4,v,true));h.copyIn(base+i*24+12,new Uint8Array(colors[i]));uvs[i].forEach((v,c)=>h.view.setFloat32(base+i*24+16+c*4,v,true));}
  h.invoke('opengl32.dll','glVertexPointer',3,GL,24,base);h.invoke('opengl32.dll','glColorPointer',4,0x1401,24,base+12);h.invoke('opengl32.dll','glTexCoordPointer',2,GL,24,base+16);
  for(const cap of [0x8074,0x8076,0x8078])h.invoke('opengl32.dll','glEnableClientState',cap);
  [2,0,1].forEach((v,i)=>h.w16(512+i*2,v));h.invoke('opengl32.dll','glDrawElements',4,3,0x1403,512);
  // Raw guest layouts reach the renderer unchanged; decode them as WebGL does.
  assert.equal(drawn[0],4);assert.deepEqual([...drawn[1]],[2,0,1]);assert.equal(drawn[3],3);
  const decoded=floatAttributes(drawn[2],drawn[3]);assert.equal(drawn[2].raw.position.bytes,drawn[2].raw.color.bytes,'interleaved arrays share one upload');
  assert.deepEqual([...decoded.positions],positions.flat());assert.deepEqual([...decoded.texcoords],uvs.flat());assert.ok(Math.abs(decoded.colors[7]-128/255)<1e-6);
});

test('OpenGL HLE checks guest bounds and reports actual renderer strings',()=>{
  const h=new Host({graphics:{gl:{VENDOR:1,RENDERER:2,getParameter:p=>p===1?'Test vendor':'Actual WebGL renderer'}}});
  const p=h.invoke('opengl32.dll','glGetString',0x1f01);assert.equal(h.cstr(p),'Actual WebGL renderer');assert.equal(h.invoke('opengl32.dll','glGetString',0x1f01),p);
  const unknown=h.string('glSomeUnsupportedExtension');assert.equal(h.invoke('opengl32.dll','wglGetProcAddress',unknown),0);
  const known=h.string('glDrawElements');assert.equal(h.invoke('opengl32.dll','wglGetProcAddress',known),0xf1000100);
  h.invoke('opengl32.dll','glVertexPointer',3,GL,0,1024*1024-4);h.invoke('opengl32.dll','glEnableClientState',0x8074);
  assert.throws(()=>h.invoke('opengl32.dll','glDrawArrays',4,0,3),/memory bounds/);
});
test('glReadPixels returns RGB, RGBA and the BGRA of Warcraft screenshots, keeping row padding',()=>{
  // A 3×2 frame; pixel i is [10+i, 20+i, 30+i, 40+i] in WebGL's RGBA.
  const reads=[],gl={PACK_ALIGNMENT:0x0d05,RGBA:0x1908,UNSIGNED_BYTE:0x1401,pixelStorei(){},
    readPixels:(x,y,width,height,format,type,target)=>{reads.push([x,y,width,height,format,type]);for(let i=0;i<width*height;i++)target.set([10+i,20+i,30+i,40+i],i*4);}};
  const h=new Host({graphics:{gl,_check(){}}}),read=(format,pointer)=>h.invoke('opengl32.dll','glReadPixels',0,0,3,2,format,0x1401,pointer);
  const pixels=(pointer,channels,stride)=>[0,1].map(row=>[...h.copyOut(pointer+row*stride,3*channels)]);
  read(GLenum.BGRA,4096);
  assert.deepEqual(pixels(4096,4,12),[[30,20,10,40,31,21,11,41,32,22,12,42],[33,23,13,43,34,24,14,44,35,25,15,45]]);
  read(GLenum.RGBA,8192);assert.deepEqual(pixels(8192,4,12)[1].slice(0,4),[13,23,33,43]);
  // Three-byte rows of 9 bytes are 12 apart at the default PACK_ALIGNMENT of 4.
  new Uint8Array(h.memory.buffer).fill(0xee,12288,12288+24);
  read(GLenum.BGR,12288);
  assert.deepEqual(pixels(12288,3,12),[[30,20,10,31,21,11,32,22,12],[33,23,13,34,24,14,35,25,15]]);
  assert.deepEqual([...h.copyOut(12288+9,3)],[0xee,0xee,0xee],'padding is not written');
  h.invoke('opengl32.dll','glPixelStorei',0x0d05,1);read(GLenum.RGB,16384);
  assert.deepEqual(pixels(16384,3,9)[1],[13,23,33,14,24,34,15,25,35]);
  assert.deepEqual(reads[0],[0,0,3,2,0x1908,0x1401]);
  assert.throws(()=>read(GLenum.LUMINANCE,20480),/BGRA unsigned bytes/);
  assert.throws(()=>h.invoke('opengl32.dll','glReadPixels',0,0,3,2,GLenum.BGRA,GLenum.FLOAT,20480),/BGRA unsigned bytes/);
  assert.throws(()=>read(GLenum.BGRA,1024*1024-8),/memory bounds/);
});
test('draw copies preserve guest base, first vertex and unaligned stride, rejecting inaccessible spans',()=>{
  let drawn;const h=new Host({graphics:{drawArrays:(...args)=>drawn=args}}),call=(name,...args)=>h.invoke('opengl32.dll',name,...args);
  const base=8192,rawCheck=h.check.bind(h);h.base=base;
  h.check=(p,n=1)=>rawCheck(base+p,n);
  for(let i=0;i<4;i++)for(let j=0;j<3;j++)h.view.setFloat32(base+129+i*15+j*4,10*i+j,true);
  call('glVertexPointer',3,GL,15,129);call('glEnableClientState',0x8074);
  call('glDrawArrays',4,1,3);assert.deepEqual([...floatAttributes(drawn[3],3).positions],[10,11,12,20,21,22,30,31,32]);
  const before=drawn;
  h.check=(p,n=1)=>{if(p<=165&&p+n>165)throw Error('reserved page');return rawCheck(base+p,n);};
  assert.throws(()=>call('glDrawArrays',4,1,3),/reserved page/);assert.equal(drawn,before);
});
test('multitexture client-array enables and pointers belong to their selected unit',()=>{
  let drawn;const h=new Host({graphics:{drawArrays:(...args)=>drawn=args}}),call=(name,...args)=>h.invoke('opengl32.dll',name,...args);
  [0,0,0,1,0,0,0,1,0].forEach((v,i)=>h.view.setFloat32(128+i*4,v,true));
  [.1,.2,.3,.4,.5,.6].forEach((v,i)=>h.view.setFloat32(256+i*4,v,true));
  [.6,.5,.4,.3,.2,.1].forEach((v,i)=>h.view.setFloat32(512+i*4,v,true));
  call('glVertexPointer',3,GL,0,128);call('glEnableClientState',0x8074);
  call('glTexCoordPointer',2,GL,0,256);call('glEnableClientState',0x8078);
  call('glClientActiveTextureARB',0x84c1);call('glTexCoordPointer',2,GL,0,512);call('glEnableClientState',0x8078);
  call('glDrawArrays',4,0,3);let decoded=floatAttributes(drawn[3],3);assert.equal(decoded.texcoords[0],Math.fround(.1));assert.equal(decoded.texcoords1[0],Math.fround(.6));
  call('glDisableClientState',0x8078);call('glDrawArrays',4,0,3);decoded=floatAttributes(drawn[3],3);
  assert.equal(decoded.texcoords[0],Math.fround(.1));assert.equal(decoded.texcoords1,undefined,'Disabling unit one preserves unit zero');
});
test('new texture vector APIs translate guest pointers through the memory base',()=>{
  const calls=[],h=new Host({graphics:{multiTexCoord:(...args)=>calls.push(args),texParameterfv:(...args)=>calls.push(args)}});
  const check=h.check.bind(h);h.check=(p,n=1)=>check(p+4096,n);
  [.25,.75].forEach((v,i)=>h.view.setFloat32(4096+128+i*4,v,true));
  h.invoke('opengl32.dll','glMultiTexCoord2fvARB',0x84c1,128);assert.deepEqual(calls[0],[0x84c1,.25,.75,0,1]);
  [1,.5,.25,0].forEach((v,i)=>h.view.setFloat32(4096+128+i*4,v,true));
  h.invoke('opengl32.dll','glTexParameterfv',0xde1,0x1004,128);assert.deepEqual(calls[1],[0xde1,0x1004,[1,.5,.25,0]]);
});

class Room {
  constructor(){this.peers=new Map();}
  peer(id){const p=new EventTarget();p.peerId=id;p.send=(destination,data)=>{for(const [otherId,other]of this.peers)if(otherId!==id&&(destination===0||destination===otherId))queueMicrotask(()=>{const e=new Event('packet');Object.defineProperty(e,'detail',{value:{source:id,data:data.slice()}});other.dispatchEvent(e);});};this.peers.set(id,p);return p;}
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function address(h,p,ip,port){h.zero(p,16);h.w16(p,2);h.w8(p+2,port>>>8);h.w8(p+3,port&255);ip.split('.').forEach((v,i)=>h.w8(p+4+i,+v));}
test('Winsock ordinal ABI round-trips UDP sockaddr/data and fd_set readiness',async()=>{
  const room=new Room(),a=new Host({network:new VirtualWinsock(room.peer(1))}),b=new Host({network:new VirtualWinsock(room.peer(2))});
  assert.equal(a.invoke('wsock32.dll','#115',0x101,128),0);assert.equal(a.u16(128),0x101);
  const af=a.invoke('wsock32.dll','#23',2,2,17),bf=b.invoke('wsock32.dll','#23',2,2,0);
  address(a,600,'0.0.0.0',6112);address(b,600,'0.0.0.0',6112);
  assert.equal(a.invoke('wsock32.dll','#2',af,600,16),0);assert.equal(b.invoke('wsock32.dll','#2',bf,600,16),0);
  address(a,600,'10.77.0.2',6112);a.copyIn(700,new Uint8Array([0,255,13]));assert.equal(a.invoke('wsock32.dll','#20',af,700,3,0,600,16),3);await tick();
  b.w32(800,1);b.w32(804,bf);b.zero(900,8);assert.equal(b.invoke('wsock32.dll','#18',0,800,0,0,900),1);assert.equal(b.u32(804),bf);
  b.w32(980,16);assert.equal(b.invoke('wsock32.dll','#17',bf,700,3,0,960,980),3);assert.deepEqual([...b.copyOut(700,3)],[0,255,13]);assert.deepEqual([...b.copyOut(960,8)],[2,0,23,224,10,77,0,1]);
  assert.equal(b.invoke('wsock32.dll','#16',bf,700,3,0),-1);assert.equal(b.invoke('wsock32.dll','#111'),WSA.EWOULDBLOCK);
  assert.equal(a.invoke('wsock32.dll','#9',6112),0xe017);const ip=a.invoke('wsock32.dll','#10',a.string('10.77.0.2'));assert.equal(ip,0x02004d0a);assert.equal(a.cstr(a.invoke('wsock32.dll','#11',ip)),'10.77.0.2');
  a.network.destroy();b.network.destroy();
});
test('Winsock TCP connect/accept, local hostent and explicit unsupported blocking mode',async()=>{
  const room=new Room(),a=new Host({network:new VirtualWinsock(room.peer(1))}),b=new Host({network:new VirtualWinsock(room.peer(2))});
  const client=a.invoke('wsock32.dll','#23',2,1,6),listener=b.invoke('wsock32.dll','#23',2,1,6);
  address(b,128,'0.0.0.0',6112);b.invoke('wsock32.dll','#2',listener,128,16);assert.equal(b.invoke('wsock32.dll','#13',listener,250),0);
  address(a,128,'10.77.0.2',6112);assert.equal(a.invoke('wsock32.dll','#4',client,128,16),-1);await tick();
  b.w32(240,16);const accepted=b.invoke('wsock32.dll','#1',listener,224,240);assert.ok(accepted>0);assert.deepEqual([...b.copyOut(228,4)],[10,77,0,1]);
  a.zero(256,4);assert.equal(a.invoke('wsock32.dll','#12',client,0x8004667e,256),-1);assert.equal(a.invoke('wsock32.dll','#111'),WSA.EOPNOTSUPP);
  assert.equal(a.invoke('wsock32.dll','#57',512,64),0);const entry=a.invoke('wsock32.dll','#52',512);assert.equal(a.u16(entry+8),2);assert.equal(a.u16(entry+10),4);assert.deepEqual([...a.copyOut(a.u32(a.u32(entry+12)),4)],[10,77,0,1]);
  a.network.destroy();b.network.destroy();
});

test('Winsock SO_REUSEADDR permits a second bind and remains queryable through the guest ABI',()=>{
  const h=new Host({network:createOfflineNetwork()}),call=(name,...args)=>h.invoke('wsock32.dll',name,...args);
  const first=call('socket',2,1,6),second=call('socket',2,1,6);address(h,128,'0.0.0.0',6112);
  assert.equal(call('bind',first,128,16),0);assert.equal(call('bind',second,128,16),-1);
  assert.equal(call('WSAGetLastError'),WSA.EADDRINUSE);
  h.w32(256,1);assert.equal(call('setsockopt',second,0xffff,4,256,4),0);
  h.w32(260,4);assert.equal(call('getsockopt',second,0xffff,4,264,260),0);assert.equal(h.u32(264),1);
  assert.equal(call('bind',second,128,16),0);call('closesocket',first);
  assert.equal(call('listen',second,250),0);h.network.destroy();
});

test('single-player Winsock startup and hostname resolve to loopback without relay',()=>{
  const h=new Host({network:createOfflineNetwork()});
  assert.equal(h.invoke('wsock32.dll','#115',0x101,128),0);
  assert.equal(h.invoke('wsock32.dll','#57',600,64),0);
  const entry=h.invoke('wsock32.dll','#52',600);
  assert.deepEqual([...h.copyOut(h.u32(h.u32(entry+12)),4)],[127,0,0,1]);
  assert.equal(h.invoke('wsock32.dll','#116'),0);h.network.destroy();
});

class Audio {
  constructor(){this.buffers=new Map();this.voices=new Map();this.next=1;}
  createBuffer(description){decodePCM(description);const id=this.next++;this.buffers.set(id,description);return id;}
  play(buffer,options){const id=this.next++;this.voices.set(id,{buffer,...options,position:options.offset||0,state:'playing'});return id;}
  getPosition(id){return this.voices.get(id).position;}getState(id){return this.voices.get(id).state;}
  pause(id){this.voices.get(id).state='paused';}resume(id){this.voices.get(id).state='playing';}releaseVoice(id){this.voices.delete(id);}deleteBuffer(id){this.buffers.delete(id);}setVolume(id,volume){this.voices.get(id).volume=volume;}
}
function wav(){const data=new Uint8Array(48),v=new DataView(data.buffer);data.set(new TextEncoder().encode('RIFF'));v.setUint32(4,40,true);data.set(new TextEncoder().encode('WAVEfmt '),8);v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,8000,true);v.setUint32(28,8000,true);v.setUint16(32,1,true);v.setUint16(34,8,true);data.set(new TextEncoder().encode('data'),36);v.setUint32(40,4,true);data.set([0,128,255,128],44);return data;}
test('decorated Miles imports parse PCM WAV, drive sample state and fire EOS callback',()=>{
  const audio=new Audio(),h=new Host({audio}),call=(name,...args)=>h.invoke('mss32.dll',`_${name}@${args.length*4}`,...args);
  assert.equal(call('AIL_startup'),1);const driver=call('AIL_open_digital_driver',8000,8,1,0),sample=call('AIL_allocate_sample_handle',driver);
  h.copyIn(128,wav());assert.equal(call('AIL_WAV_info',128,256),1);assert.equal(h.u32(260),172);assert.equal(h.u32(264),4);assert.equal(h.u32(268),8000);assert.equal(h.u32(280),4);
  assert.equal(call('AIL_set_named_sample_file',sample,0,128,48,0),1);call('AIL_set_sample_volume',sample,64);call('AIL_register_EOS_callback',sample,0x12345678);call('AIL_start_sample',sample);
  const s=h.handles.get(sample);assert.equal(call('AIL_sample_status',sample),4);assert.equal(audio.voices.get(s.voice).volume,64/127);assert.deepEqual([...audio.buffers.get(s.buffer).data],[0,128,255,128]);
  call('AIL_stop_sample',sample);assert.equal(call('AIL_sample_status',sample),8);call('AIL_resume_sample',sample);assert.equal(call('AIL_sample_status',sample),4);
  audio.voices.get(s.voice).state='ended';assert.equal(call('AIL_sample_status',sample),2);assert.deepEqual(h.callbackCalls,[{address:0x12345678,args:[sample]}]);call('AIL_sample_status',sample);assert.equal(h.callbackCalls.length,1);
  call('AIL_release_sample_handle',sample);assert.equal(audio.voices.size,0);assert.equal(audio.buffers.size,0);call('AIL_shutdown');
});
test('Miles rejects non-PCM WAV and unsupported codecs, never returns dummy success',async()=>{
  const h=new Host({audio:new Audio()}),call=(name,...args)=>h.invoke('mss32.dll',`_${name}@${args.length*4}`,...args);
  h.copyIn(128,wav());h.w16(148,0x55);assert.equal(call('AIL_WAV_info',128,256),0);assert.match(h.cstr(call('AIL_last_error')),/only 8\/16-bit/);
  assert.equal(call('AIL_enumerate_3D_providers',0,0,0),0);assert.throws(()=>call('AIL_open_stream',1,128,0),/invalid handle/);
  assert.equal(call('AIL_open_XMIDI_driver',1),0);assert.match(h.cstr(call('AIL_last_error')),/No XMIDI/);
  assert.equal(call('AIL_startup'),1);assert.ok(call('AIL_open_digital_driver',22050,16,2,0),'MIDI absence does not disable digital sound');
  const unavailable=new Host();assert.equal(unavailable.invoke('mss32.dll','_AIL_startup@0'),0);assert.equal(unavailable.invoke('wsock32.dll','#115',0x101,128),10091);
});

test('Miles software 3D provider drives spatial PCM, listener coordinates, Doppler and lifecycle',()=>{
  const audio=new Audio();
  audio.setSpatial=(id,spatial)=>audio.voices.get(id).spatial=spatial;
  audio.setListener=value=>audio.listener=value;
  audio.setPlaybackRate=(id,rate)=>audio.voices.get(id).playbackRate=rate;
  const h=new Host({audio}),call=(name,...args)=>h.invoke('mss32.dll',`_${name}@${args.length*4}`,...args),f=floatBits;
  call('AIL_startup');
  h.handle({kind:'unrelated'}); // The enumeration cursor is not a one-based ordinal.
  assert.equal(call('AIL_enumerate_3D_providers',128,132,136),1);
  const provider=h.u32(132);assert.equal(h.u32(128),provider);assert.equal(h.cstr(h.u32(136)),'Miles Fast 2D Positional Audio');
  assert.equal(call('AIL_enumerate_3D_providers',128,132,136),0);
  assert.equal(call('AIL_open_3D_provider',provider),0);
  const listener=call('AIL_open_3D_listener',provider),sample=call('AIL_allocate_3D_sample_handle',provider);
  call('AIL_set_3D_distance_factor',provider,f(.01));
  call('AIL_set_3D_position',listener,...[100,200,300].map(f));
  call('AIL_set_3D_orientation',listener,...[0,0,1,0,1,0].map(f));
  assert.ok(Math.abs(audio.listener.position[2]+3)<1e-6);assert.deepEqual(audio.listener.forward,[0,0,-1]);
  h.copyIn(256,wav());assert.equal(call('AIL_WAV_info',256,320),1);
  assert.equal(call('AIL_set_3D_sample_info',sample,320),1);
  call('AIL_set_3D_sample_distances',sample,f(1000),f(100));
  call('AIL_set_3D_position',sample,...[100,200,500].map(f));
  call('AIL_set_3D_sample_volume',sample,63);call('AIL_set_3D_sample_loop_count',sample,0);
  call('AIL_set_3D_sample_cone',sample,f(90),f(180),32);
  call('AIL_set_3D_user_data',sample,3,0xabcdef12);
  assert.equal(call('AIL_3D_user_data',sample,3),0xabcdef12);
  call('AIL_resume_3D_sample',sample);
  const s=h.handles.get(sample),voice=audio.voices.get(s.voice);
  assert.equal(call('AIL_3D_sample_status',sample),4);assert.equal(voice.volume,63/127);assert.equal(voice.loop,true);
  assert.ok(Math.abs(voice.spatial.position[2]+5)<1e-6);assert.ok(Math.abs(voice.spatial.refDistance-1)<1e-6);
  assert.ok(Math.abs(voice.spatial.distanceGain-Math.pow(10,-.3))<1e-7,'6 dB per doubling');
  call('AIL_set_3D_sample_distances',sample,f(100),f(1000));
  assert.equal(voice.spatial.distanceGain,1,'reversed distances disable attenuation');
  call('AIL_3D_sample_distances',sample,400,404);
  assert.equal(h.view.getFloat32(400,true),100);assert.equal(h.view.getFloat32(404,true),1000);
  call('AIL_set_3D_sample_distances',sample,f(-1),f(0));assert.equal(voice.spatial.distanceGain,1);
  call('AIL_set_3D_sample_distances',sample,f(200),f(100));
  call('AIL_set_3D_position',sample,...[100,200,2300].map(f));
  assert.ok(Math.abs(voice.spatial.distanceGain-Math.pow(10,-.3))<1e-7,'attenuation stops at maximum distance');
  call('AIL_set_3D_sample_distances',sample,f(1000),f(100));
  call('AIL_set_3D_position',sample,...[100,200,500].map(f));
  assert.equal(voice.spatial.coneInner,90);assert.equal(voice.spatial.coneGain,32/127);
  call('AIL_set_3D_velocity',sample,...[0,0,-1,.01].map(f));assert.ok(voice.playbackRate>1,'approaching source raises pitch');
  call('AIL_set_3D_sample_obstruction',sample,f(.5));assert.equal(voice.spatial.obstruction,.5);
  call('AIL_set_3D_sample_occlusion',sample,f(.25));assert.equal(voice.spatial.occlusion,.25);
  call('AIL_set_3D_sample_effects_level',sample,f(.2));call('AIL_set_3D_room_type',provider,2);
  assert.ok(Math.abs(voice.spatial.wet-.2)<1e-7);assert.equal(voice.spatial.decay,.4);
  assert.equal(call('AIL_set_3D_provider_preference',provider,h.string('EAX2 air absorption'),0),-1);
  call('AIL_stop_3D_sample',sample);assert.equal(call('AIL_3D_sample_status',sample),8);
  call('AIL_resume_3D_sample',sample);assert.equal(call('AIL_3D_sample_status',sample),4);
  assert.equal(call('AIL_3D_sample_length',sample),4);
  call('AIL_close_3D_provider',provider);
  assert.equal(audio.voices.size,0);assert.equal(audio.buffers.size,0);assert.equal(h.handles.has(sample),false);assert.equal(h.handles.has(listener),false);
  assert.equal(call('AIL_open_3D_provider',provider),0);call('AIL_open_3D_listener',provider);
  call('AIL_shutdown');assert.equal([...h.handles.values()].filter(v=>v.kind==='miles-listener'||v.kind==='miles-sample'||v.kind==='miles-driver').length,0);
});

test('Miles stream reads through guest file callbacks, tracks playback and releases decoded buffers',async()=>{
  const audio=new Audio(),data=wav(),seen=[];
  audio.createEncodedBuffer=bytes=>{assert.deepEqual(bytes,data);const id=audio.next++;audio.buffers.set(id,{duration:2,sampleRate:8000,numberOfChannels:1});return id;};
  audio.bufferInfo=(id,field)=>audio.buffers.get(id)[field];audio.setPan=(id,pan)=>audio.voices.get(id).pan=pan;
  const h=new Host({audio}),call=(name,...args)=>h.invoke('mss32.dll',`_${name}@${args.length*4}`,...args);
  h.call=(address,args)=>{seen.push({address,args});if(address===1){assert.equal(h.cstr(args[0]),'Sound\\Music.mp3');h.w32(args[1],99);return 1;}
    if(address===2)return 0;if(address===3)return args[2]===2?data.length:0;
    if(address===4){assert.equal(args[0],99);h.copyIn(args[1],data);return data.length;}
    assert.equal(address,5);return 0;};
  call('AIL_startup');const driver=call('AIL_open_digital_driver',8000,16,1,0);
  call('AIL_set_file_callbacks',1,2,3,4);
  const id=await call('AIL_open_stream',driver,h.string('Sound\\Music.mp3'),0),s=h.handles.get(id);
  assert.deepEqual(seen.map(c=>c.address),[1,3,3,4,2]);assert.equal(call('AIL_stream_status',id),2);
  call('AIL_set_stream_volume',id,63);call('AIL_set_stream_loop_count',id,0);call('AIL_start_stream',id);
  assert.equal(call('AIL_stream_status',id),4);assert.equal(audio.voices.get(s.voice).loop,true);
  audio.voices.get(s.voice).position=.5;call('AIL_stream_ms_position',id,128,132);assert.equal(h.u32(128),2000);assert.equal(h.u32(132),500);
  call('AIL_pause_stream',id,1);assert.equal(call('AIL_stream_status',id),8);call('AIL_pause_stream',id,0);assert.equal(call('AIL_stream_status',id),4);
  call('AIL_set_stream_pan',id,127);assert.equal(audio.voices.get(s.voice).pan,1);
  call('AIL_set_digital_master_volume',driver,64);assert.equal(audio.voices.get(s.voice).volume,63/127*64/127);
  call('AIL_register_stream_callback',id,5);audio.voices.get(s.voice).state='ended';assert.equal(call('AIL_stream_status',id),2);call('AIL_stream_status',id);
  assert.equal(seen.filter(c=>c.address===5).length,1);
  call('AIL_close_digital_driver',driver);assert.equal(audio.buffers.size,0);assert.equal(audio.voices.size,0);assert.equal(h.handles.has(id),false);
});

test('Miles music and ambience load on their own host thread; speech still loads in the call',async()=>{
  const audio=new Audio(),data=wav(),seen=[],decodes=[],gates=[],threads=[],tick=()=>new Promise(resolve=>setTimeout(resolve,0));
  const make=()=>{const id=audio.next++;audio.buffers.set(id,{duration:2,sampleRate:8000,numberOfChannels:1});return id;};
  audio.createEncodedBuffer=()=>{decodes.push('sync');return make();};
  audio.createEncodedBufferAsync=()=>new Promise(resolve=>decodes.push(()=>resolve(make())));
  audio.bufferInfo=(id,field)=>audio.buffers.get(id)[field];
  const logged=[],h=new Host({audio,log:line=>logged.push(line)}),call=(name,...args)=>h.invoke('mss32.dll',`_${name}@${args.length*4}`,...args);
  const missing='Sound\\Ambient\\Missing.wav';
  h.scheduler={stopped:false,
    create(){const item={cpu:0x7000+threads.length*0x100};threads.push(item);
      // The new thread waits in its host import: the loader first, then the service thread.
      const name=threads.length===1?'MilesStreamThread':'MilesServiceThread';setTimeout(()=>h.handlers.get('wc3host.dll!'+name).fn([0]),0);return item;},
    async call(cpu,address,args){
      seen.push({cpu,address,name:address===1?h.cstr(args[0]):null});
      if(address===1){if(h.cstr(args[0])===missing)return 0;h.w32(args[1],99);return 1;}
      if(address===3)return args[2]===2?data.length:0;
      if(address===4){await new Promise(resolve=>gates.push(resolve));h.copyIn(args[1],data);return data.length;}
      return 0;}};
  h.callAsync=(address,args,cpu)=>h.scheduler.call(cpu,address,args);
  const release=async()=>{while(!gates.length)await tick();gates.shift()();};
  call('AIL_startup');const driver=call('AIL_open_digital_driver',8000,16,1,0);call('AIL_set_file_callbacks',1,2,3,4);
  // Music: the game thread gets its stream at once and starts it while it loads.
  const name=h.string('Sound\\Music\\mp3Music\\Orc1.mp3'),id=call('AIL_open_stream',driver,name,0),s=h.handles.get(id);
  assert.equal(typeof id,'number');assert.equal(call('AIL_stream_status',id),2);
  h.copyIn(name,new TextEncoder().encode('Sound\\Overwritten.mp3\0'));
  call('AIL_set_stream_volume',id,63);call('AIL_pause_stream',id,0);assert.equal(call('AIL_stream_status',id),4);assert.equal(s.voice,null);
  call('AIL_pause_stream',id,1);assert.equal(call('AIL_stream_status',id),8);call('AIL_pause_stream',id,0);assert.equal(call('AIL_stream_status',id),4);
  await release();
  assert.equal(seen[0].name,'Sound\\Music\\mp3Music\\Orc1.mp3','the copy of the caller\'s string');assert.ok(seen.every(c=>c.cpu===threads[0].cpu),'on the loader thread');
  while(typeof decodes[0]!=='function')await tick();decodes.shift()();
  while(s.voice===null)await tick();
  assert.equal(call('AIL_stream_status',id),4);assert.equal(audio.voices.get(s.voice).volume,63/127);assert.equal(s.duration,2);
  // Closed while loading: nothing is kept.
  const buffers=audio.buffers.size,closed=call('AIL_open_stream',driver,h.string('Sound\\Music\\mp3Music\\Orc2.mp3'),0);
  call('AIL_close_stream',closed);
  // A track that cannot be opened ends, so the game moves on to the next one.
  const gone=call('AIL_open_stream',driver,h.string(missing),0);call('AIL_register_stream_callback',gone,5);call('AIL_start_stream',gone);
  while(!seen.some(c=>c.address===5))await tick();
  assert.equal(call('AIL_stream_status',gone),2);assert.equal(seen.find(c=>c.address===5).cpu,threads[1].cpu,'delivered by the service thread');
  assert.deepEqual(logged,['Audio stream Sound\\Ambient\\Missing.wav: Unable to open audio file: Sound\\Ambient\\Missing.wav']);
  assert.equal(audio.buffers.size,buffers);assert.equal(h.handles.has(closed),false);assert.equal(decodes.length,0);
  // Speech stays with the calling thread and is decoded in the call.
  h.currentCPU=0x1000;
  const speech=call('AIL_open_stream',driver,h.string('Sound\\Dialogue\\Orc01.mp3'),0);assert.equal(typeof speech.then,'function');
  await release();const speechId=await speech;
  assert.equal(seen.filter(c=>c.cpu===0x1000).length,5);assert.deepEqual(decodes,['sync']);assert.equal(h.handles.get(speechId).duration,2);
});
