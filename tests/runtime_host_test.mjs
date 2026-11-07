import test from 'node:test';
import assert from 'node:assert/strict';
import {VirtualWinsock,WSA,WSAError,peerAddress,addressPeer} from '../web/runtime/winsock.mjs';
import {FixedFunctionGL,GL,GraphicsError,mat4Identity,mat4Multiply,transformVertex} from '../web/runtime/graphics.mjs';
import {PCMPlayer,decodePCM,AudioHostError} from '../web/runtime/audio.mjs';

const emit=(target,type,detail)=>{const event=new Event(type);Object.defineProperty(event,'detail',{value:detail});target.dispatchEvent(event);};
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const wsa=(code)=>error=>error instanceof WSAError&&error.code===code;
class Room {
  constructor(){this.peers=new Map();this.frames=[];}
  peer(id){const transport=new EventTarget();transport.peerId=id;transport.send=(destination,data)=>{
    this.frames.push({source:id,destination,data:data.slice()});
    for(const [peer,other] of this.peers)if(peer!==id&&(destination===0||destination===peer))queueMicrotask(()=>emit(other,'packet',{source:id,data:data.slice()}));
  };this.peers.set(id,transport);return transport;}
}
const network=(options={})=>{const room=new Room();return {room,a:new VirtualWinsock(room.peer(1),options),b:new VirtualWinsock(room.peer(2),options),c:new VirtualWinsock(room.peer(3),options)};};
async function tcpPair(net,port=6112){const listener=net.b.socket('tcp');net.b.bind(listener,{port});net.b.listen(listener);const client=net.a.socket('tcp');assert.throws(()=>net.a.connect(client,{address:peerAddress(2),port}),wsa(WSA.EWOULDBLOCK));await settle();const accepted=net.b.accept(listener);return{listener,client,server:accepted.socket};}

test('a room is one virtual /24 LAN: 200-player lobbies fit, .255 broadcasts',()=>{
  assert.equal(peerAddress(200),'10.77.0.200');assert.equal(addressPeer('10.77.0.200'),200);assert.equal(peerAddress(254),'10.77.0.254');
  assert.equal(addressPeer('10.77.0.255'),0);assert.equal(addressPeer('255.255.255.255'),0);
  assert.throws(()=>peerAddress(255),wsa(WSA.EADDRNOTAVAIL));assert.throws(()=>peerAddress(0),wsa(WSA.EADDRNOTAVAIL));
  assert.throws(()=>addressPeer('10.77.1.5'),wsa(WSA.ENETUNREACH));
});

test('UDP carries binary bytes and correct source port, isolates ports and rooms',async()=>{
  const net=network(),source=net.a.socket('udp'),receiver=net.b.socket('udp'),wrongPort=net.b.socket('udp');
  net.a.bind(source,{port:6112});net.b.bind(receiver,{port:6112});net.b.bind(wrongPort,{port:6113});
  const other=new VirtualWinsock(new Room().peer(2));const otherSocket=other.socket('udp');other.bind(otherSocket,{port:6112});
  assert.equal(net.a.sendto(source,new Uint8Array([0,255,128,1]),{address:peerAddress(2),port:6112}),4);
  await settle();assert.deepEqual(net.b.select({read:[receiver,wrongPort]}).read,[receiver]);
  const datagram=net.b.recvfrom(receiver,4);assert.deepEqual([...datagram.data],[0,255,128,1]);assert.equal(datagram.address,peerAddress(1));assert.equal(datagram.port,6112);
  assert.throws(()=>net.b.recvfrom(wrongPort,99),wsa(WSA.EWOULDBLOCK));assert.throws(()=>other.recvfrom(otherSocket,99),wsa(WSA.EWOULDBLOCK));
  net.a.destroy();net.b.destroy();net.c.destroy();other.destroy();
});

test('UDP broadcast requires permission and reaches peers; connected UDP filters sender',async()=>{
  const net=network(),s=net.a.socket('udp'),r=net.b.socket('udp'),third=net.c.socket('udp');
  net.a.bind(s,{port:6112});net.b.bind(r,{port:6112});net.c.bind(third,{port:6112});
  assert.throws(()=>net.a.sendto(s,new Uint8Array([8]),{address:'255.255.255.255',port:6112}),wsa(WSA.EOPNOTSUPP));
  net.a.setsockopt(s,'SO_BROADCAST',true);net.a.sendto(s,new Uint8Array([8]),{address:'255.255.255.255',port:6112});await settle();
  assert.equal(net.b.recvfrom(r,1).data[0],8);assert.equal(net.c.recvfrom(third,1).data[0],8);net.a.recvfrom(s,1);
  net.b.connect(r,{address:peerAddress(1),port:6112});net.c.sendto(third,new Uint8Array([3]),{address:peerAddress(2),port:6112});await settle();
  assert.throws(()=>net.b.recv(r,1),wsa(WSA.EWOULDBLOCK));
  net.a.sendto(s,new Uint8Array(),{address:peerAddress(2),port:6112});await settle();assert.equal(net.b.recv(r,0).length,0);
  net.a.destroy();net.b.destroy();net.c.destroy();
});

test('TCP handshake, accept, bidirectional stream fragmentation and peek',async()=>{
  const net=network(),{listener,client,server}=await tcpPair(net);
  assert.throws(()=>net.b.accept(listener),wsa(WSA.EWOULDBLOCK));
  assert.deepEqual(net.a.select({write:[client]}).write,[client]);
  const data=Uint8Array.from({length:150000},(_,i)=>(i*37)%256);
  assert.equal(net.a.send(client,data),data.length);await settle();
  assert.deepEqual(net.b.recv(server,5,2),data.slice(0,5));
  assert.deepEqual(net.b.recv(server,120),data.slice(0,120));
  assert.deepEqual(net.b.recv(server,200000),data.slice(120));
  assert.throws(()=>net.b.recv(server,1),wsa(WSA.EWOULDBLOCK));
  net.b.send(server,new Uint8Array([4,0,2]));await settle();assert.deepEqual([...net.a.recv(client,9)],[4,0,2]);
  net.a.shutdown(client,1);await settle();assert.equal(net.b.recv(server,1).length,0);
  assert.throws(()=>net.a.send(client,new Uint8Array([1])),wsa(WSA.ESHUTDOWN));
  net.b.send(server,new Uint8Array([7]));await settle();assert.equal(net.a.recv(client,1)[0],7);
  const frame=net.room.frames.find(x=>x.data[4]===5),view=new DataView(frame.data.buffer);
  assert.equal(view.getUint32(0,true),0x31535743);assert.equal(view.getUint16(8,true),6112);assert.equal(view.getUint16(10,true),frame.data.length-16);
  net.a.destroy();net.b.destroy();net.c.destroy();
});

test('TCP refuses unbound ports and exposes SO_ERROR readiness',async()=>{
  const net=network(),fd=net.a.socket('tcp');
  assert.throws(()=>net.a.connect(fd,{address:peerAddress(2),port:6112}),wsa(WSA.EWOULDBLOCK));await settle();
  assert.deepEqual(net.a.select({except:[fd]}).except,[fd]);assert.equal(net.a.getError(fd),WSA.ECONNREFUSED);assert.equal(net.a.getError(fd),0);
  assert.throws(()=>net.a.send(fd,new Uint8Array([1])),wsa(WSA.ENOTCONN));net.a.destroy();net.b.destroy();net.c.destroy();
});

test('TCP receive queue overflow resets sender, never silently drops stream bytes',async()=>{
  const net=network({maxQueuedBytes:4}),{client,server}=await tcpPair(net);
  net.a.send(client,new Uint8Array([1,2,3,4,5]));await settle();
  assert.throws(()=>net.b.recv(server,5),wsa(WSA.ENOBUFS));assert.throws(()=>net.a.send(client,new Uint8Array([1])),wsa(WSA.ECONNRESET));
  net.a.destroy();net.b.destroy();net.c.destroy();
});

test('invalid virtual addresses, duplicate binds, handles and malformed frames fail safely',async()=>{
  const net=network(),fd=net.a.socket('udp');net.a.bind(fd,{port:6112});
  assert.throws(()=>net.a.bind(net.a.socket('udp'),{port:6112}),wsa(WSA.EADDRINUSE));
  assert.throws(()=>addressPeer('8.8.8.8'),wsa(WSA.ENETUNREACH));assert.throws(()=>net.a.recv(99999,1),wsa(WSA.ENOTSOCK));
  emit(net.a.transport,'packet',{source:2,data:new Uint8Array(16)});assert.throws(()=>net.a.recv(fd,1),wsa(WSA.EWOULDBLOCK));
  emit(net.a.transport,'disconnect');assert.throws(()=>net.a.sendto(fd,new Uint8Array([1]),{address:peerAddress(2),port:6112}),wsa(WSA.ENETDOWN));
  net.a.destroy();net.b.destroy();net.c.destroy();
});

test('TCP connection timeouts and transport backpressure report nonblocking readiness',()=>{
  let now=100;const transport=new Room().peer(1),host=new VirtualWinsock(transport,{now:()=>now,connectTimeout:50});
  const tcp=host.socket('tcp');assert.throws(()=>host.connect(tcp,{address:peerAddress(2),port:6112}),wsa(WSA.EWOULDBLOCK));
  now=151;assert.deepEqual(host.select({except:[tcp]}).except,[tcp]);assert.equal(host.getError(tcp),WSA.ETIMEDOUT);
  const udp=host.socket('udp');transport.socket={bufferedAmount:5*1024*1024};
  assert.deepEqual(host.select({write:[udp]}).write,[]);assert.throws(()=>host.sendto(udp,new Uint8Array([1]),{address:peerAddress(2),port:6112}),wsa(WSA.EWOULDBLOCK));
  transport.socket.bufferedAmount=0;assert.deepEqual(host.select({write:[udp]}).write,[udp]);host.destroy();
});

function mathRenderer(){const renderer=Object.create(FixedFunctionGL.prototype);renderer.mode=GL.MODELVIEW;renderer.matrices=new Map([[GL.MODELVIEW,[mat4Identity()]],[GL.PROJECTION,[mat4Identity()]],[GL.TEXTURE,[mat4Identity()]]]);return renderer;}
const approx=(actual,expected)=>{assert.equal(actual.length,expected.length);actual.forEach((value,index)=>assert.ok(Math.abs(value-expected[index])<1e-5,`${value} != ${expected[index]}`));};
test('OpenGL column-major postmultiplication, rotation and matrix stack',()=>{
  const renderer=mathRenderer();renderer.translate(10,20,30);renderer.scale(2,3,4);
  approx(transformVertex(renderer._matrix(),[1,1,1,1]),[12,23,34,1]);
  renderer.pushMatrix();renderer.loadIdentity();renderer.rotate(90,0,0,1);approx(transformVertex(renderer._matrix(),[1,0,0,1]),[0,1,0,1]);
  renderer.popMatrix();approx(transformVertex(renderer._matrix(),[1,1,1,1]),[12,23,34,1]);assert.throws(()=>renderer.popMatrix(),GraphicsError);
  approx(mat4Multiply(mat4Identity(),renderer._matrix()),renderer._matrix());
});
test('orthographic and perspective matrices map clipping volume correctly',()=>{
  const renderer=mathRenderer();renderer.ortho(-2,2,-4,4,1,9);approx(transformVertex(renderer._matrix(),[-2,-4,-1,1]),[-1,-1,-1,1]);approx(transformVertex(renderer._matrix(),[2,4,-9,1]),[1,1,1,1]);
  renderer.loadIdentity();renderer.frustum(-1,1,-1,1,1,10);const near=transformVertex(renderer._matrix(),[1,1,-1,1]);approx(near,[1,1,-1,1]);
  const far=transformVertex(renderer._matrix(),[0,0,-10,1]);approx(far,[0,0,10,10]);assert.throws(()=>renderer.frustum(0,0,-1,1,1,9),GraphicsError);
});
test('texture pixel conversion respects RGB row alignment and BGRA order',()=>{
  const renderer=mathRenderer();renderer.unpackAlignment=4;
  assert.deepEqual([...renderer._pixels(1,2,GL.RGB,GL.UNSIGNED_BYTE,new Uint8Array([1,2,3,99,4,5,6]))],[1,2,3,255,4,5,6,255]);
  assert.deepEqual([...renderer._pixels(1,1,GL.BGRA,GL.UNSIGNED_BYTE,new Uint8Array([3,2,1,9]))],[1,2,3,9]);
  assert.throws(()=>renderer._pixels(2,2,GL.RGBA,GL.UNSIGNED_BYTE,new Uint8Array(3)),GraphicsError);
});
test('texture unpack reads a subrectangle with row length, skips and padding',()=>{
  const renderer=mathRenderer();renderer.unpackAlignment=4;
  renderer.pixelStorei(0x0cf2,3);renderer.pixelStorei(0x0cf3,1);renderer.pixelStorei(0x0cf4,1);
  const bytes=new Uint8Array(30);bytes.set([1,2,3],15);bytes.set([4,5,6],27);
  assert.equal(renderer.pixelLayout(1,2,GL.RGB,GL.UNSIGNED_BYTE).required,30);
  assert.deepEqual([...renderer._pixels(1,2,GL.RGB,GL.UNSIGNED_BYTE,bytes)],[1,2,3,255,4,5,6,255]);
  assert.throws(()=>renderer._pixels(1,2,GL.RGB,GL.UNSIGNED_BYTE,bytes.subarray(0,29)),/need 30/);
  assert.throws(()=>renderer.pixelStorei(0x0cf2,-1),/nonnegative/);
});

class FakeAudioContext {
  constructor(){this.state='running';this.currentTime=0;this.destination={};this.sources=[];}
  createBuffer(channels,length,sampleRate){const data=Array.from({length:channels},()=>new Float32Array(length));return{duration:length/sampleRate,getChannelData:index=>data[index]};}
  createBufferSource(){const source={onended:null,connect(){},disconnect(){},start(when,offset){this.offset=offset;},stop(){this.stopped=true;}};this.sources.push(source);return source;}
  createGain(){return{gain:{value:1,setValueAtTime(value){this.value=value;}},connect(){},disconnect(){}};}
  async resume(){this.state='running';}
  async close(){this.state='closed';}
}
test('PCM decodes stereo s16le and unsigned PCM exactly',()=>{
  const pcm=decodePCM({data:new Uint8Array([0,128,255,127,0,0,0,64]),format:'s16le',channels:2,sampleRate:8000});
  approx(pcm.samples[0],[-1,0]);approx(pcm.samples[1],[32767/32768,0.5]);assert.equal(pcm.frames,2);
  approx(decodePCM({data:new Uint8Array([0,128,255]),format:'u8',channels:1,sampleRate:8000}).samples[0],[-1,0,127/128]);
  assert.throws(()=>decodePCM({data:new Uint8Array(3),format:'s16le',channels:2,sampleRate:8000}),AudioHostError);
  assert.throws(()=>decodePCM({data:new Uint8Array([0,0,192,127]),format:'f32le',channels:1,sampleRate:8000}),AudioHostError);
});
test('audio pause/resume retains playhead and loop position; stop disconnects sources',async()=>{
  const context=new FakeAudioContext(),player=new PCMPlayer({context});
  const buffer=player.createBuffer({data:new Uint8Array(8000).fill(128),format:'u8',channels:1,sampleRate:8000});
  const voice=player.play(buffer,{volume:0.5});context.currentTime=0.125;assert.equal(player.pause(voice),0.125);assert.equal(context.sources[0].stopped,true);
  context.currentTime=2;player.resume(voice);assert.equal(context.sources[1].offset,0.125);context.currentTime=2.125;assert.equal(player.getPosition(voice),0.25);
  player.setVolume(voice,0.25);assert.equal(player._voice(voice).gain.gain.value,0.25);player.stop(voice);assert.equal(player.getState(voice),'stopped');assert.equal(player.getPosition(voice),0);
  const looping=player.play(buffer,{loop:true});context.currentTime+=2.5;assert.equal(player.getPosition(looping),0.5);
  await player.destroy();assert.equal(context.state,'running');assert.throws(()=>player.createBuffer({data:new Uint8Array([128]),format:'u8',channels:1,sampleRate:8000}),AudioHostError);
});
test('audio refuses playback before browser unlock instead of reporting silence as success',async()=>{
  const context=new FakeAudioContext();context.state='suspended';const player=new PCMPlayer({context});const buffer=player.createBuffer({data:new Uint8Array([128]),format:'u8',channels:1,sampleRate:8000});
  assert.throws(()=>player.play(buffer),/unlocked/);await player.unlock();player.play(buffer);await player.destroy();
});
